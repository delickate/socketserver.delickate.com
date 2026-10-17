# Socket server

Standalone Node.js + Socket.IO service for authenticated chat presence and
typing indicators. Laravel remains the source of truth for users, friendships,
conversations, messages, and read receipts.

## Run locally

Requirements: Node.js 20+, npm, and the Laravel API running at
`http://127.0.0.1:8000/api`.

```powershell
npm install
Copy-Item .env.example .env
npm start
```

The service listens on `http://localhost:3001` by default. Configure the
desktop client's **Socket.IO URL** as `http://127.0.0.1:3001`. Set
`LARAVEL_API_URL` to the Laravel API address ending in `/api`.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3001` | HTTP and Socket.IO listening port |
| `HOST` | `0.0.0.0` | Network interface to bind |
| `LARAVEL_API_URL` | `http://127.0.0.1:8000/api` | Laravel API base URL ending in `/api` |
| `CORS_ORIGINS` | Common local development origins | Comma-separated browser origins allowed to connect |
| `STUN_SERVER_URLS` | `stun:stun.l.google.com:19302` | Comma-separated STUN URLs sent to call-capable clients |
| `TURN_SERVER_URLS` | Empty | Optional comma-separated TURN/TURNS URLs |
| `TURN_SERVER_USERNAME` | Empty | TURN username; required with TURN URLs |
| `TURN_SERVER_CREDENTIAL` | Empty | TURN credential; required with TURN URLs |

Use HTTPS for both deployed services. Set browser origins to the exact
production origins; native desktop connections without an Origin header are
supported. Every connection still requires a valid Sanctum bearer token.
Set the TURN variables to your relay credentials to improve call connectivity.
The server sends ICE configuration only to authenticated, call-capable sockets.
Use short-lived TURN credentials where your relay supports them.

## Socket events

- Client connects with Socket.IO auth `{ token }`. The server validates the
  token through `GET /api/auth/socket-identity` and loads accepted friends from
  `GET /api/friends`.
- Server emits `presence:sync` with `{ user_id, is_online }[]` on connection and
  `presence:update` with `{ user_id, is_online }` to accepted friends when a
  user's first device comes online or last device goes offline.
- Client requests a room with `conversation:join` and
  `{ conversation_id }`. The server joins only after Laravel authorizes
  `GET /api/conversations/{id}/socket-access`.
- In an authorized room, clients can send `conversation:typing` and
  `conversation:stop-typing` with `{ conversation_id }`. The server derives
  the user ID from the authenticated socket, relays to other room members, and
  automatically clears stale typing state.
- Call-capable clients announce `call:ready` with `{ enabled: true }`. A caller
  sends `call:invite` with `{ call_id, conversation_id, target_user_id,
  media_type }`. The server verifies the caller is in the authorized one-to-one
  room, the target is the conversation peer and an accepted friend, and the
  target has a call-capable socket. The receiver responds with `call:accept` or
  `call:reject`; `call:signal` relays bounded WebRTC SDP/ICE payloads only
  between the two authenticated call participants. `call:cancel` and
  `call:end` release call state. Invitations expire after 30 seconds. Call
  signaling is ephemeral and does not store media or call history.
- The server responds to enabled clients with `call:config` and its
  `{ ice_servers }` list, built from the STUN/TURN environment settings.
- WebRTC media is peer-to-peer. Clients use a public STUN server for basic
  connectivity; configure `TURN_SERVER_URLS`, `TURN_SERVER_USERNAME`, and
  `TURN_SERVER_CREDENTIAL` for networks that block direct peer connections.
  Deploy the service over HTTPS/WSS; browsers require a secure context for
  microphone/camera access.
- `GET /health` returns `{"status":"ok"}`.

Typing and presence are ephemeral in-memory socket state; they are not stored
in Laravel. The current implementation is single-process. For a multi-instance
deployment, use a shared Socket.IO adapter and shared presence/typing storage.

## Tests

```powershell
npm test
```
