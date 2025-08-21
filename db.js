// db.js
const sql = require('mssql');
const { getConfig } = require('./keyvault');

let pool;

async function getPool() {
  if (pool) return pool;

  const cfg = getConfig();

  const hasConnStr = !!(cfg.connectionString && cfg.connectionString.trim());

  try {
    console.log('Connecting to Azure SQL...');

    if (hasConnStr) {
      // IMPORTANT: pass the connection string as a STRING (not { connectionString })
      pool = await sql.connect(cfg.connectionString);
    } else {
      // Fallback to component-style config ONLY if present
      const dbConfig = {
        server: cfg.db.server,
        database: cfg.db.database,
        user: cfg.db.user,
        password: cfg.db.password,
        options: { encrypt: true, trustServerCertificate: false },
      };

      if (!dbConfig.server || !dbConfig.database || !dbConfig.user || !dbConfig.password) {
        throw new Error(
          'No DB configuration found. Set DB_CONNECTION_STRING in .env (preferred), or provide DB_SERVER/DB_NAME/DB_USER/DB_PASSWORD.'
        );
      }

      pool = await sql.connect(dbConfig);
    }

    console.log('Connected to Azure SQL');
    await ensureTables(pool);
    return pool;
  } catch (err) {
    console.error('DB connect error:', err);
    throw err;
  }
}

async function ensureTables(pool) {
  const stmts = [
    `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='Users' AND xtype='U')
     CREATE TABLE Users (
       id INT IDENTITY(1,1) PRIMARY KEY,
       username NVARCHAR(100) UNIQUE NOT NULL,
       password NVARCHAR(255) NOT NULL,
       created_at DATETIME2 DEFAULT SYSUTCDATETIME()
     );`,
    `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='Images' AND xtype='U')
     CREATE TABLE Images (
       id INT IDENTITY(1,1) PRIMARY KEY,
       filename NVARCHAR(255) NOT NULL,
       originalname NVARCHAR(255) NULL,
       username NVARCHAR(100) NOT NULL,
       path NVARCHAR(400) NULL,
       size BIGINT NULL,
       mimetype NVARCHAR(100) NULL,
       created_at DATETIME2 DEFAULT SYSUTCDATETIME()
     );`,
    `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='Messages' AND xtype='U')
     CREATE TABLE Messages (
       id INT IDENTITY(1,1) PRIMARY KEY,
       content NVARCHAR(MAX) NOT NULL,
       username NVARCHAR(100) NOT NULL,
       created_at DATETIME2 DEFAULT SYSUTCDATETIME()
     );`,
  ];
  for (const s of stmts) {
    await pool.request().query(s);
  }
}

async function testConnection() {
  try {
    const p = await getPool();
    await p.request().query('SELECT 1 AS ok');
    return true;
  } catch (e) {
    console.error('DB test failed:', e);
    return false;
  }
}

module.exports = { getPool, testConnection };
