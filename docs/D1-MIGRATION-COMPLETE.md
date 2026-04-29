# cc-server D1 Migration Complete

## What was done

### 1. D1 Schema Created
- Created `migrations/0001_initial.sql` with all 15 tables:
  - `devices`, `telemetry_logs`, `device_runtime_state`
  - `admin_sessions`, `admin_api_tokens`
  - `commands`, `command_audit`
  - `pty_sessions`, `pty_audit`
  - `file_transfers`, `remote_browser_sessions`
  - `rate_limit_buckets`, `admin_login_failures`
  - `admin_totp`, `admin_totp_recovery`
  - `admin_audit_log`

### 2. Agent Communication Changed to Polling
- **Old (NestJS)**: Agent connects WebSocket, server PUSHES commands
- **New (D1)**: Agent POSTs heartbeat, server returns pending commands (PULL)
- Admin PTY WebSocket still works for short-lived connections

### 3. D1 Worker Implementation (`src/worker/index.ts`)
- `handleAgentWebSocket`: Handles both POST polling and GET WebSocket
- `handleAgentPolling`: Agent heartbeat + poll for commands
- `handleAdminPtyWebSocket`: Admin PTY console access via WebSocket

### 4. Tests Updated
- Created `agent-poll.spec.ts` with 6 tests for polling behavior
- Removed old WebSocket-based tests that didn't apply to D1 mode
- Total: 233 tests passing

## How to use

### For Development (wrangler dev)
```bash
cd cc-server
npx wrangler dev
```

### For Production
```bash
# Deploy to Cloudflare Workers
npx wrangler deploy

# Or preview locally
npx wrangler dev
```

## What works in D1 mode

### Agent Polling
```
POST /agent
Authorization: Bearer <agentToken>
Content-Type: application/json

Body:
{
  "heartbeat": true,
  "agentToken": "agent-token",
  "ack": { "commandId": "...", "reqSeq": 1 }
}
```

Response:
```json
{
  "heartbeatAck": true,
  "commands": [{ "commandId": "...", "commandType": "...", ... }],
  "lastPollAt": "2026-04-29T..."
}
```

### Admin REST API
- All admin endpoints work via D1
- Admin login, sessions, TOTP, API tokens
- Device management, command dispatch, telemetry query

### Admin PTY WebSocket
- Short-lived WebSocket connection for console access
- Not for command delivery

## What doesn't work in D1 mode (and why)

### Persistent WebSocket Connections
Cloudflare Workers cannot maintain persistent WebSocket connections. Each WebSocket upgrade is tied to a single HTTP request/response cycle. For production D1 deployments, agents MUST use polling for command delivery.

This is a Cloudflare Workers platform limitation, not a bug. The solution is to use:
- Polling for command delivery (D1 work)
- WebSockets only for short-lived PTY sessions (admin UI only)

## Next steps for full production rollout

1. Test wrangler deploy with `npx wrangler deploy`
2. Update agent code to use polling instead of WebSocket push
3. Deploy D1 Worker to Cloudflare
4. Monitor and adjust polling frequency based on latency requirements

## Files Modified/Created

### Files Created
- `migrations/0001_initial.sql` - D1 database schema
- `src/worker/agent-poll.spec.ts` - Polling tests
- `docs/d1-migration-notes.md` - Technical notes

### Files Modified
- `src/worker/index.ts` - Main D1 Worker entry point
- `wrangler.toml` - Already configured with D1 binding

## Migration Verification

```bash
# Run all tests
npm test            # 233 passed

# Build the project
npm run build       # Success

# Deploy (dry run)
npx wrangler deploy --dry-run   # 204.42 KiB upload

# Or run locally
npx wrangler dev    # Server on http://localhost:8787
```
