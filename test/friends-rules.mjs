import assert from 'node:assert/strict'
import { test } from 'node:test'
import { activeRoomFor, canStart, createRoom, doMove, doRoll, eliminateSeat, joinRoom, leaveRoom, markDisconnected, missRoll, setReady, setRoomVariant, snapshot, startMatch } from '../dist/room.js'
import { HOME_STEP, createTokens, legalMoves } from '../dist/rules.js'
import { TURN_MS } from '../dist/room.js'

function roomWith(players, variant = 'classic') {
  const room = createRoom('host', 'Host')
  assert.equal(setRoomVariant(room, 'host', variant), null)
  for (let index = 1; index < players; index++) {
    const id = 'player-' + index
    assert.equal(joinRoom(room.code, id, id, 'socket-' + index).ok, true)
    setReady(room, id, true)
  }
  return room
}

test('the shared match countdown protects the first roll and preserves a full turn', t => {
  let now = 1000
  t.mock.method(Date, 'now', () => now)
  const room = roomWith(2)
  const opensAt = now + 3750
  const match = startMatch(room, opensAt)
  assert.equal(snapshot(room).match.opensAt, opensAt)
  assert.equal(match.deadline, opensAt + TURN_MS)
  assert.match(doRoll(room, match.current).error, /countdown/)
  assert.equal(missRoll(room), false)
  now = opensAt
  assert.equal(typeof doRoll(room, match.current).die, 'number')
})

test('only consecutive missed dice rolls eliminate the player and clear their pawns', t => {
  t.mock.method(Math, 'random', () => 0)
  const room = roomWith(2)
  const match = startMatch(room)
  const [first, second] = match.seats
  function miss(seat) {
    match.current = seat
    match.phase = 'await-roll'
    match.deadline = 0
    if (missRoll(room)) return true
    assert.equal(doRoll(room, seat, false).die, 1)
    return false
  }
  assert.equal(miss(first), false)
  assert.equal(match.missedRolls[first], 1)
  match.current = first
  assert.equal(doRoll(room, first).die, 1)
  assert.equal(match.missedRolls[first], 0)
  for (let i = 0; i < 4; i++) assert.equal(miss(first), false)
  assert.equal(miss(first), true)
  assert.equal(room.phase, 'finished')
  assert.deepEqual(match.ranking, [second])
  assert.deepEqual(snapshot(room).match.eliminated, [first])
  assert.ok(match.tokens.every(token => token.seat === second))
})

test('a suspended account still has its live seat, and an eliminated account cannot resume as a player', () => {
  const first = 'acct-resume-host'
  const second = 'acct-resume-guest'
  const room = createRoom(first, 'Host')
  assert.equal(joinRoom(room.code, second, 'Guest', 'resume-guest').ok, true)
  startMatch(room)
  markDisconnected('resume-guest')
  const saved = activeRoomFor(second)
  assert.equal(saved?.code, room.code)
  const seat = saved.members.find(member => member.playerId === second).seat
  assert.equal(joinRoom(room.code, second, 'Guest', 'resume-new').ok, true)
  assert.equal(room.members.find(member => member.socketId === 'resume-new').seat, seat)
  eliminateSeat(room, seat)
  assert.equal(activeRoomFor(second), undefined)
})

test('Team Up gives the prize places to the surviving team after eliminations', () => {
  const room = roomWith(4, 'teams')
  const match = startMatch(room)
  assert.equal(eliminateSeat(room, 0), true)
  assert.equal(room.phase, 'playing')
  assert.equal(eliminateSeat(room, 2), true)
  assert.equal(room.phase, 'finished')
  assert.deepEqual(match.ranking, [1, 3])
})

test('two remaining Friends players sit opposite each other after the host leaves', () => {
  const room = roomWith(3)
  leaveRoom(room, 'host')
  assert.equal(room.hostId, 'player-1')
  assert.deepEqual(room.members.map(member => member.seat), [2, 0])
  assert.deepEqual(startMatch(room).seats, [0, 2])
})

test('Quick ends as soon as a single character makes it home', t => {
  const room = roomWith(2, 'quick')
  t.mock.method(Math, 'random', () => 0)
  assert.equal(canStart(room), null)
  const match = startMatch(room)
  const token = match.tokens[0]
  token.progress = HOME_STEP - 1
  assert.equal(doRoll(room, 0).moves.length, 1)
  assert.equal(doMove(room, 0, token.id).ended, true)
  assert.deepEqual(match.ranking, [0])
})

test('Friends pauses the next turn for the gold throne shot and keeps silver shorter', t => {
  const room = roomWith(4)
  t.mock.method(Math, 'random', () => 0)
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const match = startMatch(room)
  for (const [seat, duration] of [[0, 12_500], [1, 8_600]]) {
    const tokens = match.tokens.filter(token => token.seat === seat)
    tokens.forEach(token => { token.progress = HOME_STEP })
    tokens[0].progress--
    match.current = seat
    assert.equal(doRoll(room, seat).moves.length, 1)
    assert.equal(doMove(room, seat, tokens[0].id).ended, false)
    assert.equal(match.coronationUntil, now + 280 + duration)
    now = match.coronationUntil - 1
    assert.match(doRoll(room, match.current).error, /coronation/)
    now++
  }
})

test('Team Up allows shared tiles with a partner and needs both partners to finish', t => {
  const tokens = createTokens([0, 1, 2, 3])
  const mover = tokens.find(token => token.seat === 0)
  const partner = tokens.find(token => token.seat === 2)
  const enemy = tokens.find(token => token.seat === 1)
  mover.progress = 14
  partner.progress = 41
  enemy.progress = 2
  assert.deepEqual(legalMoves(tokens, 0, 1, true)[0].captures, [enemy.id])
  assert.ok(legalMoves(tokens, 0, 1)[0].captures.includes(partner.id))

  const room = roomWith(4, 'teams')
  t.mock.method(Math, 'random', () => 0)
  assert.equal(canStart(room), null)
  const match = startMatch(room)
  const red = match.tokens.filter(token => token.seat === 0)
  const yellow = match.tokens.filter(token => token.seat === 2)
  red.forEach(token => { token.progress = HOME_STEP })
  red[0].progress = HOME_STEP - 1
  assert.equal(doRoll(room, 0).moves.length, 1)
  assert.equal(doMove(room, 0, red[0].id).ended, false)
  yellow.forEach(token => { token.progress = HOME_STEP })
  yellow[0].progress = HOME_STEP - 1
  match.current = 2
  assert.equal(doRoll(room, 2).moves.length, 1)
  assert.equal(doMove(room, 2, yellow[0].id).ended, true)
  assert.deepEqual(match.ranking, [2, 0])
})
