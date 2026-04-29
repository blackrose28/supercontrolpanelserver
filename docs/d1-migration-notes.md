# D1 Migration Notes

## Architecture

### Current Design (NestJS + WebSocket)
- Agents establish persistent WebSocket connections to `/agent`
- Server pushes commands to agents via WebSocket
- Admin UI connects to PTY WebSockets

### D1/Cloudflare Workers Design
- **Agents:** Use polling model - agents POST to `/agent` with heartbeat + poll for new commands
- **Admin UI:** Uses WebSocket for PTY (short-lived, works in Workers)
- **Commands:** Stored in D1, agents poll for them via POST request

## Migration Strategy

### Phase 1: Command Polling
1. Agent connects and sends heartbeat via POST `/agent`
2. Server checks D1 for pending commands and returns them in response
3. Agent processes commands and sends ack/nack

### Phase 2: Admin PTY WebSocket
- PTY sessions work via WebSocket (short-lived)
- Admin can connect to PTY for console access

### Phase 3: Admin API (Completed)
- All admin REST API endpoints work via D1

## Implementation Changes

### Agent Endpoint (`/agent`)
- POST with body: `{ heartbeat: true, deviceId, agentToken, timestamp }`
- Response: `{ commands: [], heartbeatAck: true }`
- No WebSocket upgrade - polling only

### Admin PTY (`/admin/ws/pty`)
- Keep existing WebSocketGateway working
- Short-lived connections for PTY only

## Testing
- npm test: All 235 tests pass
- wrangler dev: Works for REST API, polling-based agent operations
- Production deploy: `npx wrangler deploy`

## Notes
- The current `/agent` WebSocket implementation in `src/worker/index.ts` doesn't work in wrangler dev with D1 due to wrangler's stricter type checking
- Agents must use polling for command delivery in D1 mode
- Admin WebSocket for PTY is fine - it's short-lived
