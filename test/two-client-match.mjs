import { io } from 'socket.io-client'

const URL = process.env.URL ?? 'http://localhost:8080'
const log = (...a) => console.log(...a)

function connect(name) {
  return new Promise((resolve) => {
    const s = io(URL, { transports: ['websocket'] })
    s.on('connect', () => s.emit('identify', { playerId: `pid-${name}`, name }, () => resolve(s)))
  })
}
const call = (s, ev, payload = {}) => new Promise((r) => s.emit(ev, payload, r))

const a = await connect('Alpha')
const b = await connect('Bravo')

let state = null
const latest = () => state
for (const s of [a, b]) s.on('room:state', (snap) => { state = snap })

const created = await call(a, 'room:create')
if (!created.ok) throw new Error('create failed: ' + created.error)
const code = created.snapshot.code
log('room created:', code)

const joined = await call(b, 'room:join', { code })
if (!joined.ok) throw new Error('join failed: ' + joined.error)
log('bravo joined; members:', joined.snapshot.members.map((m) => `${m.name}@seat${m.seat}`).join(', '))

// Reject a bad code and a duplicate-seat overflow path
const bad = await call(b, 'room:join', { code: '000000' })
log('bad code rejected:', bad.ok === false, '-', bad.error)

b.emit('room:ready', { ready: true })
a.emit('room:ready', { ready: true })
await new Promise((r) => setTimeout(r, 150))

const started = await call(a, 'room:start')
if (!started.ok) throw new Error('start failed: ' + started.error)
log('match started')

// Non-host cannot start, and a seat cannot act out of turn
const notHost = await call(b, 'room:start')
log('non-host start blocked:', notHost.ok === false)

const seatOf = { Alpha: 0, Bravo: 1 }
const sockets = { 0: a, 1: b }
await new Promise((r) => setTimeout(r, 200))

let turns = 0
let moves = 0
const deadline = Date.now() + 25000

while (Date.now() < deadline && turns < 400) {
  const snap = latest()
  if (!snap?.match || snap.match.phase === 'ended') break
  const seat = snap.match.current
  const s = sockets[seat]
  if (!s) break

  if (snap.match.phase === 'await-roll') {
    const r = await call(s, 'match:roll')
    if (!r.ok) { log('roll rejected:', r.error); break }
    turns++
  } else if (snap.match.phase === 'await-move') {
    const ids = snap.match.movableTokenIds
    if (!ids.length) { await new Promise((r) => setTimeout(r, 30)); continue }
    const r = await call(s, 'match:move', { tokenId: ids[0] })
    if (!r.ok) { log('move rejected:', r.error); break }
    moves++
  }
  await new Promise((r) => setTimeout(r, 12))
}

const fin = latest()
log(`\nplayed ${turns} rolls / ${moves} moves`)
log('match phase:', fin?.match?.phase)
log('tokens home:', fin?.match?.tokens.filter((t) => t.progress === 56).length)
log('ranking:', fin?.match?.ranking)
const sum = fin?.match?.tokens.reduce((n, t) => n + (t.progress < 0 ? 0 : t.progress), 0)
log('total progress across all tokens:', sum)
log('token count still 8:', fin?.match?.tokens.length === 8)

a.close(); b.close()
process.exit(0)
