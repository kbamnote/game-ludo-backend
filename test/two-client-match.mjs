import { io } from 'socket.io-client'
import assert from 'node:assert/strict'

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

const character = { model: 4, face: Buffer.alloc(64 * 64 * 3, 117).toString('base64'),
  fit: Buffer.from(Array.from({ length: 136 }, (_, i) => i + 15)).toString('base64') }
const created = await call(a, 'room:create', { character })
if (!created.ok) throw new Error('create failed: ' + created.error)
const code = created.snapshot.code
log('room created:', code)

const quick = await connect('Quick')
const guest = await connect('Guest')
const solo = await connect('Solo')
try {
  const first = await call(quick, 'room:quick', { table: 'duel' })
  const second = await call(guest, 'room:quick', { table: 'duel' })
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.notEqual(first.snapshot.code, code)
  assert.equal(second.snapshot.code, first.snapshot.code)
  assert.equal(second.snapshot.members.length, 2)
  assert.equal(second.snapshot.size, 2)
  // Two at a table face each other.
  assert.deepEqual(second.snapshot.members.map((m) => m.seat), [0, 2])
  const repeat = await call(guest, 'room:quick', { table: 'duel' })
  assert.equal(repeat.snapshot.members.length, 2)
  log('public players paired in a separate room')

  // Someone asking for a different table is never dealt into this one.
  const apart = await call(solo, 'room:quick', { table: 'teams' })
  assert.equal(apart.ok, true)
  assert.notEqual(apart.snapshot.code, first.snapshot.code)
  assert.equal(apart.snapshot.size, 4)
  assert.equal(apart.snapshot.variant, 'teams')
  log('a different table is a different room')

  // Nobody taps ready and nobody taps start: a full public table plays itself.
  const playing = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('The full public table did not start itself')), 6000)
    quick.on('match:started', snapshot => { clearTimeout(timeout); resolve(snapshot) })
  })
  assert.equal(playing.phase, 'playing')
  assert.equal(playing.members.length, 2)
  log('full public table started itself')

  // The one-player Team Up table waits, then sits bots in the empty seats.
  const filled = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('The waiting table never filled with bots')), 25000)
    solo.on('match:started', snapshot => { clearTimeout(timeout); resolve(snapshot) })
  })
  assert.equal(filled.members.length, 4)
  assert.equal(filled.members.filter((m) => m.bot).length, 3)
  log('bots filled the empty seats and the match began')
} finally {
  quick.close()
  guest.close()
  solo.close()
}

const joined = await call(b, 'room:join', { code, character: { model: 1, face: 'invalid texture' } })
if (!joined.ok) throw new Error('join failed: ' + joined.error)
assert.deepEqual(joined.snapshot.members.map(member => member.seat), [0, 2])
log('bravo joined; members:', joined.snapshot.members.map((m) => `${m.name}@seat${m.seat}`).join(', '))

// Reject a bad code and a duplicate-seat overflow path
const bad = await call(b, 'room:join', { code: '000000' })
log('bad code rejected:', bad.ok === false, '-', bad.error)

assert.equal((await call(b, 'room:variant', { variant: 'quick' })).ok, false)
assert.equal((await call(a, 'room:variant', { variant: 'quick' })).snapshot.variant, 'quick')
assert.equal((await call(a, 'room:variant', { variant: 'teams' })).snapshot.variant, 'teams')
assert.match((await call(a, 'room:start')).error, /4 players/)
assert.equal((await call(a, 'room:variant', { variant: 'classic' })).snapshot.variant, 'classic')

b.emit('room:ready', { ready: true })
a.emit('room:ready', { ready: true })
await new Promise((r) => setTimeout(r, 150))

const appearances = Promise.all([a, b].map(s => new Promise(resolve => s.once('match:started', resolve))))
const started = await call(a, 'room:start')
if (!started.ok) throw new Error('start failed: ' + started.error)
log('match started')
const matchStartSnapshots = await appearances
for (const match of matchStartSnapshots) {
  assert.deepEqual(match.members[0].character, character)
  assert.equal(match.members[1].character, undefined)
}
const restored = new Promise(resolve => b.once('match:started', resolve))
await call(b, 'room:join', { code })
assert.deepEqual((await restored).members[0].character, character)
assert.ok(latest().members.every(member => !('character' in member)))

// Non-host cannot start, and a seat cannot act out of turn
const notHost = await call(b, 'room:start')
log('non-host start blocked:', notHost.ok === false)

const sockets = { 0: a, 2: b }
const opening = matchStartSnapshots[0].match
assert.equal(opening.opensAt, matchStartSnapshots[1].match.opensAt)
if (opening.opensAt > Date.now()) {
  const early = await call(sockets[opening.current], 'match:roll')
  assert.match(early.error, /countdown/)
  await new Promise(resolve => setTimeout(resolve, Math.max(0, opening.opensAt - Date.now()) + 30))
}
await new Promise((r) => setTimeout(r, 200))

let turns = 0
let moves = 0
let forced = false
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
    if (ids.length === 1 && !forced) {
      const results = await Promise.all([a, b].map(client => new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('The sole legal move was not played automatically')), 2200)
        client.once('match:moved', moved => { clearTimeout(timeout); resolve(moved) })
      })))
      for (const moved of results) assert.equal(moved.tokenId, ids[0])
      forced = true
      moves++
      continue
    }
    const r = await call(s, 'match:move', { tokenId: ids[0] })
    if (!r.ok) { log('move rejected:', r.error); break }
    moves++
  }
  await new Promise((r) => setTimeout(r, 12))
}

const fin = latest()
assert.ok(forced, 'the match should broadcast one forced move to both clients')
log(`\nplayed ${turns} rolls / ${moves} moves`)
log('match phase:', fin?.match?.phase)
log('tokens home:', fin?.match?.tokens.filter((t) => t.progress === 56).length)
log('ranking:', fin?.match?.ranking)
const sum = fin?.match?.tokens.reduce((n, t) => n + (t.progress < 0 ? 0 : t.progress), 0)
log('total progress across all tokens:', sum)
log('token count still 8:', fin?.match?.tokens.length === 8)

a.close(); b.close()
process.exit(0)
