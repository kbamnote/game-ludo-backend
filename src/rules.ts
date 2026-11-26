/**
 * Ludo rules engine — pure, deterministic, UI-free.
 *
 * Board model (classic 15x15 cross):
 *  - 52 shared track cells, indexed 0..51 clockwise.
 *  - Each seat enters the track at a fixed index (0 / 13 / 26 / 39).
 *  - A token's progress `p` is measured from its own entry:
 *      p = -1       -> still in the yard
 *      p = 0..50    -> on the shared track at (entry + p) % 52
 *      p = 51..55   -> in that seat's 5-cell home column
 *      p = 56       -> home (finished)
 *  - Reaching home needs an exact roll; overshooting is not a legal move.
 */

export type Seat = 0 | 1 | 2 | 3
export type SeatColor = 'red' | 'green' | 'yellow' | 'blue'

export const SEAT_COLORS: Record<Seat, SeatColor> = {
  0: 'red',
  1: 'green',
  2: 'yellow',
  3: 'blue',
}

/** Jewel tones from the design system, per seat. */
export const SEAT_HEX: Record<Seat, string> = {
  0: '#ff2e55', // ruby
  1: '#00e676', // emerald
  2: '#ffb300', // topaz
  3: '#0075ff', // sapphire
}

export const TRACK_LENGTH = 52
/** Last shared-track step before a token turns into its home column. */
export const LAST_TRACK_STEP = 50
/** Progress value that means "home". */
export const HOME_STEP = 56
export const TOKENS_PER_SEAT = 4

export const ENTRY_INDEX: Record<Seat, number> = { 0: 0, 1: 13, 2: 26, 3: 39 }

/** Entry cells plus the four star cells, eight steps past each entry. */
export const SAFE_CELLS: ReadonlySet<number> = new Set([0, 13, 26, 39, 8, 21, 34, 47])

export const YARD = -1

export interface Token {
  id: string
  seat: Seat
  index: number
  /** -1 yard, 0..50 track, 51..55 home column, 56 home. */
  progress: number
}

export interface Move {
  tokenId: string
  from: number
  to: number
  /** Token ids sent back to the yard by this move. */
  captures: string[]
  /** True when the move lands exactly on home. */
  finishes: boolean
  /** True when the token leaves the yard onto its entry cell. */
  entersBoard: boolean
}

/* ─────────────────────────── geometry ─────────────────────────── */

/** The 52 track cells as [col, row] on the 15x15 grid, clockwise from red's entry. */
export const TRACK_CELLS: ReadonlyArray<readonly [number, number]> = [
  // row 6 heading right, red's entry run
  [1, 6], [2, 6], [3, 6], [4, 6], [5, 6],
  // column 6 heading up
  [6, 5], [6, 4], [6, 3], [6, 2], [6, 1],
  // top edge
  [6, 0], [7, 0], [8, 0],
  // column 8 heading down, green's entry run
  [8, 1], [8, 2], [8, 3], [8, 4], [8, 5],
  // row 6 heading right
  [9, 6], [10, 6], [11, 6], [12, 6], [13, 6],
  // right edge
  [14, 6], [14, 7], [14, 8],
  // row 8 heading left, yellow's entry run
  [13, 8], [12, 8], [11, 8], [10, 8], [9, 8],
  // column 8 heading down
  [8, 9], [8, 10], [8, 11], [8, 12], [8, 13],
  // bottom edge
  [8, 14], [7, 14], [6, 14],
  // column 6 heading up, blue's entry run
  [6, 13], [6, 12], [6, 11], [6, 10], [6, 9],
  // row 8 heading left
  [5, 8], [4, 8], [3, 8], [2, 8], [1, 8],
  // left edge
  [0, 8], [0, 7], [0, 6],
] as const

/** The five home-column cells per seat, outermost first. */
export const HOME_COLUMN_CELLS: Record<Seat, ReadonlyArray<readonly [number, number]>> = {
  0: [[1, 7], [2, 7], [3, 7], [4, 7], [5, 7]],
  1: [[7, 1], [7, 2], [7, 3], [7, 4], [7, 5]],
  2: [[13, 7], [12, 7], [11, 7], [10, 7], [9, 7]],
  3: [[7, 13], [7, 12], [7, 11], [7, 10], [7, 9]],
}

/** The four parking spots inside each seat's yard. */
export const YARD_CELLS: Record<Seat, ReadonlyArray<readonly [number, number]>> = {
  0: [[1.8, 1.8], [3.7, 1.8], [1.8, 3.7], [3.7, 3.7]],
  1: [[10.3, 1.8], [12.2, 1.8], [10.3, 3.7], [12.2, 3.7]],
  2: [[10.3, 10.3], [12.2, 10.3], [10.3, 12.2], [12.2, 12.2]],
  3: [[1.8, 10.3], [3.7, 10.3], [1.8, 12.2], [3.7, 12.2]],
}

export const CENTER_CELL: readonly [number, number] = [7, 7]

