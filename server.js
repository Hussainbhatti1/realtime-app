// server.js
require('dotenv').config();
const express = require('express');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const {
  getPool,
  testConnection,
  ensureSchema,
  saveMessage,
  listMessages,
  deleteMessage,
  listImages,
  deleteImage,
} = require('./db');
const http = require('http');
const socketio = require('socket.io');
const fs = require('fs');

const isAzure = process.env.WEBSITE_SITE_NAME !== undefined;
const PORT = process.env.PORT ? Number(process.env.PORT) : (isAzure ? 8080 : 3000);
const VIEWS_DIR = path.join(__dirname, 'views');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Writable uploads dir: /home on Azure, ./uploads locally
const UPLOAD_DIR = process.env.UPLOAD_DIR ||
  (isAzure ? '/home/data/uploads' : path.join(__dirname, 'uploads'));

// Only ever create directories under /home when on Azure (wwwroot is read-only)
const ensureDir = (dir) => {
  try {
    if (isAzure && !dir.startsWith('/home')) return;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    console.warn('Directory init skipped:', dir, e.message);
  }
};
ensureDir(UPLOAD_DIR);

const app = express();
const server = http.createServer(app);
const io = socketio(server, {
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000
});

// ---------- Middleware ----------
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

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
app.use(sessionMiddleware);

// Simple login guard for APIs
const requireLogin = (req, res, next) => {
  if (!req.session?.user) return res.status(401).json({ ok: false, error: 'auth-required' });
  next();
};

// Static file serving (read-only)
if (fs.existsSync(PUBLIC_DIR)) app.use(express.static(PUBLIC_DIR));
app.use('/uploads', express.static(UPLOAD_DIR));

// Serve HTML files from /views
const serveView = (viewName) => (req, res) => {
  const viewPath = path.join(VIEWS_DIR, `${viewName}.html`);
  if (!fs.existsSync(viewPath)) {
    console.error('View not found:', viewPath);
    return res.status(404).send(`<h1>Missing: ${viewName}.html</h1><p>Looked in: ${viewPath}</p>`);
  }
  res.sendFile(viewPath);
};

// ---------- Page routes ----------
app.get('/', (req, res) => (req.session.user ? serveView('chat')(req, res) : res.redirect('/login')));
app.get('/login', (req, res) => (req.session.user ? res.redirect('/') : serveView('login')(req, res)));
app.get('/register', (req, res) => (req.session.user ? res.redirect('/') : serveView('register')(req, res)));
app.get('/logout', (req, res) => { req.session.destroy(() => res.redirect('/login')); });

// Health proves DB connectivity too
app.get('/health', async (_req, res) => {
  try {
    const ok = await testConnection();
    if (!ok) return res.status(500).json({ status: 'db-failed' });
    res.status(200).json({ status: 'ok', uploadsDir: UPLOAD_DIR });
  } catch {
    res.status(500).json({ status: 'db-failed' });
  }
});

// ---------- Auth POST routes ----------
app.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).send('Username & password required');
    const hashed = await bcrypt.hash(password, 10);
    const pool = await getPool();
    await pool.request()
      .input('username', username)
      .input('password', hashed)
      .query('INSERT INTO dbo.Users (username, password) VALUES (@username, @password)');
    res.redirect('/login');
  } catch (e) {
    console.error('Registration error:', e);
    res.status(500).send('Registration failed');
  }
});

app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).send('Username & password required');
    const pool = await getPool();
    const result = await pool.request()
      .input('username', username)
      .query('SELECT TOP 1 * FROM dbo.Users WHERE username = @username');
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

// ---------- Messages API (private to user) ----------
app.get('/api/messages', requireLogin, async (req, res) => {
  try {
    const rows = await listMessages(req.session.user, 100);
    res.json({ ok: true, data: rows });
  } catch (e) {
    console.error('GET /api/messages failed:', e);
    res.status(500).json({ ok: false, error: 'Failed to load messages' });
  }
});

app.post('/api/messages', requireLogin, async (req, res) => {
  try {
    const { body } = req.body || {};
    if (!body || !body.trim()) {
      return res.status(400).json({ ok: false, error: 'Message body required' });
    }
    const saved = await saveMessage(req.session.user, body.trim());
    // Private echo only to this user; not broadcasting to others
    res.json({ ok: true, data: saved });
  } catch (e) {
    console.error('POST /api/messages failed:', e);
    res.status(500).json({ ok: false, error: 'Failed to save message' });
  }
});

