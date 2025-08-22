require('dotenv').config();
const express = require('express');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { getPool, testConnection } = require('./db');
const http = require('http');
const socketio = require('socket.io');
const fs = require('fs');
const ensureDir = (dir) => {
  try {
    // On Azure, wwwroot is read-only; only create under /home
    if (isAzure && !dir.startsWith('/home')) return;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    console.warn('Directory init skipped:', dir, e.message);
  }
};

const isAzure = process.env.WEBSITE_SITE_NAME !== undefined;
const PORT = process.env.PORT ? Number(process.env.PORT) : (isAzure ? 8080 : 3000);
const VIEWS_DIR = path.join(__dirname, 'views');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ✅ Persist uploads on Linux App Service (/home is writable)
// (site/wwwroot can be read-only when run-from-package)
const UPLOAD_DIR = process.env.UPLOAD_DIR ||
  (isAzure ? '/home/data/uploads' : path.join(__dirname, 'uploads'));

const app = express();
const server = http.createServer(app);
const io = socketio(server, {
  transports: ['websocket'],
  pingTimeout: 60000,
  pingInterval: 25000
});

// Ensure directories exist
ensureDir(UPLOAD_DIR);

// File upload config
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'image-' + uniqueSuffix + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.originalname.match(/\.(jpg|jpeg|png|gif)$/i)) {
      return cb(new Error('Only image files are allowed!'), false);
    }
    cb(null, true);
  }
});

// Sessions
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: true,
  cookie: {
    secure: isAzure,
    httpOnly: true,
    sameSite: 'strict',
    maxAge: 24 * 60 * 60 * 1000
  },
  proxy: isAzure
});

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set('trust proxy', 1);
app.use(sessionMiddleware);

// Static
app.use(express.static(PUBLIC_DIR));
app.use('/uploads', express.static(UPLOAD_DIR));

// Helpers
const serveView = (viewName) => (req, res) => {
  const viewPath = path.join(VIEWS_DIR, `${viewName}.html`);
  if (!fs.existsSync(viewPath)) {
    return res.status(404).send(`<h1>Missing: ${viewName}.html</h1>`);
  }
  res.sendFile(viewPath);
};

// Routes
app.get('/', (req, res) => (req.session.user ? serveView('chat')(req, res) : res.redirect('/login')));
app.get('/login', (req, res) => (req.session.user ? res.redirect('/') : serveView('login')(req, res)));
app.get('/register', (req, res) => (req.session.user ? res.redirect('/') : serveView('register')(req, res)));
app.get('/logout', (req, res) => { req.session.destroy(() => res.redirect('/login')); });

// ✅ Health now proves DB connectivity too
app.get('/health', async (_req, res) => {
  try {
    const ok = await testConnection();
    if (!ok) return res.status(500).json({ status: 'db-failed' });
    res.status(200).json({ status: 'ok', uploadsDir: UPLOAD_DIR });
  } catch {
    res.status(500).json({ status: 'db-failed' });
  }
});

// Auth
app.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    const hashed = await bcrypt.hash(password, 10);
    const pool = await getPool();
    await pool.request()
      .input('username', username)
      .input('password', hashed)
      .query('INSERT INTO Users (username, password) VALUES (@username, @password)');
    res.redirect('/login');
  } catch (e) {
    console.error('Registration error:', e);
    res.status(500).send('Registration failed');
  }
});

app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const pool = await getPool();
    const result = await pool.request().input('username', username)
      .query('SELECT * FROM Users WHERE username = @username');
    const user = result.recordset[0];
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).send('Invalid username or password');
    }
    req.session.user = username;
    res.redirect('/');
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).send('Login failed');
  }
});

// Upload
app.post('/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.session.user) return res.status(401).json({ success: false, message: 'Please login first' });
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });

    const pool = await getPool();
    await pool.request()
      .input('filename', req.file.filename)
      .input('originalname', req.file.originalname)
      .input('username', req.session.user)
      .input('path', req.file.path)
      .input('size', req.file.size)
      .input('mimetype', req.file.mimetype)
      .query(`
        INSERT INTO Images (filename, originalname, username, path, size, mimetype)
        VALUES (@filename, @originalname, @username, @path, @size, @mimetype)
      `);

    res.json({ success: true, file: { filename: req.file.filename, path: `/uploads/${req.file.filename}` } });
  } catch (e) {
    console.error('Upload error:', e);
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    res.status(500).json({ success: false, message: 'Upload failed' });
  }
});

// Socket.IO
const wrap = (mw) => (socket, next) => mw(socket.request, {}, next);
io.use(wrap(sessionMiddleware));

io.on('connection', (socket) => {
  if (!socket.request.session?.user) return socket.disconnect(true);
  socket.user = socket.request.session.user;
  socket.on('message', async (msg) => {
    try {
      if (typeof msg !== 'string' || !msg.trim()) return;
      const pool = await getPool();
      await pool.request().input('message', msg.trim()).input('username', socket.user)
        .query('INSERT INTO Messages (content, username) VALUES (@message, @username)');
      io.emit('message', { user: socket.user, text: msg.trim(), timestamp: new Date().toISOString() });
    } catch (e) {
      console.error('Message save error:', e);
      socket.emit('error', 'Failed to send message');
    }
  });
});

async function start() {
  try {
    // Try DB (with retries handled inside testConnection/getPool)
    const ok = await testConnection();
    if (!ok && !isAzure) throw new Error('Database connection failed');

    server.listen(PORT, () => {
      console.log(`🚀 Server on ${PORT}`);
      if (isAzure && process.env.WEBSITE_HOSTNAME) console.log(`🌐 https://${process.env.WEBSITE_HOSTNAME}`);
    });
  } catch (e) {
    console.error('💥 Fatal init error:', e);
    process.exit(1);
  }
}

process.on('SIGTERM', () => server.close(() => process.exit(0)));
start();
