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

// Initialize app
const app = express();
const server = http.createServer(app);
const io = socketio(server);
const PORT = process.env.PORT || 3000;

// Configure file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'uploads/';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.originalname.match(/\.(jpg|jpeg|png|gif)$/)) {
      return cb(new Error('Only image files are allowed!'), false);
    }
    cb(null, true);
  }
});

// Session middleware
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: process.env.NODE_ENV === 'production' }
});

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(sessionMiddleware);

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, 'views')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Routes
app.get('/', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'views', 'chat.html'));
});

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

app.get('/register', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'views', 'register.html'));
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
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
      const pool = await getPool();
      await pool.request()
        .input('message', msg)
        .input('username', socket.user)
        .query('INSERT INTO Messages (content, username) VALUES (@message, @username)');
      
      io.emit('message', { 
        user: socket.user, 
        text: msg,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Message save error:', error);
      socket.emit('error', 'Failed to send message');
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

// Start Server
async function startServer() {
  try {
    console.log("Initializing application...");
    
    const dbConnected = await testConnection();
    if (!dbConnected) throw new Error("Database connection failed");

    server.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
      console.log(`- Chat: http://localhost:${PORT}`);
      console.log(`- Login: http://localhost:${PORT}/login`);
      console.log(`- Register: http://localhost:${PORT}/register`);
    });
  } catch (err) {
    console.error("FATAL: Failed to initialize app:", err);
    process.exit(1);
  }
}

startServer();