app.delete('/api/messages/:id', requireLogin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'Invalid id' });
    const affected = await deleteMessage(id, req.session.user);
    res.json({ ok: affected > 0, affected });
  } catch (e) {
    console.error('DELETE /api/messages failed:', e);
    res.status(500).json({ ok: false, error: 'Failed to delete message' });
  }
});

// ---------- File upload ----------
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, `image-${uniqueSuffix}${ext}`);
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

app.post('/upload', requireLogin, upload.single('image'), async (req, res) => {
  try {
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
        IF NOT EXISTS (
          SELECT 1 FROM sys.tables t JOIN sys.schemas s ON t.schema_id = s.schema_id
          WHERE s.name = 'dbo' AND t.name = 'Images'
        )
        BEGIN
          CREATE TABLE dbo.Images (
            Id INT IDENTITY(1,1) PRIMARY KEY,
            filename NVARCHAR(400) NOT NULL,
            originalname NVARCHAR(400) NOT NULL,
            username NVARCHAR(200) NOT NULL,
            path NVARCHAR(1000) NOT NULL,
            size BIGINT NOT NULL,
            mimetype NVARCHAR(200) NOT NULL,
            CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
          );
        END;

        INSERT INTO dbo.Images (filename, originalname, username, path, size, mimetype)
        VALUES (@filename, @originalname, @username, @path, @size, @mimetype);
      `);

    // respond JSON (no navigation)
    res.json({
      success: true,
      file: {
        idHint: null, // we don't have the id from the INSERT here
        filename: req.file.filename,
        url: `/uploads/${req.file.filename}`
      }
    });
  } catch (e) {
    console.error('Upload error:', e);
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    res.status(500).json({ success: false, message: 'Upload failed' });
  }
});

// List images for current user
app.get('/api/images', requireLogin, async (req, res) => {
  try {
    const rows = await listImages(req.session.user, 200);
    // map DB row path to a public URL
    const data = rows.map(r => ({
      Id: r.Id,
      filename: r.filename,
      url: `/uploads/${r.filename}`,
      CreatedAt: r.CreatedAt,
      size: r.size,
      mimetype: r.mimetype
    }));
    res.json({ ok: true, data });
  } catch (e) {
    console.error('GET /api/images failed:', e);
    res.status(500).json({ ok: false, error: 'Failed to load images' });
  }
});

// Delete one image (owned by current user)
app.delete('/api/images/:id', requireLogin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'Invalid id' });
    const { affected, path: filePath } = await deleteImage(id, req.session.user);
    if (affected > 0 && filePath) {
      // extra safety: ensure we only delete inside UPLOAD_DIR
      const abs = path.resolve(filePath);
      if (abs.startsWith(path.resolve(UPLOAD_DIR))) {
        fs.unlink(abs, () => {});
      }
    }
    res.json({ ok: affected > 0, affected });
  } catch (e) {
    console.error('DELETE /api/images failed:', e);
    res.status(500).json({ ok: false, error: 'Failed to delete image' });
  }
});

// ---------- Socket.IO with sessions (kept for future use) ----------
const wrap = (mw) => (socket, next) => mw(socket.request, {}, next);
io.use(wrap(sessionMiddleware));

io.on('connection', (socket) => {
  const user = socket.request.session?.user;
  if (!user) return socket.disconnect(true);
  socket.user = user;
  // We are not broadcasting; API returns JSON and client updates UI.
});

// ---------- Start ----------
async function start() {
  try {
    const ok = await testConnection();
    if (!ok && !isAzure) throw new Error('Database connection failed');
    await ensureSchema();
    console.log('✅ Schema ready');

    server.listen(PORT, () => {
      console.log(`🚀 Server on ${PORT}`);
      console.log(`ENV: isAzure=${isAzure}  uploads=${UPLOAD_DIR}`);
      if (isAzure && process.env.WEBSITE_HOSTNAME) {
        console.log(`🌐 https://${process.env.WEBSITE_HOSTNAME}`);
      }
    });
  } catch (e) {
    console.error('💥 Fatal init error:', e);
    process.exit(1);
  }
}

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('unhandledRejection', (e) => console.error('UnhandledRejection', e));
process.on('uncaughtException', (e) => console.error('UncaughtException', e));

start();
