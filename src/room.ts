import type { MatchEntry } from './matchEntry.js'
import {
  applyMove,
  createTokens,
  grantsExtraTurn,
  hasWon,
  legalMoves,
  rollDie,
  YARD,
  type Move,
  type Seat,
  type Token,
} from './rules.js'

export const MAX_SEATS = 4
/** A seat that stalls this long has its turn played for it. */
export const TURN_MS = 20_000
// Keep in sync with the mobile coronation presentation.
const FIRST_CORONATION_MS = 12_500
const SECOND_CORONATION_MS = 8_600
/** Rooms with nobody connected are swept after this long. */
export const ROOM_TTL_MS = 30 * 60_000

export type RoomPhase = 'lobby' | 'playing' | 'finished'
export type MatchPhase = 'await-roll' | 'await-move' | 'ended'
export type GameVariant = 'classic' | 'teams' | 'quick'
const seatOrder: Seat[] = [0, 1, 2, 3]
const friendsSeatOrder: Seat[] = [0, 2, 1, 3]

interface Character {
  model: Seat | 4
  avatarId?: string
  face?: string
  fit?: string
}

// A face contains exactly 64 × 64 RGB pixels. Never accept a URL or a full photo.
export function readCharacter(value: unknown): Character | undefined {
  if (!value || typeof value !== 'object' || !('model' in value)) return
  const model = value.model
  if ('avatarId' in value) {
    if (model === 4 && typeof value.avatarId === 'string' && /^[a-f0-9]{64}$/.test(value.avatarId)
      && !('face' in value) && !('fit' in value)) return { model, avatarId: value.avatarId }
    return
  }
  if (typeof model !== 'number' || !Number.isInteger(model) || model < 0 || model > 4) return
  if (!('face' in value)) return { model: model as Character['model'] }
  const face = value.face
  if (typeof face !== 'string' || face.length !== 16384 || !/^[A-Za-z0-9+/]+$/.test(face)) return
  if (model === 4) {
    if (!('fit' in value) || typeof value.fit !== 'string' || !/^[A-Za-z0-9+/]{182}==$/.test(value.fit)) return
    return { model, face, fit: value.fit }
  }
  return { model: model as Seat, face }
}

export interface Member {
  character?: Character
  playerId: string
  name: string
  socketId: string | null
  seat: Seat | null
  ready: boolean
  connected: boolean
}

export interface MatchState {
  seats: Seat[]
  tokens: Token[]
  current: Seat
  die: number | null
  phase: MatchPhase
  moves: Move[]
  consecutiveSixes: number
  ranking: Seat[]
  /** Epoch ms by which the current seat must act. */
  deadline: number
  coronationUntil: number
}

export interface Room {
  publicTable: boolean
  entry: MatchEntry
  prize: number
  variant: GameVariant
  code: string
  hostId: string
  members: Member[]
  phase: RoomPhase
  match: MatchState | null
  createdAt: number
  lastActivity: number
}

/** What a client is allowed to see. Identical for every member. */
export interface RoomSnapshot {
  publicTable: boolean
  entry: MatchEntry
  prize: number
  variant: GameVariant
  code: string
  hostId: string
  phase: RoomPhase
  members: Omit<Member, 'socketId'>[]
  match: {
    seats: Seat[]
    tokens: Token[]
    current: Seat
    die: number | null
    phase: MatchPhase
    movableTokenIds: string[]
    ranking: Seat[]
    deadline: number
  } | null
}

const rooms = new Map<string, Room>()

/* ───────────────────────────── codes ───────────────────────────── */

function randomCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString()
}

export function createRoom(playerId: string, name: string, publicTable = false, character?: Character, entry: MatchEntry = 0): Room {
  let code = randomCode()
  while (rooms.has(code)) code = randomCode()

  const room: Room = {
    publicTable,
    entry,
    prize: 0,
    variant: 'classic',
    code,
    hostId: playerId,
    members: [{ playerId, name, character, socketId: null, seat: 0, ready: true, connected: true }],
    phase: 'lobby',
    match: null,
    createdAt: Date.now(),
    lastActivity: Date.now(),
  }
  rooms.set(code, room)
  return room
}

