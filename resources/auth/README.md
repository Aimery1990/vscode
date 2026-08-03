# AnyAgent Auth Provider Configuration

This directory contains authentication configuration files and client secrets for OAuth providers (Google, GitHub, Microsoft) supported by AnyAgent Desktop.

## Directory Structure

- `google_client_secret.json`: Official Google Console Client Secret JSON.
- `auth_providers.json`: Multi-provider runtime configuration.
- `auth_providers.template.json`: Public template file for repository contributors.
- `.gitignore`: Ensures secret credentials remain uncommitted.

## How to Add New Auth Credentials

1. **GitHub OAuth**: Fill in `clientId` and `clientSecret` under `providers.github` in `auth_providers.json` and set `"enabled": true`.
2. **Microsoft OAuth**: Fill in `clientId` and `clientSecret` under `providers.microsoft` in `auth_providers.json` and set `"enabled": true`.
