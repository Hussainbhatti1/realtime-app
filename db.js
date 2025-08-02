const sql = require('mssql');
const { getDbConfig } = require('./keyvault');

let pool;

async function initPool() {
  const config = await getDbConfig();
  
  const dbConfig = {
    server: config.server,
    database: config.database,
    user: config.user,
    password: config.password,
    options: {
      encrypt: true,
      trustServerCertificate: false
    }
  };

  try {
    console.log("Connecting to database...");
    pool = await sql.connect(dbConfig);
    console.log("Database connection established");
    return pool;
  } catch (err) {
    console.error("Database connection failed:", err);
    throw err;
  }
}

async function getPool() {
  if (!pool) {
    await initPool();
  }
  return pool;
}

// Add this function and export it
async function testConnection() {
  try {
    const pool = await getPool();
    const result = await pool.request().query("SELECT 1");
    console.log("Database connection test successful");
    return true;
  } catch (err) {
    console.error("Database connection test failed:", err);
    return false;
  }
}

module.exports = {
  sql,
  getPool,
  testConnection // Now properly exported
};