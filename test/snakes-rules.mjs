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

test('every seat starts with four pawns waiting off the board', () => {
  const tokens = createTokens(seats)
  assert.equal(tokens.length, 8)
  assert.equal(tokens.every(token => token.progress === START), true)
  // No six is needed to set off, so the first roll always has four options.
  assert.equal(legalMoves(tokens, 0, 1).length, 4)
  assert.equal(legalMoves(tokens, 0, 1).every(move => move.entersBoard), true)
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
  // From the start pad, a one lands on square 1 — the foot of the long ladder.
  const climb = only(tokens, 0, 1)
  assert.equal(climb.landing, 1)
  assert.equal(climb.to, 38)
  assert.deepEqual(climb.ride, { kind: 'ladder', from: 1, to: 38 })

  // Walk a pawn to 15, then a one puts its head in the snake at 16.
  const at15 = applyMove(tokens, { ...only(tokens, 0, 1), to: 15, landing: 15, ride: null })
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
  // 97 + 4 would be 101: that pawn cannot move, so only the other three can.
  const four = legalMoves(tokens, 0, 4)
  assert.equal(four.some(move => move.tokenId === '0-0'), false)
  assert.equal(four.length, 3)

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
  const plain = only(tokens, 0, 2)
  assert.equal(grantsExtraTurn(6, plain), true)
  assert.equal(grantsExtraTurn(2, plain), false)
  assert.equal(grantsExtraTurn(6, null), true)
  assert.equal(grantsExtraTurn(3, null), false)
  assert.equal(grantsExtraTurn(3, { ...plain, finishes: true }), true)
})

test('the seat wins only when all four pawns are home', () => {
  let tokens = createTokens(seats)
  assert.equal(hasWon(tokens, 0), false)
  tokens = tokens.map(token => (token.seat === 0 ? { ...token, progress: GOAL } : token))
  assert.equal(hasWon(tokens, 0), true)
  assert.equal(hasWon(tokens, 1), false)
  // Nobody is ever captured, so a move never sends anyone back.
  assert.equal(legalMoves(createTokens(seats), 0, 3).every(move => move.captures.length === 0), true)
})

/* ── the room layer, shared with Ludo ── */
import { createRoom, doMove, doRoll, joinRoom, snapshot, startMatch } from '../dist/room.js'

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
  assert.equal(match.tokens.length, 8)
  assert.equal(match.tokens.every(token => token.progress === START), true,
    'snakes pawns start on the pad, not in a yard')

  const rolled = doRoll(room, match.current)
  assert.equal(rolled.die, 1)
  assert.equal(rolled.moves.length, 4, 'all four pawns can set off without a six')

  const moved = doMove(room, match.current, rolled.moves[0].tokenId)
  // The pawn walks only as far as the die took it...
  assert.deepEqual(moved.path, [1])
  // ...and the ladder it landed on travels with the move as its own beat.
  assert.deepEqual(moved.ride, { kind: 'ladder', from: 1, to: 38 })
  assert.equal(moved.captures.length, 0, 'nobody is ever captured in snakes')
  assert.equal(match.tokens.find(token => token.id === moved.tokenId).progress, 38)
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
