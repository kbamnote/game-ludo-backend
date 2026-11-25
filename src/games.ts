/**
 * The two games share everything except their rules.
 *
 * A room, its lobby, its coin pot, its bots, its turn clock and its matchmaking
 * are the same whichever is being played; only move generation, what a move
 * costs the clients to present, and the win condition differ. Those live
 * behind this interface so `room.ts` never asks which game it is running.
 *
 * Mirrors mobile-ludo/src/game/games.ts.
 */
import type { Seat, Token } from './rules.js'
import type { Weapon } from './weapons.js'
import { isRanged } from './weapons.js'
import * as ludo from './rules.js'
import * as snakes from './snakes.js'

export type GameId = 'ludo' | 'snakes'

export const GAMES: readonly GameId[] = ['ludo', 'snakes']

export function readGame(value: unknown): GameId | undefined {
  return GAMES.find(game => game === value)
}

/** Both games' moves, which share every field `room.ts` reads. */
export type AnyMove = ludo.Move | snakes.SnakeMove

/* ── presentation costs, mirrored in the mobile game/moveTiming.ts ── */
const STEP_MS = 280
const RESCUE_MS = 6500
const HELICOPTER_MS = 6600
const MELEE_MS = 1500
const SUPER_MS = 3300
/** Riding a snake down, and climbing a ladder up. */
export const SLIDE_MS = 4450
export const SNAKES_VICTORY_MS = 5200
export const CLIMB_MS = 1500

/**
 * The parts of a move that decide what it costs to show. A finished move and
 * the animation replaying it both satisfy this.
 */
export interface MoveShape {
  captures: string[]
  finishes: boolean
  ride?: snakes.Ride | null
}

export interface GameRules {
  createTokens(seats: Seat[]): Token[]
  legalMoves(tokens: Token[], seat: Seat, die: number, teams: boolean): AnyMove[]
  applyMove(tokens: Token[], move: AnyMove): Token[]
  grantsExtraTurn(die: number, move: AnyMove | null): boolean
  hasWon(tokens: Token[], seat: Seat): boolean
  /** The squares the pawn walks through, excluding the one it started on. */
  walkPath(move: AnyMove): number[]
  /** What this move costs the clients to show, on top of the walk itself. */
  presentationMs(move: MoveShape, weapon: Weapon | undefined, walkMs: number): number
  /** Whether a seat reaching home is airlifted out, as Ludo does. */
  readonly airlifts: boolean
}

const LUDO: GameRules = {
  createTokens: ludo.createTokens,
  legalMoves: (tokens, seat, die, teams) => ludo.legalMoves(tokens, seat, die, teams),
  applyMove: (tokens, move) => ludo.applyMove(tokens, move as ludo.Move),
  grantsExtraTurn: (die, move) => ludo.grantsExtraTurn(die, move as ludo.Move | null),
  hasWon: ludo.hasWon,
  walkPath: move => (move.from === ludo.YARD ? [0] : range(move.from + 1, move.to)),
  presentationMs(move, weapon, walkMs) {
    let total = 0
    if (move.captures.length) {
      const rescue = move.captures.length * RESCUE_MS
      // A thrown power is cast before the attacker moves, and the ambulance is
      // called the moment the victim lands, so the walk runs underneath it.
      total += isRanged(weapon) ? SUPER_MS + Math.max(walkMs, rescue) - walkMs
        : MELEE_MS + rescue
    }
    if (move.finishes) total += HELICOPTER_MS
    return total
  },
  airlifts: true,
}

const SNAKES: GameRules = {
  createTokens: snakes.createTokens,
  legalMoves: (tokens, seat, die) => snakes.legalMoves(tokens, seat, die),
  applyMove: (tokens, move) => snakes.applyMove(tokens, move as snakes.SnakeMove),
  grantsExtraTurn: (die, move) => snakes.grantsExtraTurn(die, move as snakes.SnakeMove | null),
  hasWon: snakes.hasWon,
  // The pawn walks to where the die put it; the snake or ladder is a separate
  // beat afterwards, so it is not part of the walk.
  walkPath: move => snakes.walkPath(move.from, (move as snakes.SnakeMove).landing ?? move.to),
  presentationMs(move) {
    const ride = (move as snakes.SnakeMove).ride
    if (!ride) return 0
    return ride.kind === 'snake' ? SLIDE_MS : CLIMB_MS
  },
  airlifts: false,
}

export function rulesFor(game: GameId): GameRules {
  return game === 'snakes' ? SNAKES : LUDO
}

/** How long the walk alone takes, which both games measure the same way. */
export function walkMs(steps: number): number {
  return steps * STEP_MS
}

function range(from: number, to: number): number[] {
  const out: number[] = []
  for (let value = from; value <= to; value++) out.push(value)
  return out
}
