import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  GOAL,
  LADDERS,
  SNAKES,
  SQUARES,
  START,
  applyMove,
  createTokens,
  grantsExtraTurn,
  hasWon,
  legalMoves,
  rideFor,
  tokensHome,
  walkPath,
} from '../dist/snakes.js'

const seats = [0, 1]
const only = (tokens, seat, die) => {
  const moves = legalMoves(tokens, seat, die)
  assert.ok(moves.length > 0, `expected a move for seat ${seat} on a ${die}`)
  return moves[0]
}

test('every seat starts with one pawn waiting off the board', () => {
  const tokens = createTokens(seats)
  assert.equal(tokens.length, 2)
  assert.equal(tokens.every(token => token.progress === START), true)
  assert.equal(legalMoves(tokens, 0, 1).length, 1)
  assert.equal(legalMoves(tokens, 0, 1).every(move => move.entersBoard), true)
})

test('a character only comes out on a one, and comes out onto square 1', () => {
  const tokens = createTokens(seats)
  for (const die of [2, 3, 4, 5, 6]) {
    assert.deepEqual(legalMoves(tokens, 0, die), [],
      `a ${die} should leave a waiting character where it is`)
  }
  const out = only(tokens, 0, 1)
  assert.equal(out.entersBoard, true)
  assert.equal(out.landing, 1)
  assert.equal(out.to, 1)
  // Square 1 has to stay clear of both, or every character would be carried
  // off the moment it came out.
  assert.equal(LADDERS.has(1), false)
  assert.equal(SNAKES.has(1), false)

  // Once it is on the board every die moves it, including another one.
  const moving = applyMove(tokens, out)
  for (const die of [1, 2, 3, 4, 5, 6]) {
    assert.equal(legalMoves(moving, 0, die).length, 1,
      `a ${die} should move a character that is already out`)
  }
})

test('the board is the classic one, and no square is both a snake and a ladder', () => {
  assert.equal(SQUARES, 100)
  assert.equal(GOAL, 100)
  for (const [foot, top] of LADDERS) {
    assert.ok(top > foot, `ladder ${foot}->${top} should climb`)
    assert.equal(SNAKES.has(foot), false, `square ${foot} is both a ladder foot and a snake head`)
  }
  for (const [head, tail] of SNAKES) {
    assert.ok(tail < head, `snake ${head}->${tail} should fall`)
  }
  // 80 is the one ladder that wins the game outright.
  assert.equal(LADDERS.get(80), GOAL)
})

test('a ladder carries the pawn up and a snake drops it, both in one move', () => {
  const tokens = createTokens(seats)
  // A one brings the character out onto square 1, which carries nothing.
  const entry = only(tokens, 0, 1)
  assert.equal(entry.landing, 1)
  assert.equal(entry.to, 1)
  assert.equal(entry.ride, null)

  // Another one steps it onto square 2 — the foot of the long ladder.
  const climb = only(applyMove(tokens, entry), 0, 1)
  assert.equal(climb.landing, 2)
  assert.equal(climb.to, 38)
  assert.deepEqual(climb.ride, { kind: 'ladder', from: 2, to: 38 })

  // Walk a pawn to 15, then a one puts its head in the snake at 16.
  const at15 = applyMove(tokens, { ...entry, to: 15, landing: 15, ride: null })
  const bitten = only(at15, 0, 1)
  assert.equal(bitten.landing, 16)
  assert.equal(bitten.to, 6)
  assert.equal(bitten.ride.kind, 'snake')

  // The pawn walks the squares in between, then rides; the ride is not walked.
  assert.deepEqual(walkPath(15, 16), [16])
  assert.deepEqual(walkPath(0, 4), [1, 2, 3, 4])
})

test('the goal has to be rolled exactly, and overshooting is not a move at all', () => {
  const tokens = createTokens(seats).map(token =>
    token.id === '0-0' ? { ...token, progress: 97 } : token)
  // 97 + 4 would be 101: that pawn cannot move, so the player must pass.
  const four = legalMoves(tokens, 0, 4)
  assert.equal(four.some(move => move.tokenId === '0-0'), false)
  assert.equal(four.length, 0)

  const home = legalMoves(tokens, 0, 3).find(move => move.tokenId === '0-0')
  assert.equal(home.to, GOAL)
  assert.equal(home.finishes, true)

  // A pawn already home is done and is never offered again.
  const finished = applyMove(tokens, home)
  assert.equal(tokensHome(finished, 0), 1)
  assert.equal(legalMoves(finished, 0, 3).some(move => move.tokenId === '0-0'), false)
})

