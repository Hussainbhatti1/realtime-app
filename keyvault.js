const { DefaultAzureCredential } = require("@azure/identity");
const { SecretClient } = require("@azure/keyvault-secrets");
require('dotenv').config();

const keyVaultName = process.env.KEYVAULT_NAME || "project4KeyVault321";
const KVUri = `https://${keyVaultName}.vault.azure.net`;

let client;

// Initialize Key Vault client
try {
  const credential = new DefaultAzureCredential();
  client = new SecretClient(KVUri, credential);
  console.log("Connected to Azure Key Vault");
} catch (err) {
  console.warn("Key Vault unavailable - falling back to .env");
}

async function getSecret(secretName) {
  // Try Key Vault first
  if (client) {
    try {
      const secret = await client.getSecret(secretName);
      return secret.value;
    } catch (err) {
      console.warn(`Key Vault failed for ${secretName}: ${err.message}`);
    }
  }

  // Fallback to .env (convert "DB-USER" to "DB_USER")
  const envVar = secretName.replace(/-/g, '_');
  return process.env[envVar];
}

// Unified database configuration
module.exports = {
  getDbConfig: async () => ({
    // Option 1: Use full connection string
    connectionString: await getSecret("DB-CONNECTION-STRING"),
    
    // Option 2: Individual components (if needed separately)
    server: await getSecret("DB-SERVER"),
    user: await getSecret("DB-USER"),
    password: await getSecret("DB-PASSWORD"),
    database: await getSecret("DB-NAME")
  })
};