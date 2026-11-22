import { randomUUID } from 'node:crypto'
import { accountStore } from './accountStore.js'
import type { Activity, AdminMatch } from './adminStore.js'
import type { Room } from './room.js'
import type { Seat } from './rules.js'

const current = new WeakMap<Room, AdminMatch>()
const pendingMatches = new Map<string, AdminMatch>()
const pendingActivity: Activity[] = []
let writing: Promise<void> | undefined
let backlogWarning = false

export function flushAdminTracking() {
  if (writing) return writing
  if (!pendingMatches.size && !pendingActivity.length) return Promise.resolve()
  writing = (async () => {
    const { admin } = await accountStore()
    for (const match of [...pendingMatches.values()]) {
      await admin.saveMatch(match)
      if (pendingMatches.get(match.id) === match) pendingMatches.delete(match.id)
    }
    const batch = pendingActivity.slice(0, 500)
    if (batch.length) {
      await admin.saveActivity(batch)
      pendingActivity.splice(0, batch.length)
      backlogWarning = false
    }
  })().catch(error => {
    console.warn('[admin tracking] Write will retry:', error instanceof Error ? error.name : 'Unknown error')
  }).finally(() => { writing = undefined })
  return writing
}
setInterval(() => { void flushAdminTracking() }, 1000).unref()

export function trackActivity(event: Omit<Activity, 'id' | 'at'>) {
  if (pendingActivity.length >= 20_000) {
    if (!backlogWarning) console.warn('[admin tracking] Activity backlog full; new events may be missing.')
    backlogWarning = true
    return
  }
  pendingActivity.push({ ...event, id: randomUUID(), at: Date.now() })
}

export function trackMatchStart(room: Room, id: string = randomUUID()) {
  const match: AdminMatch = {
    id, room: room.code, variant: room.variant, mode: room.publicTable ? 'Online' : 'Friends',
    status: 'playing', startedAt: Date.now(), entry: room.entry, prize: room.prize,
    players: room.members.flatMap(member => member.seat === null ? [] : [{ id: member.playerId, name: member.name, seat: member.seat }]),
    winners: [],
  }
  current.set(room, match)
  pendingMatches.set(id, match)
  for (const player of match.players) {
    trackActivity({ kind: 'match.started', matchId: id, accountId: player.id, name: player.name })
  }
}

export const trackedMatch = (room: Room) => current.get(room)

export function trackMatchActivity(room: Room, seat: Seat, kind: string, detail?: string) {
  const match = current.get(room)
  const player = match?.players.find(item => item.seat === seat)
  if (match && player) trackActivity({ kind, matchId: match.id, accountId: player.id, name: player.name, detail })
}

export function trackMatchEnd(room: Room, status: 'completed' | 'abandoned') {
  const tracked = current.get(room)
  if (!tracked || tracked.status !== 'playing') return
  const ranking = room.match?.ranking ?? []
  const winnerSeats = status === 'completed' ? ranking.slice(0, room.variant === 'teams' ? 2 : 1) : []
  const match: AdminMatch = {
    ...tracked, status, endedAt: Date.now(),
    players: tracked.players.map(player => {
      const index = ranking.indexOf(player.seat)
      return index < 0 ? player : { ...player, place: winnerSeats.includes(player.seat) ? 1 : index + 1 }
    }),
    winners: tracked.players.filter(player => winnerSeats.includes(player.seat)).map(player => player.id),
  }
  current.set(room, match)
  pendingMatches.set(match.id, match)
  for (const player of match.players) {
    trackActivity({ kind: 'match.' + status, matchId: match.id, accountId: player.id, name: player.name,
      detail: player.place ? 'Place ' + player.place : undefined })
  }
}
