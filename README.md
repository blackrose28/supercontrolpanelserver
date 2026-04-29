# cc-server

Control Plane server for SuperControlPanel.

## Features

- Device enrollment
- Agent websocket connection
- Telemetry ingest and live streaming
- Admin web UI
- Persisted devices, telemetry, runtime summaries, and admin sessions
- Persisted admin API tokens with mint/list/revoke support
- Cookie-based admin login with CSRF protection
- Rate limiting on sensitive endpoints

## Required environment variables

These are required at startup:

- `CC_ADMIN_PASSWORD`
- `CC_BOOTSTRAP_TOKEN`

The server now fails fast if either is missing.

### Recommended values

- `CC_ADMIN_PASSWORD`: at least 8+ characters
- `CC_BOOTSTRAP_TOKEN`: at least 16+ characters

## Optional environment variables

### Server

- `PORT`  
  Default: `3000`

- `CC_DB_PATH`  
  Default: `./data/cc-server.sqlite`

### Admin sessions

- `CC_ADMIN_SESSION_TTL_HOURS`  
  Default: `12`

### Mobile/admin API auth

- `CC_ADMIN_API_TOKEN`  
  Optional. Bootstrap bearer token for early mobile/admin REST clients. DB-backed minted tokens are also supported.

### Telemetry retention

- `CC_LOG_RETENTION_MAX_EVENTS_PER_DEVICE`  
  Default: `5000`

- `CC_LOG_RETENTION_MAX_AGE_DAYS`  
  Default: `30`

### Rate limiting

- `CC_RATE_LIMIT_LOGIN_MAX`  
  Default: `10`

- `CC_RATE_LIMIT_LOGIN_WINDOW_MS`  
  Default: `300000`

- `CC_RATE_LIMIT_ENROLL_MAX`  
  Default: `20`

- `CC_RATE_LIMIT_ENROLL_WINDOW_MS`  
  Default: `300000`

- `CC_RATE_LIMIT_INGEST_MAX`  
  Default: `600`

- `CC_RATE_LIMIT_INGEST_WINDOW_MS`  
  Default: `60000`

## Install

```bash
npm install
```

## Configure

Copy the example env file and fill in real values:

```bash
cp .env.example .env
```

Edit `.env` — the two required variables are:

```dotenv
CC_ADMIN_PASSWORD=your-strong-password
CC_BOOTSTRAP_TOKEN=your-strong-token
```

> `.env` is gitignored and will never be committed.

## Start

```bash
npm start
```

Or pass secrets inline (useful for CI / containers):

```bash
CC_ADMIN_PASSWORD='…' CC_BOOTSTRAP_TOKEN='…' npm start
```

## Deploy to Cloudflare Workers (D1 mode)

For Cloudflare Workers deployment with D1 database:

```bash
# Install dependencies and validate both runtime paths first
npm install
npm test
npm run build
npm --prefix admin-next run build

# Local API preview
npx wrangler dev

# Deploy to production
npx wrangler deploy
```

**Note for agents:** In Cloudflare Workers D1 mode, agents now prefer WebSockets backed by a per-device Durable Object using WebSocket hibernation:
1. **GET /agent with WebSocket upgrade**: primary bidirectional agent transport; command dispatch wakes the device Durable Object and sends immediately to connected hibernated sockets.
2. **POST /agent**: compatibility heartbeat/telemetry polling fallback for older agents.
3. **GET /agent**: compatibility JSON command polling fallback when no WebSocket upgrade is requested.

The Worker requires the `CC_AGENT_DO` Durable Object binding from `wrangler.toml`; keep the D1 `CC_DB` binding configured as before.

### Cloudflare required bindings and secrets

Configure these before production deployment:

- D1 binding: `CC_DB`
- Durable Object binding: `CC_AGENT_DO`
- Secrets: `CC_ADMIN_PASSWORD`, `CC_BOOTSTRAP_TOKEN`
- Optional compatibility secret: `CC_ADMIN_API_TOKEN`
- TOTP encryption secret when using admin TOTP: `CC_TOTP_ENCRYPTION_KEY`

Apply the D1 schema/migration before routing production traffic to Workers. See `../docs/cc/cloudflare-d1-migration-runbook.md` for SQLite-to-D1 export/import and rollback.

### Cloudflare Pages admin deployment

`admin-next` remains a normal Vite app for local/server deployments and can also be deployed as Cloudflare Pages:

```bash
npm --prefix admin-next run build
npx wrangler pages dev public/admin-next --compatibility-date=2026-04-29
```

For production, connect the Pages project to `cc-server/admin-next` (or upload `cc-server/public/admin-next`) and configure it to call the Worker API origin. The existing NestJS backend and Vite workflow remain supported; this Cloudflare path is additive, not a replacement.

### Rollback

If the Worker/D1 deployment has issues, route traffic back to the normal NestJS server and restore the SQLite backup captured before migration. Do not run active-active writes to both SQLite and D1 unless a future sync design is added.

## Development

```bash
npm run dev
```

