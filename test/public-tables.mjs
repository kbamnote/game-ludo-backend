import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BOT_THINK_MS,
  TURN_MS,
  canStart,
  createRoom,
  doRoll,
  fillWithBots,
  humansOf,
  isBotSeat,
  joinRoom,
  readTableKind,
  snapshot,
  startMatch,
} from '../dist/room.js'

/** A public table of the given kind, with `players` real people in it. */
function publicTable(kind, players = 1, entry = 100) {
  const table = readTableKind(kind)
  const room = createRoom('host', 'Host', true, undefined, entry, table)
  for (let index = 1; index < players; index++) {
    const id = 'player-' + index
    assert.equal(joinRoom(room.code, id, id, 'socket-' + index).ok, true)
  }
  return room
}

test('the lobby offers three tables and refuses anything else', () => {
  assert.deepEqual(readTableKind('duel'), { size: 2, variant: 'classic' })
  assert.deepEqual(readTableKind('classic'), { size: 4, variant: 'classic' })
  assert.deepEqual(readTableKind('teams'), { size: 4, variant: 'teams' })
  // An older client sends nothing and still gets the table it expects.
  assert.deepEqual(readTableKind(undefined), { size: 4, variant: 'classic' })
  assert.equal(readTableKind('quick'), undefined)
  assert.equal(readTableKind(2), undefined)
})

test('a two-seat table sits the pair opposite each other and then calls itself full', () => {
  const room = publicTable('duel', 2)
  assert.equal(room.size, 2)
  assert.deepEqual(room.members.map(member => member.seat), [0, 2])
  // Nobody queues for a public table by accident, so nobody has to tap ready.
  assert.equal(room.members.every(member => member.ready), true)
  assert.equal(canStart(room), null)
  const third = joinRoom(room.code, 'late', 'Late', 'socket-late')
  assert.deepEqual(third, { ok: false, error: 'Room is full' })
})

test('bots fill whatever seats are left, and a filled table can start', () => {
  const duel = publicTable('duel')
  fillWithBots(duel)
  assert.equal(duel.members.length, 2)
  assert.deepEqual(duel.members.map(member => member.seat), [0, 2])
  assert.equal(duel.members[1].bot, true)
  assert.equal(isBotSeat(duel, 2), true)
  assert.equal(isBotSeat(duel, 0), false)
  assert.equal(canStart(duel), null)

  // Team Up needs all four, which is exactly what the bots make up.
  const teams = publicTable('teams', 2)
  assert.equal(canStart(teams), 'Team Up needs 4 players')
  fillWithBots(teams)
  assert.equal(teams.members.length, 4)
  assert.equal(humansOf(teams).length, 2)
  assert.equal(canStart(teams), null)
  // Every bot gets its own name, so the seat list never reads as a duplicate.
  const names = teams.members.map(member => member.name)
  assert.equal(new Set(names).size, names.length)
})

test('bots are not in the pot, and a table of only bots is not somebody playing', () => {
  const room = publicTable('classic', 2, 300)
  fillWithBots(room)
  assert.equal(snapshot(room).prize, 600, 'only the two people paid in')
  startMatch(room)
  assert.equal(room.prize, 600)

  // A bot holds a seat but is nobody's connection.
  assert.equal(room.members.filter(member => member.bot).every(member => member.socketId === null), true)
  for (const member of humansOf(room)) member.connected = false
  assert.equal(room.members.some(member => member.connected && !member.bot), false,
    'with the people gone the room counts as empty, so it can be swept')
})

test('a bot is on a much shorter turn clock than a person', t => {
  let now = 50_000
  t.mock.method(Date, 'now', () => now)
  t.mock.method(Math, 'random', () => 0)
  const room = publicTable('duel')
  fillWithBots(room)
  const match = startMatch(room, now)

  // Seat 0 is the person: a full clock to think in.
  assert.equal(match.current, 0)
  assert.equal(match.deadline, now + TURN_MS)

  // A one leaves every pawn in the yard, so the turn passes straight to the
  // bot — and the clock shortens the moment it does.
  assert.deepEqual(doRoll(room, 0), { die: 1, moves: [], passed: true })
  assert.equal(match.current, 2)
  assert.equal(match.deadline, now + BOT_THINK_MS)

  // Rolling for the bot keeps it on its own clock rather than the long one.
  const rolled = doRoll(room, 2)
  assert.equal(rolled.die, 1)
  assert.equal(match.current, 0, 'and the person gets their full clock back')
  assert.equal(match.deadline, now + TURN_MS)
})
