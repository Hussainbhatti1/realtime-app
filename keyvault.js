// keyvault.js
const { DefaultAzureCredential } = require("@azure/identity");
const { SecretClient } = require("@azure/keyvault-secrets");

const keyVaultName = "project4KeyVault321"; // 🔁 Replace if your Key Vault name is different
const KVUri = `https://${keyVaultName}.vault.azure.net`;

const credential = new DefaultAzureCredential(); // uses Azure CLI credentials if logged in

const client = new SecretClient(KVUri, credential);

async function getDbConnectionString() {
  const latestSecret = await client.getSecret("DB-Connection-String");
  return latestSecret.value;
}

module.exports = getDbConnectionString;