export function getRoom(code: string): Room | undefined {
  return rooms.get(code)
}

export function roomOfSocket(socketId: string): Room | undefined {
  for (const room of rooms.values()) {
    if (room.members.some((m) => m.socketId === socketId)) return room
  }
  return undefined
}

/* ───────────────────────────── membership ───────────────────────────── */

export type JoinResult = { ok: true; room: Room } | { ok: false; error: string }

export function joinRoom(code: string, playerId: string, name: string, socketId: string, character?: Character): JoinResult {
  const room = rooms.get(code)
  if (!room) return { ok: false, error: 'No room with that code' }

  const existing = room.members.find((m) => m.playerId === playerId)
  if (existing) {
    // Reconnect: take the seat back rather than adding a duplicate.
    existing.socketId = socketId
    existing.connected = true
    existing.name = name || existing.name
    if (room.phase === 'lobby') existing.character = character
    room.lastActivity = Date.now()
    return { ok: true, room }
  }

  if (room.phase !== 'lobby') return { ok: false, error: 'That match has already started' }

  const taken = new Set(room.members.map((m) => m.seat))
  const seat = (room.publicTable ? seatOrder : friendsSeatOrder).find((s) => !taken.has(s))
  if (seat === undefined) return { ok: false, error: 'Room is full' }

  room.members.push({ playerId, name, character, socketId, seat, ready: false, connected: true })
  alignOppositeSeats(room)
  room.lastActivity = Date.now()
  return { ok: true, room }
}

function alignOppositeSeats(room: Room) {
  if (room.publicTable || room.phase !== 'lobby' || room.members.length !== 2) return
  const [first, second] = room.members
  if (first.seat !== null) second.seat = ((first.seat + 2) % MAX_SEATS) as Seat
}

export function bindSocket(room: Room, playerId: string, socketId: string) {
  const member = room.members.find((m) => m.playerId === playerId)
  if (member) {
    member.socketId = socketId
    member.connected = true
  }
  room.lastActivity = Date.now()
}

export function markDisconnected(socketId: string): Room | undefined {
  const room = roomOfSocket(socketId)
  if (!room) return undefined
  const member = room.members.find((m) => m.socketId === socketId)
  if (!member) return room

  member.connected = false
  member.socketId = null

  // In the lobby a leaver frees the seat entirely; mid-match the seat stays so
  // they can reconnect, and the turn clock covers their absence.
  if (room.phase === 'lobby') {
    room.members = room.members.filter((m) => m.playerId !== member.playerId)
    if (room.hostId === member.playerId && room.members.length > 0) {
      room.hostId = room.members[0].playerId
    }
    alignOppositeSeats(room)
  }

  room.lastActivity = Date.now()
  if (room.members.length === 0) rooms.delete(room.code)
  return room
}

export function leaveRoom(room: Room, playerId: string) {
  room.members = room.members.filter((m) => m.playerId !== playerId)
  if (room.hostId === playerId && room.members.length > 0) room.hostId = room.members[0].playerId
  alignOppositeSeats(room)
  if (room.members.length === 0) rooms.delete(room.code)
  room.lastActivity = Date.now()
}

export function setReady(room: Room, playerId: string, ready: boolean) {
  const member = room.members.find((m) => m.playerId === playerId)
  if (member) member.ready = ready
  room.lastActivity = Date.now()
}

export function setRoomVariant(room: Room, playerId: string, variant: unknown): string | null {
  if (room.publicTable || room.phase !== 'lobby' || room.hostId !== playerId) return 'Only the Friends room host can change the game before it starts'
  if (variant !== 'classic' && variant !== 'teams' && variant !== 'quick') return 'Invalid game mode'
  if (variant !== room.variant) {
    room.variant = variant
    for (const member of room.members) member.ready = member.playerId === playerId
    room.lastActivity = Date.now()
  }
  return null
}

