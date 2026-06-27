# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**iTS Gerencial CASAN** — a single-page management dashboard (tasks, tickets/"chamados",
time-clock/"ponto", reports, user/access management) for the CASAN contract. Deployed via
**Coolify** (Docker Compose) on a self-hosted VPS, fronted by Traefik/Caddy.

The whole UI is one large static HTML file (`index.html`, ~3000 lines) served by nginx. There
is no build step and no framework — plain HTML/CSS/vanilla JS.

## Services (docker-compose.yaml)

| Service | Build | Port | Role |
|---|---|---|---|
| `its-gerencial-casan` | `Dockerfile` (nginx) | 80 | Serves `index.html` |
| `its-email-service` | `email-service/` (Express) | 3001 | Sends task e-mails via SMTP |
| `its-api` | `api/` (Express + pg) | 3002 (published) | REST API + auth, persists to Postgres |

The **Postgres database is NOT in this compose file** — it is a separate Coolify-managed
resource. `its-api` reaches it through `DATABASE_URL` (the Coolify "Postgres URL internal"),
set in the Coolify Environment Variables UI, never committed.

The browser reaches the backends **same-origin over HTTPS via path prefixes** to avoid
mixed-content blocking (the site is HTTPS; calling `http://host:port` is blocked by browsers):
- `ITS_API = location.origin + '/api'` → routed by Traefik to `its-api:3002`
- email calls use `location.origin + '/email/send'` → `its-email-service:3001`

Both backends include a small middleware that strips the `/api` (resp. `/email`) prefix from
`req.url`, so their routes are defined at root but work behind the prefixed Traefik route.
**This requires Coolify to map the domain+path** to each service:
`casan.../api` → its-api, `casan.../email` → its-email-service. Until that mapping exists,
the frontend silently falls back to offline/local mode.

## Architecture: how data and auth flow

The frontend was originally 100% `localStorage`. It now persists through `its-api`/Postgres
while keeping localStorage as an **offline cache**. Key mechanism in `index.html`:

- In-memory vars `PONTO_DB`, `CFG`, `USERS` (+ `its_admin_hash`) are the working state.
- `remoteSet(key, val)` / `remoteGet(key)` mirror these to the API's `/config/:chave`
  key-value endpoint (table `casan_config`). They attach `Authorization: Bearer <token>`
  and **no-op when there is no token** (local-only mode).
- `hydrateFromAPI()` runs *after a successful authenticated login* (inside `applySession`),
  pulls server state, reassigns the in-memory vars, and re-renders.
- The structured tables (`casan_usuarios`, `casan_ponto`, `casan_tarefas`, `casan_chamados`)
  exist in the schema but the live frontend currently syncs via the `casan_config` blob path.
  Keep this in mind: changing a save function means also updating its `remoteSet` mirror.

**Authentication** (`api/index.js` + `index.html doLogin`):
- Login posts to `/auth/login`; the API verifies with **bcrypt** and issues a session token
  (table `casan_sessions`, 7-day expiry). Token stored in `sessionStorage.its_token`.
- **2FA via Google Authenticator (TOTP)** is optional per user: `/auth/2fa/setup` returns a
  QR + secret, `/auth/2fa/enable` activates after one valid code, `/auth/login` then returns
  `need2fa` and a short-lived `login_token` that `/auth/2fa/verify` exchanges for a session.
- `requireAuth` middleware guards **every route after the `app.use(requireAuth)` line** — all
  data endpoints. Anything that must be public (login, 2fa verify, health) is defined above it.
- `doLoginOffline()` is a fallback that uses the legacy client-side SHA-256 check against the
  local `USERS` list when the API is unreachable; in that mode there is no token and no sync.

The `casan_usuarios` table and the frontend `USERS` blob are **two separate user stores** that
are not yet reconciled. API login authenticates against `casan_usuarios` (seeded with one admin
from `ADMIN_EMAIL`/`ADMIN_SENHA` on first boot). The legacy `USERS`/`AUTH_ACCOUNTS` arrays still
drive the offline fallback and the in-app user-management screen.

## Security conventions (already applied — preserve them)

- **Never persist the SMTP password client-side.** `saveConfig` deletes `CFG.smtpSenha`; real
  SMTP credentials live only in `email-service` env vars (`SMTP_USER`/`SMTP_PASS`).
- **Escape user text before `innerHTML`.** Use the `esc()` helper in `index.html` for any
  user-controlled string injected into markup or `value="..."` attributes.
- API uses **parameterized queries only** (`pool.query(sql, [params])`) — never string-concat SQL.
- Postgres must not expose a public port mapping in Coolify; the app reaches it over the
  internal network.

## Schema

`api/schema.sql` is applied idempotently on every `its-api` boot (`CREATE TABLE IF NOT EXISTS`
+ `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`). To change the schema, edit this file; it re-runs
on redeploy. Tables are prefixed `casan_`.

## Local checks (no test suite exists)

```bash
# Syntax-check the API
cd api && node --check index.js

# Syntax-check every <script> block in the SPA
node -e "const fs=require('fs');const h=fs.readFileSync('index.html','utf8');for(const b of h.matchAll(/<script>([\s\S]*?)<\/script>/g)){new Function(b[1]);}console.log('JS OK')"

# Validate compose
python3 -c "import yaml;yaml.safe_load(open('docker-compose.yaml'));print('YAML OK')"
```

`api/node_modules` is gitignored and built inside the container — do not commit it.

## Deploy (Coolify)

Required env vars on the **app/api** resource: `DATABASE_URL` (Postgres internal URL),
`ADMIN_EMAIL`, `ADMIN_SENHA`. On the **email-service**: `SMTP_HOST/PORT/SECURE/USER/PASS`.
After redeploy, `its-api` logs should print `Schema pronto.` (and `Usuario admin inicial criado.`
on first boot). All containers have a `HEALTHCHECK`.

## Git workflow

Active development branch: `claude/new-session-sai25q`, kept in sync with `main`. Both are
pushed together after each change.

## Other files

- `perfis-acesso.html` — standalone static reference page documenting access profiles/permissions.
- `index.html` nav permissions are driven by `NAV_PERMISSIONS` (cargo → visible sections);
  `Cliente` and `Operador` are restricted profiles.
