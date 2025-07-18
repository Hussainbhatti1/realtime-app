const express = require("express");
const http = require("http");
const socketio = require("socket.io");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const path = require("path");
const getPool = require("./db");

const app = express();
const server = http.createServer(app);
const io = socketio(server);

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({ secret: "secret123", resave: false, saveUninitialized: true }));
app.use("/uploads", express.static("uploads"));
app.use(express.static("public"));

// Views
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Multer config
const storage = multer.diskStorage({
  destination: "uploads/",
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname)),
});
const upload = multer({ storage });

// Routes
app.get("/", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  res.sendFile(path.join(__dirname, "public/index.html"));
});

app.get("/login", (req, res) => res.sendFile(path.join(__dirname, "views/login.html")));
app.get("/register", (req, res) => res.sendFile(path.join(__dirname, "views/register.html")));

app.post("/register", async (req, res) => {
  const { username, password } = req.body;
  const hashed = await bcrypt.hash(password, 10);
  const db = await getPool();
  await db.request().input("username", username).input("password", hashed)
    .query("INSERT INTO Users (username, password) VALUES (@username, @password)");
  res.redirect("/login");
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const db = await getPool();
  const result = await db.request().input("username", username).query("SELECT * FROM Users WHERE username = @username");
  if (result.recordset.length && await bcrypt.compare(password, result.recordset[0].password)) {
    req.session.user = username;
    res.redirect("/");
  } else res.send("Login failed");
});

app.post("/upload", upload.single("image"), async (req, res) => {
  const db = await getPool();
  await db.request().input("filename", req.file.filename).query("INSERT INTO Images (filename, upload_time) VALUES (@filename, GETDATE())");
  res.send("Uploaded!");
});

// Socket.IO
io.on("connection", (socket) => {
  socket.on("message", async (msg) => {
    const db = await getPool();
    await db.request().input("message", msg).query("INSERT INTO Chats (message, timestamp) VALUES (@message, GETDATE())");
    io.emit("message", msg);
  });
});

const port = process.env.PORT || 3000;
server.listen(port, () => console.log("App running on port", port));
