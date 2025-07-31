require('dotenv').config();
const express = require("express");
const http = require("http");
const socketio = require("socket.io");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const getPool = require("./db");

// Initialize Express and Socket.io
const app = express();
const server = http.createServer(app);
const io = socketio(server);

// Configuration
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const UPLOADS_DIR = path.join(__dirname, 'uploads');

// Ensure uploads directory exists
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({ 
  secret: process.env.SESSION_SECRET || "secret123", 
  resave: false, 
  saveUninitialized: true,
  cookie: { secure: process.env.NODE_ENV === 'production' }
}));

// Static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// View engine setup
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// File upload configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// Database connection check
async function testDbConnection() {
  try {
    const db = await getPool();
    await db.request().query("SELECT 1");
    console.log("Database connection successful");
    return true;
  } catch (err) {
    console.error("Database connection failed:", err);
    return false;
  }
}

// Routes
app.get("/", async (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  
  // Verify DB connection before proceeding
  if (!await testDbConnection()) {
    return res.status(500).send("Database connection error");
  }
  
  res.sendFile(path.join(__dirname, "public/index.html"));
});

app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "views/login.html"));
});

app.get("/register", (req, res) => {
  res.sendFile(path.join(__dirname, "views/register.html"));
});

app.post("/register", async (req, res) => {
  try {
    const { username, password } = req.body;
    const hashed = await bcrypt.hash(password, 10);
    const db = await getPool();
    
    await db.request()
      .input("username", username)
      .input("password", hashed)
      .query("INSERT INTO Users (username, password) VALUES (@username, @password)");
      
    res.redirect("/login");
  } catch (err) {
    console.error("Registration error:", err);
    res.status(500).send("Registration failed");
  }
});

app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    const db = await getPool();
    
    const result = await db.request()
      .input("username", username)
      .query("SELECT * FROM Users WHERE username = @username");
      
    if (result.recordset.length && await bcrypt.compare(password, result.recordset[0].password)) {
      req.session.user = username;
      return res.redirect("/");
    }
    
    res.send("Login failed");
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).send("Login failed");
  }
});

app.post("/upload", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).send("No file uploaded");
    }
    
    const db = await getPool();
    await db.request()
      .input("filename", req.file.filename)
      .query("INSERT INTO Images (filename, upload_time) VALUES (@filename, GETDATE())");
      
    res.send("Uploaded!");
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).send("Upload failed");
  }
});

// Socket.io events
io.on("connection", (socket) => {
  console.log("New client connected");
  
  socket.on("message", async (msg) => {
    try {
      const db = await getPool();
      await db.request()
        .input("message", msg)
        .query("INSERT INTO Chats (message, timestamp) VALUES (@message, GETDATE())");
        
      io.emit("message", msg);
    } catch (err) {
      console.error("Message error:", err);
    }
  });
  
  socket.on("disconnect", () => {
    console.log("Client disconnected");
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Something broke!');
});

// Start server
server.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
  
  // Test database connection on startup
  testDbConnection();
});

// Handle process termination
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});