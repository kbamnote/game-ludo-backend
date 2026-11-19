import { createServer } from 'node:http'
import { Server, type Socket } from 'socket.io'
import { privacyHtml } from './privacy.js'
import { fitPortrait } from './fitPortrait.js'
import { serveMetaPerson } from './metaperson.js'
import { attachVoice, serveVoice } from './voice.js'
import type { Seat } from './rules.js'
import {
  allRooms,
  autoPick,
  bindSocket,
  canStart,
  createRoom,
  doMove,
  doRoll,
  joinRoom,
  leaveRoom,
  markDisconnected,
  readCharacter,
  roomOfSocket,
  setReady,
  snapshot,
  startMatch,
  sweepIdleRooms,
  TURN_MS,
  type Room,
} from './room.js'

const PORT = Number(process.env.PORT ?? 8080)
const reactions = new Set(['knife', 'heart', 'cactus', 'orange', 'snowball', 'duck', 'gift', 'bomb'])
const reactionAvailableAt = new WeakMap<Room, number>()
const soundAvailableAt = new WeakMap<Room, number>()
const MATCH_SOUND_COUNT = 18

const http = createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0]
  if (path.startsWith('/avatars/metaperson/')) { void serveMetaPerson(req,res); return }
  if (path === '/avatars/fit') { void fitPortrait(req, res); return }
  if (serveVoice(path, res)) return

  // Railway and uptime pingers need a plain health endpoint.
  if (path === '/health' || path === '/') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, service: 'cgp-cockroach-game-party', uptime: process.uptime() }))
    return
  }

  // Play Console requires a publicly reachable privacy policy URL.
  if (path === '/privacy' || path === '/privacy.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=3600' })
    res.end(privacyHtml())
    return
  }

  res.writeHead(404)
  res.end()
})

const io = new Server(http, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 20_000,
  pingInterval: 10_000,
})
attachVoice(io)

/* ───────────────────────────── helpers ───────────────────────────── */

function publish(room: Room) {
  io.to(room.code).emit('room:state', snapshot(room))
}

interface Identity {
  playerId: string
  name: string
}

function identityOf(socket: Socket): Identity | null {
  const playerId = socket.data.playerId as string | undefined
  const name = socket.data.name as string | undefined
  if (!playerId) return null
  return { playerId, name: name ?? 'Player' }
}

function seatOf(room: Room, playerId: string): Seat | null {
  return room.members.find((m) => m.playerId === playerId)?.seat ?? null
}

/** Runs a roll and tells the room, then lets bots/timeouts continue. */
function performRoll(room: Room, seat: Seat) {
  const result = doRoll(room, seat)
  if ('error' in result) return result
  io.to(room.code).emit('match:rolled', {
    seat,
    die: result.die,
    movableTokenIds: result.moves.map((m) => m.tokenId),
    passed: result.passed,
  })
  publish(room)
  return result
}

function performMove(room: Room, seat: Seat, tokenId: string) {
  const result = doMove(room, seat, tokenId)
  if ('error' in result) return result
  io.to(room.code).emit('match:moved', {
    seat,
    tokenId: result.tokenId,
    path: result.path,
    captures: result.captures,
    snapshot: snapshot(room),
  })
  if (result.ended) io.to(room.code).emit('match:ended', { ranking: room.match?.ranking ?? [] })
  publish(room)
  return result
}

/* ───────────────────────────── socket wiring ───────────────────────────── */

