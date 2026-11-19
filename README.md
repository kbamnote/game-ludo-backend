# CGP - Cockroach Game Party — room server

### Voice Adda

The same server serves the embedded lounge at `/voice/` and relays live audio
through the Socket.IO `/voice` namespace. Deploy the `voice/` directory alongside
`dist/` and use HTTPS with WebSocket upgrades. A room holds up to four sockets
and disappears when empty. Each unmuted device sends about 48 KB/s of mono PCM
before transport overhead. The service forwards frames only to the other
members of the room and never writes audio to disk.

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

### MetaPerson avatar generation

Configure `METAPERSON_CLIENT_ID` and `METAPERSON_CLIENT_SECRET` on the server
using an Avatar SDK Client Access application with the client-credentials grant
and MetaPerson REST entitlement. The Expo project needs only its existing game
server URL. Mount persistent storage at `AVATAR_DATA_DIR` (default
`./avatar-data`) for model files, generation handles and daily usage. A single
server instance handles jobs. `METAPERSON_DAILY_LIMIT` defaults to three new
submissions per UTC day. A repeat of the same portrait and outfit reuses its
job. A pending generation resumes when the player reopens the creator.

The mobile creator uses MetaPerson 2.1 full-body outfits returned by the
provider for the selected body style. [Provider export contract](https://api.avatarsdk.com/samples/curl_metaperson_21/).

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

### Why the build command looks like that

`railway.json` builds with:

```
npm install --include=dev --no-audit --no-fund && npm run build
```

Two reasons, both learned from a failed deploy:

1. **Not `npm ci`.** Nixpacks already runs `npm ci` in its own install phase.
   Running it again in the build phase makes npm try to delete `node_modules`,
   which fails against the mounted build cache:
   `EBUSY: resource busy or locked, rmdir '/app/node_modules/.cache'`.
   `npm install` reconciles in place instead of wiping the tree.

2. **`--include=dev`.** Railway installs with npm's production config, so
   `typescript` is skipped and `npm run build` dies with
   `'tsc' is not recognized`. The flag pulls devDependencies back in for the
   build only; the runtime image still starts from `dependencies` alone.

## Privacy policy

`GET /privacy` serves the policy Play Console requires. It is written to match
what the app actually does — a generated device id and a chosen nickname, held
in memory only — so keep it in step with the Data Safety answers if that
changes.

The contact address defaults to the owner's. Override it by setting
`CONTACT_EMAIL` in the Railway service variables.
