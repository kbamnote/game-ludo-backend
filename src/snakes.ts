/**
 * Snakes and Ladders. Mirrors mobile-ludo/src/game/snakes.ts, minus the
 * render-only geometry — the server owns the dice and the moves, and the
 * client only has to agree with it.
 *
 * The same four characters a seat plays in Ludo race up a hundred squares
 * instead of round a track, so a turn is still "pick one of your four and
 * move it". Nobody is captured here; the board does the damage.
 */
import type { Seat, Token } from './rules.js'

export const COLUMNS = 10
export const ROWS = 10
/** Squares 1..100. */
export const SQUARES = COLUMNS * ROWS
/** Where a pawn waits before its first move. No six is needed to leave it. */
export const START = 0
/** The last square. A pawn has to land on it exactly. */
export const GOAL = SQUARES
export const TOKENS_PER_SEAT = 4

/**
 * The classic board. Every ladder foot and snake head is unique, and 80
 * climbs straight to the win, so the last stretch is worth racing for.
 */
export const LADDERS: ReadonlyMap<number, number> = new Map([
  [1, 38], [4, 14], [9, 31], [21, 42], [28, 84], [36, 44], [51, 67], [71, 91], [80, 100],
])
export const SNAKES: ReadonlyMap<number, number> = new Map([
  [16, 6], [47, 26], [49, 11], [56, 53], [62, 19], [64, 60], [87, 24], [93, 73], [95, 75], [98, 78],
])

export interface Ride {
  kind: 'snake' | 'ladder'
  from: number
  to: number
}

/** The snake or ladder that starts on this square, if any. */
export function rideFor(square: number): Ride | null {
  const up = LADDERS.get(square)
  if (up !== undefined) return { kind: 'ladder', from: square, to: up }
  const down = SNAKES.get(square)
  if (down !== undefined) return { kind: 'snake', from: square, to: down }
  return null
}

export interface SnakeMove {
  tokenId: string
  from: number
  /** The square the pawn walks to, before any snake or ladder takes it. */
  landing: number
  /** Where it comes to rest: the same square, or the far end of the ride. */
  to: number
  ride: Ride | null
  /** Always empty. Kept so a move is the same shape as a Ludo one. */
  captures: string[]
  finishes: boolean
  entersBoard: boolean
}

export function createTokens(seats: Seat[]): Token[] {
  return seats.flatMap(seat =>
    Array.from({ length: TOKENS_PER_SEAT }, (_, index) => ({
      id: `${seat}-${index}`,
      seat,
      index,
      progress: START,
    })),
  )
}

/**
 * Every legal move for `seat` with `die`. A pawn that would overshoot 100
 * cannot move at all, so the last few squares have to be rolled exactly — if
 * none of the four can use the die, the turn passes.
 */
export function legalMoves(tokens: Token[], seat: Seat, die: number): SnakeMove[] {
  const moves: SnakeMove[] = []
  for (const token of tokens) {
    if (token.seat !== seat || token.progress >= GOAL) continue
    const landing = token.progress + die
    if (landing > GOAL) continue
    const ride = rideFor(landing)
    moves.push({
      tokenId: token.id,
      from: token.progress,
      landing,
      to: ride ? ride.to : landing,
      ride,
      captures: [],
      finishes: (ride ? ride.to : landing) === GOAL,
      entersBoard: token.progress === START,
    })
  }
  return moves
}

export function applyMove(tokens: Token[], move: SnakeMove): Token[] {
  return tokens.map(token => (token.id === move.tokenId ? { ...token, progress: move.to } : token))
}

/** A six rolls again, as in Ludo, and so does getting a pawn home. */
export function grantsExtraTurn(die: number, move: SnakeMove | null): boolean {
  if (die === 6) return true
  return move?.finishes ?? false
}

export function hasWon(tokens: Token[], seat: Seat): boolean {
  return tokens.filter(token => token.seat === seat).every(token => token.progress === GOAL)
}

export function tokensHome(tokens: Token[], seat: Seat): number {
  return tokens.filter(token => token.seat === seat && token.progress === GOAL).length
}

/** The squares a pawn walks through on its way to `landing`, excluding where it started. */
export function walkPath(from: number, landing: number): number[] {
  const path: number[] = []
  for (let square = from + 1; square <= landing; square++) path.push(square)
  return path
}
