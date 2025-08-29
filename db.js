// db.js
const sql = require('mssql');

/** DB connection */
const connStr = process.env.DB_CONNECTION_STRING;
if (!connStr) console.warn('⚠️  DB_CONNECTION_STRING not set. DB calls will fail.');
let poolPromise;

async function getPool() {
  if (!poolPromise) poolPromise = sql.connect(connStr);
  return poolPromise;
}

async function testConnection() {
  try {
    const p = await getPool();
    await p.request().query('SELECT 1 AS ok');
    return true;
  } catch (e) {
    console.error('DB health check failed:', e.message);
    return false;
  }
}

/** Create/migrate schema in small, idempotent steps */
async function ensureSchema() {
  const p = await getPool();

  // ---- Users (create if missing)
  await p.request().query(`
    IF NOT EXISTS (
      SELECT 1 FROM sys.tables t JOIN sys.schemas s ON t.schema_id = s.schema_id
      WHERE s.name = 'dbo' AND t.name = 'Users'
    )
    BEGIN
      CREATE TABLE dbo.Users (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        username NVARCHAR(200) NOT NULL UNIQUE,
        password NVARCHAR(500) NOT NULL,
        CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
      );
    END
  `);

  // ---- Messages (create if missing)
  await p.request().query(`
    IF NOT EXISTS (
      SELECT 1 FROM sys.tables t JOIN sys.schemas s ON t.schema_id = s.schema_id
      WHERE s.name = 'dbo' AND t.name = 'Messages'
    )
    BEGIN
      CREATE TABLE dbo.Messages (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        Username NVARCHAR(200) NOT NULL,
        Body NVARCHAR(MAX) NOT NULL,
        CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
      );
    END
  `);

  // Messages migrations
  await p.request().query(`
    IF COL_LENGTH('dbo.Messages', 'Body') IS NULL
       AND COL_LENGTH('dbo.Messages', 'content') IS NOT NULL
      EXEC sp_rename 'dbo.Messages.content', 'Body', 'COLUMN';
  `);
  await p.request().query(`
    IF COL_LENGTH('dbo.Messages', 'Username') IS NULL
       AND COL_LENGTH('dbo.Messages', 'username') IS NOT NULL
      EXEC sp_rename 'dbo.Messages.username', 'Username', 'COLUMN';
  `);
  await p.request().query(`
    IF COL_LENGTH('dbo.Messages', 'CreatedAt') IS NULL
      ALTER TABLE dbo.Messages ADD CreatedAt DATETIME2 NULL;
  `);
  await p.request().query(`
    IF COL_LENGTH('dbo.Messages', 'CreatedAt') IS NOT NULL
       AND EXISTS (SELECT 1 FROM dbo.Messages WHERE CreatedAt IS NULL)
      UPDATE dbo.Messages SET CreatedAt = SYSUTCDATETIME() WHERE CreatedAt IS NULL;
  `);
  await p.request().query(`
    IF COL_LENGTH('dbo.Messages', 'CreatedAt') IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM sys.default_constraints
         WHERE parent_object_id = OBJECT_ID('dbo.Messages')
           AND name = 'DF_Messages_CreatedAt'
       )
      ALTER TABLE dbo.Messages
        ADD CONSTRAINT DF_Messages_CreatedAt DEFAULT SYSUTCDATETIME() FOR CreatedAt;
  `);
  await p.request().query(`
    IF COL_LENGTH('dbo.Messages', 'CreatedAt') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM dbo.Messages WHERE CreatedAt IS NULL)
      ALTER TABLE dbo.Messages ALTER COLUMN CreatedAt DATETIME2 NOT NULL;
  `);
  await p.request().query(`
    IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Messages') AND name = 'CreatedAt')
       AND NOT EXISTS (
         SELECT 1 FROM sys.indexes WHERE name = 'IX_Messages_CreatedAt' AND object_id = OBJECT_ID('dbo.Messages')
       )
      CREATE INDEX IX_Messages_CreatedAt ON dbo.Messages (CreatedAt DESC, Id DESC);
  `);

  // ---- Images (create if missing)
  await p.request().query(`
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
    END
  `);

  // Images migrations (THIS was missing before)
  await p.request().query(`
    IF COL_LENGTH('dbo.Images', 'CreatedAt') IS NULL
      ALTER TABLE dbo.Images ADD CreatedAt DATETIME2 NULL;
  `);
  await p.request().query(`
    IF COL_LENGTH('dbo.Images', 'CreatedAt') IS NOT NULL
       AND EXISTS (SELECT 1 FROM dbo.Images WHERE CreatedAt IS NULL)
      UPDATE dbo.Images SET CreatedAt = SYSUTCDATETIME() WHERE CreatedAt IS NULL;
  `);
  await p.request().query(`
    IF COL_LENGTH('dbo.Images', 'CreatedAt') IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM sys.default_constraints
         WHERE parent_object_id = OBJECT_ID('dbo.Images')
           AND name = 'DF_Images_CreatedAt'
       )
      ALTER TABLE dbo.Images
        ADD CONSTRAINT DF_Images_CreatedAt DEFAULT SYSUTCDATETIME() FOR CreatedAt;
  `);
  await p.request().query(`
    IF COL_LENGTH('dbo.Images', 'CreatedAt') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM dbo.Images WHERE CreatedAt IS NULL)
      ALTER TABLE dbo.Images ALTER COLUMN CreatedAt DATETIME2 NOT NULL;
  `);
  await p.request().query(`
    IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Images') AND name = 'CreatedAt')
       AND NOT EXISTS (
         SELECT 1 FROM sys.indexes WHERE name = 'IX_Images_CreatedAt' AND object_id = OBJECT_ID('dbo.Images')
       )
      CREATE INDEX IX_Images_CreatedAt ON dbo.Images (CreatedAt DESC, Id DESC);
  `);
}