/* ───────────────────────────── match ───────────────────────────── */

export function canStart(room: Room): string | null {
  if (room.phase !== 'lobby') return 'Match already started'
  const seated = room.members.filter((m) => m.seat !== null)
  if (room.variant === 'teams' && seated.length !== 4) return 'Team Up needs 4 players'
  if (seated.length < 2) return 'Need at least 2 players'
  if (!seated.every((m) => m.ready)) return 'Everyone must be ready'
  return null
}

export function startMatch(room: Room): MatchState {
  const seats = room.members
    .map((m) => m.seat)
    .filter((s): s is Seat => s !== null)
    .sort((a, b) => a - b)

  const match: MatchState = {
    seats,
    tokens: createTokens(seats),
    current: seats[0],
    die: null,
    phase: 'await-roll',
    moves: [],
    consecutiveSixes: 0,
    ranking: [],
    deadline: Date.now() + TURN_MS,
    coronationUntil: 0,
  }

  room.match = match
  room.prize = room.entry * seats.length
  room.phase = 'playing'
  room.lastActivity = Date.now()
  return match
}

export interface RollResult {
  die: number
  moves: Move[]
  /** Set when the roll produced no legal move and the turn passed on. */
  passed: boolean
}

/** The server owns the dice — clients never send a value. */
export function doRoll(room: Room, seat: Seat): RollResult | { error: string } {
  const m = room.match
  if (!m || m.phase !== 'await-roll') return { error: 'Not accepting a roll' }
  if (Date.now() < m.coronationUntil) return { error: 'Wait for the coronation to finish' }
  if (m.current !== seat) return { error: 'Not your turn' }

  const die = rollDie()
  const sixes = die === 6 ? m.consecutiveSixes + 1 : 0
  m.die = die
  m.consecutiveSixes = sixes
  room.lastActivity = Date.now()

  if (sixes >= 3) {
    m.consecutiveSixes = 0
    advance(m)
    return { die, moves: [], passed: true }
  }

  const moves = legalMoves(m.tokens, seat, die, room.variant === 'teams')
  m.moves = moves

  if (moves.length === 0) {
    if (die === 6) {
      m.phase = 'await-roll'
      m.deadline = Date.now() + TURN_MS
    } else {
      advance(m)
    }
    return { die, moves: [], passed: true }
  }

  m.phase = 'await-move'
  m.deadline = Date.now() + TURN_MS
  return { die, moves, passed: false }
}

export interface MoveResult {
  tokenId: string
  path: number[]
  captures: string[]
  finished: Seat | null
  ended: boolean
}

