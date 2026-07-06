# Dev environment on a fresh machine

Two tiers. **Tier 1** (app + chat + vector KB) works on any OS with Docker.
**Tier 2** adds a local Outline with SSO + webhooks — it relies on OrbStack's
`*.orb.local` HTTPS domains, so it's macOS/OrbStack-specific.

## Tier 1 — the app

### 0. Prerequisites

- Node 22+, pnpm (`corepack enable`)
- Docker (OrbStack on macOS)
- For codex mode: the Codex CLI, signed in on **this** machine (`npm i -g @openai/codex && codex login`). Tokens don't travel between machines.

### 1. Clone + install

```bash
git clone https://github.com/qubered/ilumina-avops
cd ilumina-avops/avops-assistant
pnpm install
```

### 2. Databases

```bash
docker run -d --name avops-dev-pg --restart unless-stopped -p 55432:5432 \
  -e POSTGRES_USER=avops -e POSTGRES_PASSWORD=avops -e POSTGRES_DB=avops \
  -v avops-dev-pg:/var/lib/postgresql/data postgres:16
docker run -d --name avops-dev-qdrant --restart unless-stopped -p 6333:6333 \
  -v avops-dev-qdrant:/qdrant/storage qdrant/qdrant
```

### 3. `.env`

Secrets are not in git — create fresh ones per machine:

```bash
cat > .env <<EOF
DATABASE_URL=postgres://avops:avops@localhost:55432/avops
AUTH_SECRET=$(openssl rand -hex 32)
COOKIE_DOMAIN=
SIGNUP_KEY=                  # optional crew invite code; empty = open registration

AI_PROVIDER=codex            # or: anthropic (+ ANTHROPIC_API_KEY)
CODEX_MODEL=gpt-5.5
CODEX_AUTO_REFRESH=true
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-sonnet-5

VOYAGE_API_KEY=<your key>    # dashboard.voyageai.com — keyless tier is 3 req/min
VOYAGE_MODEL=voyage-3-large

QDRANT_URL=http://localhost:6333

# Placeholders until Tier 2; must be non-empty for env validation.
OUTLINE_URL=http://localhost:8080
OUTLINE_API_KEY=placeholder
OUTLINE_WEBHOOK_SECRET=$(openssl rand -hex 16)

APP_URL=http://localhost:3100
OIDC_CLIENT_ID=$(openssl rand -hex 16)
OIDC_CLIENT_SECRET=$(openssl rand -hex 32)
EOF
```

### 4. Run

```bash
pnpm dev -p 3100     # port must match APP_URL; migrations run at boot
```

Register at http://localhost:3100 — the **first account becomes admin**.

### 5. Knowledge base content

Without Outline, load the demo docs: `pnpm seed` (indexes `../sample_kb` into
Qdrant). The three starter questions then return cited answers.
⚠️ A full sync **prunes seeded docs** — seeding is for Outline-less dev only.

Checks: `pnpm test`, `pnpm lint`, `pnpm tsc --noEmit`.

## Tier 2 — local Outline with SSO + webhooks (macOS/OrbStack)

### 6. One-time Outline plumbing

```bash
# Outline's database (inside the same postgres) + redis
docker exec avops-dev-pg psql -U avops \
  -c "CREATE ROLE outline LOGIN PASSWORD 'outline';" \
  -c "CREATE DATABASE outline OWNER outline;"
docker run -d --name avops-dev-redis --restart unless-stopped -p 6379:6379 redis:7

# Outline's encryption secrets — generate ONCE per machine and never rotate:
# SECRET_KEY encrypts rows in Outline's DB; rotating it bricks the instance.
cat > docker/dev-outline-secrets.env <<EOF
SECRET_KEY=$(openssl rand -hex 32)
UTILS_SECRET=$(openssl rand -hex 32)
EOF
```

### 7. Start Outline

```bash
./docker/dev-outline.sh
```

This starts Outline at `https://avops-dev-outline.orb.local` plus an
`avops-assistant-proxy` nginx sidecar on a shared Docker network — Outline's
server-side OIDC/webhook calls go to the stable name
`avops-assistant-proxy.internal`, so nothing breaks when the host changes
Wi-Fi networks.

Point the app at it in `.env`:

```
OUTLINE_URL=https://avops-dev-outline.orb.local
```

Node doesn't read the macOS keychain, so export OrbStack's local CA for the
app's HTTPS calls to Outline, and start dev with it:

```bash
security find-certificate -c "OrbStack Development Root CA" -p > docker/orbstack-root-ca.pem
NODE_EXTRA_CA_CERTS=$PWD/docker/orbstack-root-ca.pem pnpm dev -p 3100
```

### 8. Wire the two apps together

1. Open `https://avops-dev-outline.orb.local` → **Continue with AV Ops SSO**
   → sign in with your assistant account. First SSO login creates the
   Outline workspace with you as owner.
2. Outline → Settings → API → create an API key → set `OUTLINE_API_KEY` in
   `.env`, restart the dev server.
3. Outline → Settings → Webhooks → add:
   - URL: `http://avops-assistant-proxy.internal/api/webhooks/outline`
   - Signing secret: your `OUTLINE_WEBHOOK_SECRET`
   - Events: document events
4. Assistant → Admin → **Re-sync now**.

From then on, publishing/editing docs in Outline re-indexes them within
seconds (webhook), with a nightly 04:00 Sydney full sync as backstop.
Note: connecting Outline prunes `pnpm seed` content by design — put real
docs in Outline instead (a "Zone:/System:/Type:" first-line metadata block
is parsed into search payload fields).

## Gotchas learned the hard way

- **Never rotate `SECRET_KEY`** in `dev-outline-secrets.env` — Outline
  encrypts webhook secrets and OAuth tokens with it; rotation forces a DB
  reset.
- **Codex tokens are per-machine and single-use on refresh.** The app writes
  rotated tokens back to `~/.codex/auth.json`; if auth breaks anyway, re-run
  `codex login`.
- **Voyage keyless tier = 3 requests/min.** Syncs retry 429s automatically
  but run slowly; add a payment method to lift it.
- The dev password convention on Jayden's machines is per-developer — first
  registered account is admin, so register before anyone else does.
