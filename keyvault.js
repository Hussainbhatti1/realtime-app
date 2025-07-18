const { DefaultAzureCredential } = require('@azure/identity');
const { SecretClient } = require('@azure/keyvault-secrets');

const keyVaultName = process.env.KEYVAULT_NAME || "project4KeyVault321";
const kvUri = `https://${keyVaultName}.vault.azure.net`;

const credential = new DefaultAzureCredential();
const client = new SecretClient(kvUri, credential);

async function getDbConnectionString() {
  const secret = await client.getSecret("DB-Connection-String");
  return secret.value;
}

module.exports = getDbConnectionString;