/** Absolute track index for a seat's progress value, or null when off-track. */
export function trackIndexFor(seat: Seat, progress: number): number | null {
  if (progress < 0 || progress > LAST_TRACK_STEP) return null
  return (ENTRY_INDEX[seat] + progress) % TRACK_LENGTH
}

/** Grid cell for a token, used by both the 2D minimap and the 3D board. */
export function cellFor(token: Token): readonly [number, number] {
  if (token.progress === YARD) return YARD_CELLS[token.seat][token.index]
  if (token.progress === HOME_STEP) return CENTER_CELL
  if (token.progress > LAST_TRACK_STEP) {
    return HOME_COLUMN_CELLS[token.seat][token.progress - LAST_TRACK_STEP - 1]
  }
  return TRACK_CELLS[trackIndexFor(token.seat, token.progress)!]
}

/** Grid cell for an arbitrary seat/progress pair (used to animate step by step). */
export function cellForProgress(seat: Seat, progress: number, tokenIndex = 0): readonly [number, number] {
  if (progress === YARD) return YARD_CELLS[seat][tokenIndex]
  if (progress >= HOME_STEP) return CENTER_CELL
  if (progress > LAST_TRACK_STEP) return HOME_COLUMN_CELLS[seat][progress - LAST_TRACK_STEP - 1]
  return TRACK_CELLS[trackIndexFor(seat, progress)!]
}

/* ─────────────────────────── setup ─────────────────────────── */

export function createTokens(seats: Seat[]): Token[] {
  return seats.flatMap((seat) =>
    Array.from({ length: TOKENS_PER_SEAT }, (_, index) => ({
      id: `${seat}-${index}`,
      seat,
      index,
      progress: YARD,
    })),
  )
}

export function rollDie(rng: () => number = Math.random): number {
  return 1 + Math.floor(rng() * 6)
}

/* ─────────────────────────── move generation ─────────────────────────── */

function tokensOnSameCell(tokens: Token[], seat: Seat, progress: number): Token[] {
  const idx = trackIndexFor(seat, progress)
  if (idx === null) return []
  return tokens.filter((t) => t.progress >= 0 && t.progress <= LAST_TRACK_STEP && trackIndexFor(t.seat, t.progress) === idx)
}

/**
 * Every legal move for `seat` with `die`.
 * Landing on an unprotected cell captures every opposing token on it.
 */
export function legalMoves(tokens: Token[], seat: Seat, die: number, teams = false): Move[] {
  const moves: Move[] = []

  for (const token of tokens) {
    if (token.seat !== seat) continue
    if (token.progress === HOME_STEP) continue

    let to: number
    let entersBoard = false

    if (token.progress === YARD) {
      if (die !== 6) continue
      to = 0
      entersBoard = true
    } else {
      to = token.progress + die
      if (to > HOME_STEP) continue // must land on home exactly
    }

    // The home column and home itself are private.
    if (to > LAST_TRACK_STEP) {
      moves.push({ tokenId: token.id, from: token.progress, to, captures: [], finishes: to === HOME_STEP, entersBoard })
      continue
    }

    const landingIdx = trackIndexFor(seat, to)!
    const occupants = tokens.filter(
      (t) => t.id !== token.id && t.progress >= 0 && t.progress <= LAST_TRACK_STEP && trackIndexFor(t.seat, t.progress) === landingIdx,
    )

    const enemies = occupants.filter((t) => t.seat !== seat && (!teams || t.seat % 2 !== seat % 2))

    const captures = SAFE_CELLS.has(landingIdx) ? [] : enemies.map((t) => t.id)

    moves.push({ tokenId: token.id, from: token.progress, to, captures, finishes: false, entersBoard })
  }

  return moves
}

/** Applies a move, returning the next token list. Pure — input is not mutated. */
export function applyMove(tokens: Token[], move: Move): Token[] {
  return tokens.map((t) => {
    if (t.id === move.tokenId) return { ...t, progress: move.to }
    if (move.captures.includes(t.id)) return { ...t, progress: YARD }
    return t
  })
}

/** A seat keeps the dice after a six, a capture, or sending a token home. */
export function grantsExtraTurn(die: number, move: Move | null): boolean {
  if (die === 6) return true
  if (!move) return false
  return move.finishes || move.captures.length > 0
}

export function hasWon(tokens: Token[], seat: Seat): boolean {
  return tokens.filter((t) => t.seat === seat).every((t) => t.progress === HOME_STEP)
}

export function tokensHome(tokens: Token[], seat: Seat): number {
  return tokens.filter((t) => t.seat === seat && t.progress === HOME_STEP).length
}

/** Ranking score used for the live leaderboard: total progress plus home bonus. */
export function seatScore(tokens: Token[], seat: Seat): number {
  return tokens
    .filter((t) => t.seat === seat)
    .reduce((sum, t) => sum + (t.progress === YARD ? 0 : t.progress) + (t.progress === HOME_STEP ? 20 : 0), 0)
}

export { tokensOnSameCell }
