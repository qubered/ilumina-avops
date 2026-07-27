#!/bin/bash
# Recreate the local-dev Outline container (idempotent). Reads stable
# secrets from dev-outline-secrets.env — do NOT regenerate them: Outline
# encrypts stored webhook secrets and OAuth tokens with SECRET_KEY.
set -euo pipefail
cd "$(dirname "$0")/.."

source docker/dev-outline-secrets.env
OIDC_ID=$(grep '^OIDC_CLIENT_ID=' .env | cut -d= -f2)
OIDC_SECRET=$(grep '^OIDC_CLIENT_SECRET=' .env | cut -d= -f2)

# Stable app endpoint for Outline's server-side calls: an nginx sidecar on a
# shared user-defined network, so Outline reaches it by container name via
# Docker DNS (network-change-proof; .orb.local doesn't resolve inside
# containers). Container IPs live in 192.168.0.0/16 on OrbStack, hence the
# SSRF allowlist CIDR.
docker network create avops-dev-net >/dev/null 2>&1 || true

docker rm -f avops-assistant-proxy >/dev/null 2>&1 || true
docker run -d --name avops-assistant-proxy \
  --network-alias avops-assistant-proxy.internal \
  --network avops-dev-net \
  -v "$(pwd)/docker/dev-assistant-proxy.conf:/etc/nginx/conf.d/default.conf:ro" \
  nginx:alpine >/dev/null

docker rm -f avops-dev-outline >/dev/null 2>&1 || true
docker run -d --name avops-dev-outline \
  --network avops-dev-net \
  -e NODE_ENV=production \
  -e URL=https://avops-dev-outline.orb.local \
  -e PORT=3000 \
  -e SECRET_KEY="$SECRET_KEY" \
  -e UTILS_SECRET="$UTILS_SECRET" \
  -e DATABASE_URL=postgres://outline:outline@host.docker.internal:55432/outline \
  -e PGSSLMODE=disable \
  -e REDIS_URL=redis://host.docker.internal:6379 \
  -e FILE_STORAGE=local \
  -e FILE_STORAGE_LOCAL_ROOT_DIR=/var/lib/outline/data \
  -e ALLOWED_PRIVATE_IP_ADDRESSES=192.168.0.0/16 \
  -e OIDC_CLIENT_ID="$OIDC_ID" \
  -e OIDC_CLIENT_SECRET="$OIDC_SECRET" \
  -e OIDC_AUTH_URI=http://localhost:3100/api/auth/oauth2/authorize \
  -e OIDC_TOKEN_URI=http://avops-assistant-proxy.internal/api/auth/oauth2/token \
  -e OIDC_USERINFO_URI=http://avops-assistant-proxy.internal/api/auth/oauth2/userinfo \
  -e OIDC_USERNAME_CLAIM=email \
  -e OIDC_DISPLAY_NAME="AV Ops SSO" \
  -e OIDC_SCOPES="openid profile email" \
  -v avops-dev-outline:/var/lib/outline/data \
  outlinewiki/outline:latest >/dev/null

echo "waiting for outline..."
for i in $(seq 1 40); do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' https://avops-dev-outline.orb.local 2>/dev/null || true)
  if [ "$CODE" = "200" ]; then echo "outline up: https://avops-dev-outline.orb.local"; exit 0; fi
  sleep 2
done
echo "outline did not come up; check: docker logs avops-dev-outline" >&2
exit 1
