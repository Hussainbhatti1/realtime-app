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

// Configuration
const isAzure = process.env.WEBSITE_SITE_NAME !== undefined;
const PORT = isAzure ? process.env.PORT || 80 : process.env.PORT || 3000;
const VIEWS_DIR = path.join(__dirname, 'views');
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = isAzure ? path.join(process.env.HOME, 'site', 'wwwroot', 'uploads') : path.join(__dirname, 'uploads');

// Initialize app
const app = express();
const server = http.createServer(app);
const io = socketio(server, {
  transports: ['websocket'],
  pingTimeout: 60000,
  pingInterval: 25000
});

// Ensure directories exist
[VIEWS_DIR, PUBLIC_DIR, UPLOAD_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// File upload configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + ext);
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.originalname.match(/\.(jpg|jpeg|png|gif)$/i)) {
      return cb(new Error('Only image files are allowed!'), false);
    }
    cb(null, true);
  }
});

// Session configuration
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
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

// Static file serving
app.use(express.static(PUBLIC_DIR));
app.use('/uploads', express.static(UPLOAD_DIR));

// View routes with existence checking
const serveView = (viewName) => (req, res) => {
  const viewPath = path.join(VIEWS_DIR, `${viewName}.html`);
  
  if (!fs.existsSync(viewPath)) {
    console.error(`View not found: ${viewPath}`);
    return res.status(404).send(`
      <h1>Page Not Found</h1>
      <p>The requested page (${viewName}.html) doesn't exist.</p>
      <p>Please check the views directory.</p>
    `);
  }

  res.sendFile(viewPath, {
    headers: { 'Content-Type': 'text/html' }
  });
};

// Routes
app.get('/', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  serveView('chat')(req, res);
});

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  serveView('login')(req, res);
});

app.get('/register', (req, res) => {
  if (req.session.user) return res.redirect('/');
  serveView('register')(req, res);
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy',
    views: fs.existsSync(VIEWS_DIR),
    public: fs.existsSync(PUBLIC_DIR),
    uploads: fs.existsSync(UPLOAD_DIR)
  });
});

// Authentication Routes
app.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    const pool = await getPool();
    
    await pool.request()
      .input('username', username)
      .input('password', hashedPassword)
      .query('INSERT INTO Users (username, password) VALUES (@username, @password)');
    
    res.redirect('/login');
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).send('Registration failed');
  }
});

app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const pool = await getPool();
    
    const result = await pool.request()
      .input('username', username)
      .query('SELECT * FROM Users WHERE username = @username');
    
    if (result.recordset.length === 0) {
      return res.status(401).send('Invalid username or password');
    }
    
    const user = result.recordset[0];
    const passwordMatch = await bcrypt.compare(password, user.password);
    
    if (passwordMatch) {
      req.session.user = username;
      return res.redirect('/');
    }
    
    res.status(401).send('Invalid username or password');
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).send('Login failed');
  }
});

// File Upload Route
app.post('/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.session.user) {
      return res.status(401).json({ success: false, message: 'Please login first' });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    const pool = await getPool();
    
    try {
      await pool.request()
        .input('filename', req.file.filename)
        .input('originalname', req.file.originalname)
        .input('username', req.session.user)
        .input('path', req.file.path)
        .input('size', req.file.size)
        .input('mimetype', req.file.mimetype)
        .query(`
          INSERT INTO Images 
          (filename, originalname, username, path, size, mimetype) 
          VALUES (@filename, @originalname, @username, @path, @size, @mimetype)
        `);
    } catch (err) {
      if (err.message.includes('Invalid column name')) {
        await pool.request()
          .input('filename', req.file.filename)
          .input('username', req.session.user)
          .query('INSERT INTO Images (filename, username) VALUES (@filename, @username)');
      } else {
        throw err;
      }
    }

    res.json({ 
      success: true,
      message: 'File uploaded successfully',
      file: {
        filename: req.file.filename,
        path: `/uploads/${req.file.filename}`
      }
    });
  } catch (error) {
    console.error('Upload error:', error);
    if (req.file?.path) {
      fs.unlink(req.file.path, () => {});
    }
    res.status(500).json({ 
      success: false, 
      message: 'Upload failed',
      error: error.message 
    });
  }
});

// Error Handling
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send(`
    <h1>Server Error</h1>
    <pre>${err.message}</pre>
    <p>Check server logs for details.</p>
  `);
});

// Socket.IO setup
const wrap = middleware => (socket, next) => middleware(socket.request, {}, next);
io.use(wrap(sessionMiddleware));

io.on('connection', (socket) => {
  console.log('New client connected');
  
  if (!socket.request.session?.user) {
    console.log('Unauthorized connection attempt');
    return socket.disconnect(true);
  }

  socket.user = socket.request.session.user;
  
  socket.on('message', async (msg) => {
    try {
      if (typeof msg !== 'string' || !msg.trim()) {
        throw new Error('Invalid message format');
      }

      const pool = await getPool();
      await pool.request()
        .input('message', msg.trim())
        .input('username', socket.user)
        .query('INSERT INTO Messages (content, username) VALUES (@message, @username)');
      
      io.emit('message', { 
        user: socket.user, 
        text: msg.trim(),
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Message save error:', error);
      socket.emit('error', 'Failed to send message');
    }
  });

  socket.on('disconnect', (reason) => {
    console.log(`Client disconnected: ${reason}`);
  });
});

// Server startup
async function startServer() {
  try {
    console.log("Initializing application...");
    console.log(`Environment: ${isAzure ? 'Azure' : 'Local'}`);
    console.log(`Views directory: ${VIEWS_DIR}`);
    console.log(`Public directory: ${PUBLIC_DIR}`);
    console.log(`Uploads directory: ${UPLOAD_DIR}`);

    // Verify view files exist
    ['chat', 'login', 'register'].forEach(view => {
      const viewPath = path.join(VIEWS_DIR, `${view}.html`);
      if (!fs.existsSync(viewPath)) {
        console.warn(`⚠️  View file missing: ${viewPath}`);
      } else {
        console.log(`✓ Found view: ${view}.html`);
      }
    });

    // Database connection with retries
    let dbConnected = false;
    let retries = 3;
    
    while (retries > 0 && !dbConnected) {
      try {
        dbConnected = await testConnection();
        if (!dbConnected) {
          retries--;
          console.log(`Database connection failed. Retries left: ${retries}`);
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      } catch (err) {
        console.error('Database connection error:', err);
        retries--;
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }

    if (!dbConnected && isAzure) {
      console.warn("⚠️  Running in limited mode without database connection");
    } else if (!dbConnected) {
      throw new Error("Database connection failed");
    }

    server.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      if (isAzure) {
        console.log(`🌐 Azure Web App URL: https://${process.env.WEBSITE_HOSTNAME}`);
      } else {
        console.log(`🔗 Local URLs:`);
        console.log(`- Chat: http://localhost:${PORT}`);
        console.log(`- Login: http://localhost:${PORT}/login`);
        console.log(`- Register: http://localhost:${PORT}/register`);
      }
    });
  } catch (err) {
    console.error("💥 FATAL: Failed to initialize app:", err);
    if (isAzure) {
      setTimeout(() => process.exit(1), 5000);
    } else {
      process.exit(1);
    }
  }
}

// Handle shutdown signals
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received. Closing server...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

startServer();