/** Messages API helpers */
async function saveMessage(username, body) {
  const p = await getPool();
  const result = await p.request()
    .input('username', sql.NVarChar(200), username || 'anonymous')
    .input('body', sql.NVarChar(sql.MAX), body)
    .query(`
      INSERT INTO dbo.Messages (Username, Body)
      OUTPUT inserted.Id, inserted.Username, inserted.Body, inserted.CreatedAt
      VALUES (@username, @body)
    `);
  return result.recordset[0];
}

async function listMessages(username, limit = 50) {
  const p = await getPool();
  const result = await p.request()
    .input('username', sql.NVarChar(200), username)
    .input('n', sql.Int, limit)
    .query(`
      SELECT TOP (@n) Id, Username, Body, CreatedAt
      FROM dbo.Messages
      WHERE Username = @username
      ORDER BY CreatedAt DESC, Id DESC
    `);
  return result.recordset.reverse();
}

async function deleteMessage(id, username) {
  const p = await getPool();
  const result = await p.request()
    .input('id', sql.Int, id)
    .input('username', sql.NVarChar(200), username)
    .query(`
      DELETE FROM dbo.Messages
      WHERE Id = @id AND Username = @username;
      SELECT @@ROWCOUNT AS affected;
    `);
  return result.recordset[0]?.affected || 0;
}

/** Images API helpers */
async function listImages(username, limit = 50) {
  const p = await getPool();
  const result = await p.request()
    .input('username', sql.NVarChar(200), username)
    .input('n', sql.Int, limit)
    .query(`
      SELECT TOP (@n) Id, filename, originalname, username, path, size, mimetype, CreatedAt
      FROM dbo.Images
      WHERE username = @username
      ORDER BY CreatedAt DESC, Id DESC
    `);
  return result.recordset;
}

async function deleteImage(id, username) {
  const p = await getPool();
  const q1 = await p.request()
    .input('id', sql.Int, id)
    .input('username', sql.NVarChar(200), username)
    .query(`SELECT TOP 1 path FROM dbo.Images WHERE Id = @id AND username = @username;`);
  const img = q1.recordset[0];
  if (!img) return { affected: 0, path: null };

  const q2 = await p.request()
    .input('id', sql.Int, id)
    .input('username', sql.NVarChar(200), username)
    .query(`
      DELETE FROM dbo.Images WHERE Id = @id AND username = @username;
      SELECT @@ROWCOUNT AS affected;
    `);
  const affected = q2.recordset[0]?.affected || 0;
  return { affected, path: img.path };
}

module.exports = {
  getPool,
  testConnection,
  ensureSchema,
  saveMessage,
  listMessages,
  deleteMessage,
  listImages,
  deleteImage,
};
