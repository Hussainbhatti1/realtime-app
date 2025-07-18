const sql = require("mssql");
const getDbConnectionString = require("./keyvault");

let pool;

async function connectDB() {
  const connStr = await getDbConnectionString();

  pool = await sql.connect(connStr);

  const createTablesQuery = `
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='Users' AND xtype='U')
    CREATE TABLE Users (id INT PRIMARY KEY IDENTITY, username NVARCHAR(50), password NVARCHAR(255));

    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='Chats' AND xtype='U')
    CREATE TABLE Chats (id INT PRIMARY KEY IDENTITY, message NVARCHAR(MAX), timestamp DATETIME);

    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='Images' AND xtype='U')
    CREATE TABLE Images (id INT PRIMARY KEY IDENTITY, filename NVARCHAR(255), upload_time DATETIME);
  `;

  await pool.request().query(createTablesQuery);
  return pool;
}

async function getPool() {
  if (!pool) await connectDB();
  return pool;
}

module.exports = getPool;
