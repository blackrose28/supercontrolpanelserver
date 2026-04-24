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

In `admin-next`, the selected device’s Runtime Summary tab now shows direct “Start tunnel”, “Stop tunnel”, and “Restart tunnel” actions for Boundary-backed inventory servers based on the current runtime state.
That same Runtime Summary tab can also open a dedicated tunnel log tail for a selected Boundary tunnel, sourced from the tunnel PTY output for the current session.

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