io.on('connection', (socket) => {
  socket.on('identify', (payload: { playerId?: string; name?: string }, ack?: (r: unknown) => void) => {
    if (!payload?.playerId) {
      ack?.({ ok: false, error: 'playerId required' })
      return
    }
    socket.data.playerId = payload.playerId
    socket.data.name = (payload.name ?? 'Player').slice(0, 16)
    ack?.({ ok: true })
  })

  socket.on('room:create', (payload: { character?: unknown }, ack?: (r: unknown) => void) => {
    const me = identityOf(socket)
    if (!me) return ack?.({ ok: false, error: 'Identify first' })

    const room = createRoom(me.playerId, me.name, false, readCharacter(payload?.character))
    bindSocket(room, me.playerId, socket.id)
    socket.join(room.code)
    ack?.({ ok: true, snapshot: snapshot(room) })
    publish(room)
  })

  socket.on('room:quick', (payload: { character?: unknown }, ack?: (r: unknown) => void) => {
    const me = identityOf(socket)
    if (!me) return ack?.({ ok: false, error: 'Identify first' })
    const current = roomOfSocket(socket.id)
    if (current) return ack?.({ ok: true, snapshot: snapshot(current) })
    const open = allRooms().find((room) => room.publicTable && room.phase === 'lobby' && room.members.length < 4)
    const room = open ?? createRoom(me.playerId, me.name, true)
    const joined = joinRoom(room.code, me.playerId, me.name, socket.id, readCharacter(payload?.character))
    if (!joined.ok) return ack?.({ ok: false, error: joined.error })
    socket.join(room.code)
    ack?.({ ok: true, snapshot: snapshot(room) })
    publish(room)
  })

  socket.on('room:join', (payload: { code?: string; character?: unknown }, ack?: (r: unknown) => void) => {
    const me = identityOf(socket)
    if (!me) return ack?.({ ok: false, error: 'Identify first' })

    const code = (payload?.code ?? '').trim()
    if (!/^\d{6}$/.test(code)) return ack?.({ ok: false, error: 'Enter the 6-digit code' })

    const result = joinRoom(code, me.playerId, me.name, socket.id, readCharacter(payload?.character))
    if (!result.ok) return ack?.({ ok: false, error: result.error })

    socket.join(code)
    ack?.({ ok: true, snapshot: snapshot(result.room) })
    if (result.room.phase === 'playing') socket.emit('match:started', snapshot(result.room, true))
    publish(result.room)
  })

  socket.on('room:ready', (payload: { ready?: boolean }) => {
    const me = identityOf(socket)
    const room = roomOfSocket(socket.id)
    if (!me || !room) return
    setReady(room, me.playerId, !!payload?.ready)
    publish(room)
  })

  socket.on('room:start', (_p: unknown, ack?: (r: unknown) => void) => {
    const me = identityOf(socket)
    const room = roomOfSocket(socket.id)
    if (!me || !room) return ack?.({ ok: false, error: 'Not in a room' })
    if (room.hostId !== me.playerId) return ack?.({ ok: false, error: 'Only the host can start' })

    const blocked = canStart(room)
    if (blocked) return ack?.({ ok: false, error: blocked })

    startMatch(room)
    ack?.({ ok: true })
    io.to(room.code).emit('match:started', snapshot(room, true))
    publish(room)
  })

  socket.on('room:leave', () => {
    const me = identityOf(socket)
    const room = roomOfSocket(socket.id)
    if (!me || !room) return
    socket.leave(room.code)
    leaveRoom(room, me.playerId)
    publish(room)
  })

  socket.on('match:roll', (_p: unknown, ack?: (r: unknown) => void) => {
    const me = identityOf(socket)
    const room = roomOfSocket(socket.id)
    if (!me || !room) return ack?.({ ok: false, error: 'Not in a room' })
    const seat = seatOf(room, me.playerId)
    if (seat === null) return ack?.({ ok: false, error: 'No seat' })

    const result = performRoll(room, seat)
    ack?.('error' in result ? { ok: false, error: result.error } : { ok: true })
  })

  socket.on('match:reaction', (payload: { kind?: unknown; to?: unknown }, reply?: (r: unknown) => void) => {
    if (typeof reply !== 'function') return
    const room = roomOfSocket(socket.id)
    const sender = room?.members.find(member => member.socketId === socket.id && member.connected)
    if (room?.phase !== 'playing' || !sender || sender.seat === null) return reply({ ok: false, error: 'Join a match first.' })
    if (typeof payload?.kind !== 'string' || !reactions.has(payload.kind) || !room.members.some(
      member => member.seat !== null && member.connected && member.seat === payload.to && member.seat !== sender.seat,
    )) return reply({ ok: false, error: 'Choose a connected player and a reaction.' })
    const now = Date.now()
    if (now < (reactionAvailableAt.get(room) ?? 0)) return reply({ ok: false, error: 'Wait for the current reaction to finish.' })
    // Reserve the room for the launch delay plus the visual effect.
    reactionAvailableAt.set(room, now + (payload.kind === 'bomb' ? 6900 : 4850))
    io.to(room.code).emit('match:reaction', { roomCode: room.code, kind: payload.kind, from: sender.seat, to: payload.to })
    reply({ ok: true })
  })

  socket.on('match:sound', (payload: { clip?: unknown }, reply?: (r: unknown) => void) => {
    if (typeof reply !== 'function') return
    const room = roomOfSocket(socket.id)
    const sender = room?.members.find(member => member.socketId === socket.id && member.connected && member.seat !== null)
    if (room?.phase !== 'playing' || !sender) return reply({ ok: false, error: 'Join a match to play a sound.' })
    const clip = payload?.clip
    if (typeof clip !== 'number' || !Number.isInteger(clip) || clip < 1 || clip > MATCH_SOUND_COUNT) {
      return reply({ ok: false, error: 'That sound is unavailable.' })
    }
    const now = Date.now()
    if (now < (soundAvailableAt.get(room) ?? 0)) return reply({ ok: false, error: 'Give the sound a moment before playing another.' })
    soundAvailableAt.set(room, now + (clip === 11 ? 6100 : 900))
    io.to(room.code).emit('match:sound', { roomCode: room.code, clip })
    reply({ ok: true })
  })

  socket.on('match:move', (payload: { tokenId?: string }, ack?: (r: unknown) => void) => {
    const me = identityOf(socket)
    const room = roomOfSocket(socket.id)
    if (!me || !room) return ack?.({ ok: false, error: 'Not in a room' })
    const seat = seatOf(room, me.playerId)
    if (seat === null) return ack?.({ ok: false, error: 'No seat' })
    if (!payload?.tokenId) return ack?.({ ok: false, error: 'tokenId required' })

    const result = performMove(room, seat, payload.tokenId)
    ack?.('error' in result ? { ok: false, error: result.error } : { ok: true })
  })

  socket.on('disconnect', () => {
    const room = markDisconnected(socket.id)
    if (room) publish(room)
  })
})

/**
 * Turn clock. A seat that runs out of time — because the player is thinking too
 * long, lost signal, or closed the app — has its turn played for it, so one
 * dropped tester cannot freeze everyone else's room.
 */
setInterval(() => {
  const now = Date.now()
  for (const room of roomsNeedingAttention(now)) {
    const m = room.match!
    if (m.phase === 'await-roll') {
      performRoll(room, m.current)
    } else if (m.phase === 'await-move') {
      const tokenId = autoPick(room)
      if (tokenId) performMove(room, m.current, tokenId)
    }
  }
  sweepIdleRooms()
}, 1000)

function roomsNeedingAttention(now: number): Room[] {
  return allRooms().filter((room) => {
    const m = room.match
    return !!m && room.phase === 'playing' && m.phase !== 'ended' && now >= m.deadline
  })
}

http.listen({ port:PORT, host:process.env.LUDO_BIND_HOST }, () => {
  console.log(`[ludo] listening on :${PORT} (turn clock ${TURN_MS / 1000}s)`)
})