## Admin UI

Open:

```text
http://localhost:3000/admin
```

Then sign in with `CC_ADMIN_PASSWORD`.

From the Devices page, the "Admin API tokens" section can mint, list, and revoke bearer tokens for mobile/admin REST clients.

The Devices page also exposes the current safe device-control actions:

- request status snapshot
- request inventory
- request recent logs
- restart OpenVPN
- restart Boundary auth
- start server tunnel
- stop server tunnel
- restart server tunnel
- restart server SSH

For server-targeted tunnel and SSH actions, the Admin UI uses the selected device's latest inventory summary instead of asking the user to type a raw server ID:

- start/stop/restart server tunnel shows a picker of Boundary-backed servers only
- restart server SSH shows a picker of all inventory servers
- `admin-next` can start server SSH sessions as browser-attached PTYs using the existing tunnel endpoint when the selected Boundary tunnel is already running.

In `admin-next`, the selected device's Runtime Summary tab shows direct “Start tunnel”, “Stop tunnel”, and “Restart tunnel” actions for Boundary-backed inventory servers based on the current runtime state.
Each server row owns a runtime drawer below the row. The drawer can show an xterm-based SSH terminal, the selected tunnel log tail, or tabs for both panes while keeping active SSH terminals mounted across tab switches. When Runtime Summary loads a server SSH status that is still running, `admin-next` rehydrates an existing browser PTY session or adopts the live local PTY from the agent, including recent scrollback, so the terminal attaches to the existing shell instead of starting from an empty state.

The `admin-next` Transfer Activity tab can start SCP uploads and downloads for servers from the selected device inventory. Operators choose a server, direction, local path, remote path, overwrite behavior, and transfer options; progress bars and recovery actions appear in the existing transfer queue. Transfer history is returned as `{ items: [...] }` from `GET /v1/file-transfers`, and live updates arrive from named `file_transfer` SSE events on `/v1/file-transfers/stream`.

## Enrollment flow

1. Start `cc-server`
2. Enroll a device via `POST /v1/enroll` using `CC_BOOTSTRAP_TOKEN`
3. Save returned:
   - `deviceId`
   - `ccAgentToken`
4. Configure the agent with those values

## Security notes

- Admin browser auth uses an HTTP-only session cookie
- Mobile/admin REST clients can use `Authorization: Bearer <token>`
- Admin API tokens can be server-minted, stored hashed at rest, listed in the Admin UI, and revoked individually
- `CC_ADMIN_API_TOKEN` remains available as an optional static bootstrap/back-compat token
- Login/logout are CSRF protected
- CSRF is required for browser-session mutations, but not for bearer-token admin API calls
- Admin secret is no longer passed in query params
- Stored agent tokens, admin sessions, and DB-backed admin API tokens are hashed at rest
- Sensitive endpoints are rate-limited

## Main endpoints

### Admin

- `GET /admin`
- `GET /admin/login`
- `POST /admin/login`
- `POST /admin/logout`
- `GET /admin/devices`
- `GET /admin/api-tokens`
- `POST /admin/api-tokens`
- `POST /admin/api-tokens/:tokenId/revoke`

### Device and telemetry APIs

- `POST /v1/enroll`
- `GET /v1/devices`
- `GET /v1/devices/:id`
- `POST /v1/devices/:id/request-status-snapshot`
- `POST /v1/devices/:id/request-inventory`
- `POST /v1/devices/:id/request-recent-logs`
- `POST /v1/devices/:id/request-restart-openvpn`
- `POST /v1/devices/:id/request-restart-boundary-auth`
- `POST /v1/devices/:id/request-start-server-tunnel`
- `POST /v1/devices/:id/request-stop-server-tunnel`
- `POST /v1/devices/:id/request-restart-server-tunnel`
- `POST /v1/devices/:id/request-restart-server-ssh`
- `GET /v1/devices/:id/tunnels/:serverId/logs`
- `POST /v1/logs`
- `GET /v1/logs`
- `GET /v1/logs/export`
- `GET /v1/device-summary`
- `GET /v1/log-settings`
- `GET /v1/logs/stream`

### Health

- `GET /v1/health`

## Auth modes by surface

- Browser Admin UI:
  - cookie session + CSRF
- Mobile/admin REST API:
  - `Authorization: Bearer <mintedToken>`
  - `Authorization: Bearer <CC_ADMIN_API_TOKEN>` also works when the optional env token is configured
- Agent transport / ingest:
  - `Authorization: Bearer <agentToken>`

## Admin API token scopes

DB-backed admin API tokens support these first-slice scopes:

- `device:read`
- `device:control`
- `logs:read`
- `logs:export`

Scope enforcement currently maps to the existing REST surface:

- `GET /v1/devices`, `GET /v1/devices/:id`, `GET /v1/device-summary` require `device:read`
- Device control requests require `device:control`
- `GET /v1/logs`, `GET /v1/logs/stream`, `GET /v1/log-settings` require `logs:read`
- `GET /v1/logs/export` requires `logs:export`