test('a square 98 roll is a snake, not a win', () => {
  const tokens = createTokens(seats).map(token =>
    token.id === '0-0' ? { ...token, progress: 97 } : token)
  const move = legalMoves(tokens, 0, 1).find(entry => entry.tokenId === '0-0')
  assert.equal(move.landing, 98)
  assert.equal(move.to, 78)
  assert.equal(move.finishes, false)
  assert.equal(rideFor(98).kind, 'snake')
})

test('a six rolls again, a finish rolls again, and nothing else does', () => {
  const tokens = createTokens(seats)
  const plain = only(applyMove(tokens, only(tokens, 0, 1)), 0, 2)
  assert.equal(grantsExtraTurn(6, plain), true)
  assert.equal(grantsExtraTurn(2, plain), false)
  assert.equal(grantsExtraTurn(6, null), true)
  assert.equal(grantsExtraTurn(3, null), false)
  assert.equal(grantsExtraTurn(3, { ...plain, finishes: true }), true)
})

test('the seat wins only when its pawn reaches square 100', () => {
  let tokens = createTokens(seats)
  assert.equal(hasWon(tokens, 0), false)
  tokens = tokens.map(token => (token.seat === 0 ? { ...token, progress: GOAL } : token))
  assert.equal(hasWon(tokens, 0), true)
  assert.equal(hasWon(tokens, 1), false)
  // Nobody is ever captured, so a move never sends anyone back.
  assert.equal(legalMoves(createTokens(seats), 0, 3).every(move => move.captures.length === 0), true)
})

/* ── the room layer, shared with Ludo ── */
import { createRoom, doMove, doRoll, fillWithBots, joinRoom, snapshot, startMatch } from '../dist/room.js'
import { SNAKES_VICTORY_MS, walkMs } from '../dist/games.js'

/**
 * Rooms get a random six-digit code and retry until it is unused, so the
 * dice mock has to go in after the room exists or that loop never ends.
 */
function twoSeatRoom(game) {
  const room = game === 'snakes'
    ? createRoom('host', 'Host', false, undefined, 0, { size: 4, variant: 'classic' }, 'snakes')
    : createRoom('host', 'Host')
  assert.equal(joinRoom(room.code, 'p1', 'P1', 'socket-' + room.code).ok, true)
  return room
}

test('a snakes room plays through the same room machinery as a ludo one', t => {
  const room = twoSeatRoom('snakes')
  assert.equal(room.game, 'snakes')
  assert.equal(snapshot(room).game, 'snakes')
  t.mock.method(Math, 'random', () => 0)   // every roll is a one

  const match = startMatch(room, 0)
  assert.equal(match.tokens.length, 2)
  assert.equal(match.tokens.every(token => token.progress === START), true,
    'snakes pawns start on the pad, not in a yard')

  const rolled = doRoll(room, match.current)
  assert.equal(rolled.die, 1)
  assert.equal(rolled.moves.length, 1, 'a one is what brings the pawn out')

  const moved = doMove(room, match.current, rolled.moves[0].tokenId)
  // The pawn walks only as far as the die took it, and square 1 is bare.
  assert.deepEqual(moved.path, [1])
  assert.equal(moved.ride, null)
  assert.equal(moved.captures.length, 0, 'nobody is ever captured in snakes')
  assert.equal(match.tokens.find(token => token.id === moved.tokenId).progress, 1)
})

test('Square 100 pauses the next roll for the first winner in a four-player match', t => {
  const room = twoSeatRoom('snakes')
  fillWithBots(room)
  const match = startMatch(room, 0)
  const seat = match.current
  const pawn = match.tokens.find(token => token.seat === seat)
  pawn.progress = 98
  t.mock.method(Math, 'random', () => .2)
  const now = 50_000
  const clock = t.mock.method(Date, 'now', () => now)
  assert.equal(doRoll(room, seat).die, 2)
  const move = doMove(room, seat, pawn.id)
  assert.equal(move.ended, false)
  assert.equal(match.ranking[0], seat)
  assert.equal(match.coronationUntil, now + walkMs(move.path.length) + SNAKES_VICTORY_MS)
  assert.match(doRoll(room, match.current).error, /coronation/)
  clock.mock.mockImplementation(() => match.coronationUntil)
  assert.equal(doRoll(room, match.current).die, 2)
})

test('a ludo room is untouched by the game swap', t => {
  const room = twoSeatRoom('ludo')
  assert.equal(room.game, 'ludo', 'ludo stays the default for every existing caller')
  t.mock.method(Math, 'random', () => 0)

  const match = startMatch(room, 0)
  // Ludo still starts everyone in the yard and still needs a six to leave it.
  assert.equal(match.tokens.every(token => token.progress === -1), true)
  assert.deepEqual(doRoll(room, match.current).moves, [])
})
