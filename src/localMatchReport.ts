import { createHash } from 'node:crypto'
import type { Account } from './accountStore.js'
import type { AdminMatch } from './adminStore.js'
import type { Seat } from './rules.js'

const isSeat = (value: unknown): value is Seat => value === 0 || value === 1 || value === 2 || value === 3

export function readLocalMatchReport(input: Record<string, unknown>, account: Account): AdminMatch | null {
  const { mode, variant, startedAt, endedAt, seats, ranking, status } = input
  if (mode !== 'Computer' && mode !== 'Pass & Play' && mode !== 'Tournament') return null
  if (variant !== 'classic' && variant !== 'quick' && variant !== 'teams') return null
  if (status !== 'completed' && status !== 'abandoned') return null
  const now = Date.now()
  if (typeof startedAt !== 'number' || typeof endedAt !== 'number' || !Number.isSafeInteger(startedAt)
    || !Number.isSafeInteger(endedAt) || startedAt < Date.UTC(2024, 0, 1) || endedAt < startedAt
    || endedAt > now + 24 * 60 * 60_000) return null
  if (!Array.isArray(seats) || seats.length < 2 || seats.length > 4 || !seats.every(isSeat)
    || new Set(seats).size !== seats.length || !Array.isArray(ranking) || ranking.length > seats.length
    || !ranking.every(seat => seats.includes(seat)) || new Set(ranking).size !== ranking.length
    || (status === 'completed' && !ranking.length)) return null
  const id = 'local_' + createHash('sha256').update(account.id + ':' + startedAt).digest('hex')
  return {
    id, room: id.slice(-6).toUpperCase(), mode, variant, startedAt, endedAt, status, entry: 0, prize: 0,
    // Device reports are visible in history and never award competitive wins or coins.
    winners: [],
    players: seats.map((seat, index) => ({
      id: index === 0 ? account.id : 'seat_' + seat,
      name: index === 0 ? account.name : (mode === 'Pass & Play' ? 'Player ' : 'Computer ') + (index + 1),
      seat,
      place: ranking.includes(seat) ? (variant === 'teams' && ranking.indexOf(seat) < 2 ? 1 : ranking.indexOf(seat) + 1) : undefined,
    })),
  }
}
