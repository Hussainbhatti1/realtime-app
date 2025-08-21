#!/usr/bin/env bash
set -euo pipefail

KV_NAME="${KEYVAULT_NAME:-project4KeyVault321}"
ENV_FILE=".env"

echo "🔐 Fetching required secrets from Key Vault: $KV_NAME"

# Pull only what the app needs; generate a fresh .env atomically
TMP="$(mktemp)"
{
  # Always include KV name for reference
  echo "KEYVAULT_NAME=$KV_NAME"

  # Single connection string (preferred)
  DB_CONN="$(az keyvault secret show --vault-name "$KV_NAME" --name 'DB-CONNECTION-STRING' --query value -o tsv 2>/dev/null || true)"
  if [ -n "${DB_CONN:-}" ]; then
    echo "DB_CONNECTION_STRING=$DB_CONN"
  fi

  # Session secret
  SESSION="$(az keyvault secret show --vault-name "$KV_NAME" --name 'SESSION-SECRET' --query value -o tsv 2>/dev/null || true)"
  if [ -n "${SESSION:-}" ]; then
    echo "SESSION_SECRET=$SESSION"
  fi

  # Optional: if you still use component vars, uncomment & ensure secrets exist in KV
  # echo "DB_SERVER=$(az keyvault secret show --vault-name "$KV_NAME" --name 'DB-SERVER' --query value -o tsv 2>/dev/null || true)"
  # echo "DB_NAME=$(az keyvault secret show --vault-name "$KV_NAME" --name 'DB-NAME' --query value -o tsv 2>/dev/null || true)"
  # echo "DB_USER=$(az keyvault secret show --vault-name "$KV_NAME" --name 'DB-USER' --query value -o tsv 2>/dev/null || true)"
  # echo "DB_PASSWORD=$(az keyvault secret show --vault-name "$KV_NAME" --name 'DB-PASSWORD' --query value -o tsv 2>/dev/null || true)"
} > "$TMP"

mv "$TMP" "$ENV_FILE"
echo "✅ Wrote $ENV_FILE (never commit this file)"
