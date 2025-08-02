#!/bin/bash
# fetch-secrets.sh - Safely retrieves secrets from Azure Key Vault

KEY_VAULT_NAME="project4KeyVault321"
ENV_FILE=".env"

echo "🔐 Fetching secrets from Azure Key Vault..."

# List all secrets and write to .env
az keyvault secret list \
  --vault-name $KEY_VAULT_NAME \
  --query "[].name" -o tsv | while read -r secret_name; do
  
  # Skip secrets you don't want locally
  if [[ $secret_name == *"ADMIN"* ]]; then
    continue
  fi

  secret_value=$(az keyvault secret show \
    --vault-name $KEY_VAULT_NAME \
    --name "$secret_name" \
    --query "value" -o tsv)

  # Convert "DB-USER" to "DB_USER" for .env compatibility
  env_var_name=$(echo "$secret_name" | tr '-' '_')
  echo "$env_var_name=\"$secret_value\"" >> $ENV_FILE
done

echo "✅ Secrets saved to .env (DO NOT COMMIT THIS FILE)"
echo "🛡️  Remember to add '.env' to .gitignore!"