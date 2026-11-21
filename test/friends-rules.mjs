import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canStart, createRoom, doMove, doRoll, joinRoom, leaveRoom, setReady, setRoomVariant, startMatch } from '../dist/room.js'
import { HOME_STEP, createTokens, legalMoves } from '../dist/rules.js'

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
