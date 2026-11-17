# Ludo After Dark — room server

Authoritative multiplayer server for private friend rooms. Node + Socket.IO.

The server runs the **same rules engine as the app** (`src/rules.ts` is a copy of
the client's) and owns the dice, so a tampered client cannot roll its own
numbers or make an illegal move.

```bash
npm install
npm run build
npm start          # listens on $PORT, default 8080

npm run typecheck
npm test           # two headless clients play a full match (server must be running)
```

`GET /health` returns `{ ok: true, ... }` for uptime checks.

## Deploying to Railway

Railway keeps the service awake, unlike free tiers that sleep and make the
first tester wait for a cold start.

**Without GitHub** — from this folder:

```bash
npx @railway/cli login
npx @railway/cli init
npx @railway/cli up
npx @railway/cli domain
```

The last command prints a public URL like `https://ludo-production.up.railway.app`.

**With GitHub:** push the repo, then New Project → Deploy from GitHub repo, and
set the root directory to `backend-ludo`.

Railway injects `PORT` automatically — do not set it yourself. `railway.json`
pins the build and start commands and points the healthcheck at `/health`.

### Then point the app at it

In `mobile-ludo/app.json`, set `expo.extra.serverUrl` to that URL, or set
`EXPO_PUBLIC_SERVER_URL` when building. The Friends screen prints the server it
is using at the bottom, which makes a misconfigured build obvious.

## Protocol

Client to server:

| Event | Payload | Notes |
|---|---|---|
| `identify` | `{ playerId, name }` | Must be first; playerId is the device id |
| `room:create` | — | Creator takes seat 0 and is auto-ready |
| `room:join` | `{ code }` | 6 digits; same playerId rejoining is a reconnect |
| `room:ready` | `{ ready }` | |
| `room:start` | — | Host only, needs 2+ players all ready |
| `room:leave` | — | |
| `match:roll` | — | Server rolls; a client-supplied value is impossible |
| `match:move` | `{ tokenId }` | Validated against the server's legal-move list |

Server to client:

| Event | Payload |
|---|---|
| `room:state` | Full room snapshot |
| `match:started` | Snapshot at kickoff |
| `match:rolled` | `{ seat, die, movableTokenIds, passed }` |
| `match:moved` | `{ seat, tokenId, path, captures, snapshot }` |
| `match:ended` | `{ ranking }` |

Clients animate `path` from `match:moved`, then adopt the snapshot that came
with it — so every device shows the same board without trusting any of them.

## Behaviour worth knowing

**Turn clock.** A seat has 20s to act. When it expires the server rolls or picks
a move for them (preferring a capture, then the furthest advance). One tester
losing signal or backgrounding the app cannot freeze everyone else's room.

**Disconnects.** In the lobby, leaving frees the seat and passes the host role
on. Mid-match the seat is held so the player can reconnect with the same
playerId and resume; the turn clock covers their absence meanwhile.

**Room lifetime.** Rooms with nobody connected are swept after 30 minutes.

**State is in memory.** A redeploy drops active rooms. That is fine for testing;
a persistent store would be the next step before a real launch.
