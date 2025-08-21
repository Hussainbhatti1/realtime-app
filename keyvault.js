// keyvault.js
// Reads configuration from environment variables ONLY.
// In production, App Service injects env vars via Key Vault references.
// Locally, ./fetch-secrets.sh writes .env with the same names.
require('dotenv').config();

function getConfig() {
  return {
    // Preferred: single connection string
    connectionString: process.env.DB_CONNECTION_STRING || "",
    // Optional component-style fallback (only if you choose to use it)
    db: {
      server: process.env.DB_SERVER,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD
    },
    sessionSecret: process.env.SESSION_SECRET || "dev-secret",
  };
}

module.exports = { getConfig };