export function doMove(room: Room, seat: Seat, tokenId: string): MoveResult | { error: string } {
  const m = room.match
  if (!m || m.phase !== 'await-move') return { error: 'Not accepting a move' }
  if (m.current !== seat) return { error: 'Not your turn' }

  const move = m.moves.find((mv) => mv.tokenId === tokenId)
  if (!move) return { error: 'Illegal move' }

  const path = move.from === YARD ? [0] : rangeInclusive(move.from + 1, move.to)

  m.tokens = applyMove(m.tokens, move)
  m.moves = []
  room.lastActivity = Date.now()

  const partner = ((seat + 2) % MAX_SEATS) as Seat
  const finishedSeat = hasWon(m.tokens, seat)
  const quickWinner = room.variant === 'quick' && move.finishes
  const teamWinner = room.variant === 'teams' && finishedSeat && hasWon(m.tokens, partner)
  if (quickWinner || teamWinner) {
    m.ranking = teamWinner ? [seat, partner] : [seat]
    m.phase = 'ended'
    room.phase = 'finished'
    return { tokenId, path, captures: move.captures, finished: seat, ended: true }
  }

  let finished: Seat | null = null
  if (finishedSeat && !m.ranking.includes(seat)) {
    m.ranking.push(seat)
    finished = seat
  }

  const remaining = m.seats.filter((s) => !m.ranking.includes(s))
  if (remaining.length <= 1) {
    for (const s of remaining) if (!m.ranking.includes(s)) m.ranking.push(s)
    m.phase = 'ended'
    room.phase = 'finished'
    return { tokenId, path, captures: move.captures, finished, ended: true }
  }

  if (grantsExtraTurn(m.die ?? 0, move) && !m.ranking.includes(seat)) {
    m.phase = 'await-roll'
    m.deadline = Date.now() + TURN_MS
  } else {
    advance(m)
  }

  // Give the next decision its full turn clock after the rescue presentation.
  if (move.captures.length) m.deadline += path.length * 280 + move.captures.length * 6500
  if (room.variant !== 'teams' && finished !== null && m.ranking.length <= 2) {
    const duration = m.ranking.length === 1 ? FIRST_CORONATION_MS : SECOND_CORONATION_MS
    const presentation = path.length * 280 + duration
    m.coronationUntil = Date.now() + presentation
    m.deadline += presentation
  }
  return { tokenId, path, captures: move.captures, finished, ended: false }
}

function rangeInclusive(from: number, to: number): number[] {
  const out: number[] = []
  for (let p = from; p <= to; p++) out.push(p)
  return out
}

function advance(m: MatchState) {
  const pos = m.seats.indexOf(m.current)
  let next = m.current
  for (let i = 1; i <= m.seats.length; i++) {
    const candidate = m.seats[(pos + i) % m.seats.length]
    if (!m.ranking.includes(candidate)) {
      next = candidate
      break
    }
  }
  m.current = next
  m.die = null
  m.moves = []
  m.consecutiveSixes = 0
  m.phase = 'await-roll'
  m.deadline = Date.now() + TURN_MS
}

/** Picks a move for a seat that ran out of time or dropped off. */
export function autoPick(room: Room): string | null {
  const m = room.match
  if (!m || m.phase !== 'await-move' || m.moves.length === 0) return null
  // Prefer a capture, then the furthest advance — never a random no-op.
  const best = [...m.moves].sort((a, b) => {
    const ca = a.captures.length ? 1 : 0
    const cb = b.captures.length ? 1 : 0
    if (ca !== cb) return cb - ca
    return b.to - a.to
  })[0]
  return best.tokenId
}

/* ───────────────────────────── snapshots ───────────────────────────── */

export function snapshot(room: Room, includeCharacters = false): RoomSnapshot {
  return {
    code: room.code,
    hostId: room.hostId,
    publicTable: room.publicTable,
    entry: room.entry,
    prize: room.match ? room.prize : room.entry * room.members.filter(member => member.seat !== null).length,
    variant: room.variant,
    phase: room.phase,
    members: room.members.map((m) => ({
      playerId: m.playerId,
      name: m.name,
      seat: m.seat,
      ready: m.ready,
      connected: m.connected,
      ...(includeCharacters && m.character ? { character: m.character } : {}),
    })),
    match: room.match
      ? {
          seats: room.match.seats,
          tokens: room.match.tokens,
          current: room.match.current,
          die: room.match.die,
          phase: room.match.phase,
          movableTokenIds: room.match.moves.map((mv) => mv.tokenId),
          ranking: room.match.ranking,
          deadline: room.match.deadline,
        }
      : null,
  }
}

export function allRooms(): Room[] {
  return [...rooms.values()]
}

export function sweepIdleRooms() {
  const now = Date.now()
  const removed: Room[] = []
  for (const [code, room] of rooms) {
    const anyone = room.members.some((m) => m.connected)
    if (!anyone && now - room.lastActivity > ROOM_TTL_MS) {
      rooms.delete(code)
      removed.push(room)
    }
  }
  return removed
}
