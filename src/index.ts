import { createServer } from 'node:http'
import { serveAdmin } from './admin.js'
import { trackActivity, trackMatchActivity, trackMatchEnd, trackMatchStart } from './adminTracking.js'
import { randomUUID } from 'node:crypto'
import { serveAccounts, authenticatedAccount } from './accounts.js'
import { accountStore, InsufficientMatchCoins } from './accountStore.js'
import { readMatchEntry, type MatchEntry, type MatchPot } from './matchEntry.js'
import { Server, type Socket } from 'socket.io'
import { privacyHtml } from './privacy.js'
import { fitPortrait } from './fitPortrait.js'
import { serveMetaPerson } from './metaperson.js'
import { attachVoice, serveVoice } from './voice.js'
import type { Seat } from './rules.js'
import {
  allRooms,
  activeRoomFor,
  autoPick,
  bindSocket,
  canStart,
  createRoom,
  doMove,
  doRoll,
  eliminateSeat,
  getRoom,
  joinRoom,
  leaveRoom,
  markDisconnected,
  missRoll,
  readCharacter,
  roomOfSocket,
  setReady,
  setRoomVariant,
  snapshot,
  startMatch,
  sweepIdleRooms,
  TURN_MS,
  MATCH_INTRO_MS,
  type Room,
} from './room.js'

const PORT = Number(process.env.PORT ?? 8080)
const reactions = new Set(['knife', 'heart', 'cactus', 'orange', 'snowball', 'duck', 'gift', 'bomb'])
const reactionAvailableAt = new WeakMap<Room, number>()
const soundAvailableAt = new WeakMap<Room, number>()
const MATCH_SOUND_COUNT = 18
// Let the Friends dice finish rolling before the only legal move is played.
const FORCED_MOVE_DELAY_MS = 1030
const ROLL_LEAD_MS = 220
const SOUND_LEAD_MS = 500
const REACTION_LEAD_MS = 2000

const http = createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0]
  if (path.startsWith('/api/admin/')) {
    void serveAdmin(req, res, () => new Set([...io.sockets.sockets.values()].flatMap(socket =>
      socket.data.accountId ? [String(socket.data.accountId)] : [])))
    return
  }
  if (path.startsWith('/auth/')) { void serveAccounts(req, res); return }
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

const POT_LEASE_MS = 5 * 60_000
const startingRooms = new WeakSet<Room>()
type FundedRoom = { pot: MatchPot; seats: Map<Seat, string>; winners?: string[]; settling?: boolean }
const fundedRooms = new Map<Room, FundedRoom>()

function walletChanged(players: string[]) {
  for (const id of players) io.to(`wallet:${id}`).emit('wallet:changed')
}

async function settlePot(room: Room, winners: string[]) {
  const funded = fundedRooms.get(room)
  if (!funded || funded.settling) return
  const recipients = funded.winners ??= winners
  funded.settling = true
  try {
    const store = await accountStore()
    await store.settleMatchPot(funded.pot.id, recipients)
    fundedRooms.delete(room)
    walletChanged(funded.pot.accounts)
  } catch (error) {
    console.warn('[match pot] Settlement will retry:', error instanceof Error ? error.name : 'Unknown error')
  } finally {
    funded.settling = false
  }
}

async function checkEntry(playerId: string, entry: MatchEntry) {
  if (!entry) return null
  if (!playerId.startsWith('acct_')) return 'Sign in or play as a guest to enter a coin table.'
  try {
    const store = await accountStore()
    const account = await store.accountById(playerId)
    return account && account.coins >= entry ? null : 'You do not have enough online coins for this table.'
  } catch {
    return 'Could not check your online coins. Try again.'
  }
}

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

function hasOtherLiveMatch(socket: Socket, target?: Room) {
  const accountId = socket.data.accountId
  if (typeof accountId !== 'string') return false
  const active = activeRoomFor(accountId)
  return Boolean(active && active !== target)
}

const liveMatchMessage = 'Resume or forfeit your live match before joining another table.'

/** Runs a roll and tells the room, then lets bots/timeouts continue. */
function performRoll(room: Room, seat: Seat, manual = true) {
  const result = doRoll(room, seat, manual)
  if ('error' in result) return result
  trackMatchActivity(room, seat, 'match.roll', String(result.die))
  const serverNow = Date.now()
  io.to(room.code).emit('match:rolled', {
    roomCode: room.code,
    serverNow,
    startsAt: serverNow + ROLL_LEAD_MS,
    seat,
    die: result.die,
    movableTokenIds: result.moves.map((m) => m.tokenId),
    passed: result.passed,
  })
  publish(room)
  if (!room.publicTable && result.moves.length === 1 && room.match) {
    const match = room.match
    const moves = result.moves
    setTimeout(() => {
      if (room.match === match && match.phase === 'await-move' && match.moves === moves) {
        performMove(room, seat, moves[0].tokenId)
      }
    }, FORCED_MOVE_DELAY_MS).unref()
  }
  return result
}

function performMove(room: Room, seat: Seat, tokenId: string) {
  const result = doMove(room, seat, tokenId)
  if ('error' in result) return result
  trackMatchActivity(room, seat, 'match.move', result.path.length + ' steps' +
    (result.captures.length ? ' · ' + result.captures.length + ' captured' : ''))
  io.to(room.code).emit('match:moved', {
    seat,
    tokenId: result.tokenId,
    path: result.path,
    captures: result.captures,
    snapshot: snapshot(room),
  })
  settleResults(room)
  publish(room)
  return result
}

function settleResults(room: Room) {
  const ranking = room.match?.ranking ?? []
  const ended = room.phase === 'finished'
  const funded = fundedRooms.get(room)
  if (funded && !funded.winners && (room.variant === 'classic' ? ranking.length > 0 : ended)) {
    const winners = ranking.slice(0, room.variant === 'teams' ? 2 : 1)
      .map(winner => funded.seats.get(winner)).filter((id): id is string => id !== undefined)
    void settlePot(room, winners)
  }
  if (ended) {
    trackMatchEnd(room, 'completed')
    io.to(room.code).emit('match:ended', { ranking })
  }
}

/* ───────────────────────────── socket wiring ───────────────────────────── */

io.on('connection', (socket) => {
  type IdentifyPayload = { playerId?: string; name?: string; token?: string }
  async function identify(payload: IdentifyPayload | undefined, ack?: (r: unknown) => void) {
    let account: Awaited<ReturnType<typeof authenticatedAccount>>
    try {
      account = payload?.token ? await authenticatedAccount(payload.token) : undefined
    } catch {
      return ack?.({ ok: false, error: 'Account service unavailable. Please try again.' })
    }
    if ((payload?.token || (typeof payload?.playerId === 'string' && payload.playerId.startsWith('acct_'))) && !account) {
      return ack?.({ ok: false, error: 'Sign in again to play online' })
    }
    const playerId = account?.id ?? payload?.playerId
    if (typeof playerId !== 'string' || !playerId) {
      ack?.({ ok: false, error: 'playerId required' })
      return
    }
    if (socket.data.playerId && socket.data.playerId !== playerId) {
      return ack?.({ ok: false, error: 'Reconnect to change accounts' })
    }
    socket.data.playerId = playerId
    if (account) {
      socket.data.accountId = account.id
      void socket.join(`wallet:${account.id}`)
    }
    socket.data.name = (typeof payload?.name === 'string' ? payload.name : account?.name ?? 'Player').slice(0, 16)
    ack?.({ ok: true })
  }

  let identification = Promise.resolve()
  socket.use(([event, payload, reply], next) => {
    if (event === 'identify') {
      identification = identification.then(() => identify(payload, typeof reply === 'function' ? reply : undefined))
    }
    // Clients may send a room command immediately after identifying.
    void identification.then(() => next(), () => next(new Error('Could not identify player')))
  })

  socket.on('match:clock', (_payload: unknown, ack?: (reply: unknown) => void) => {
    if (typeof ack === 'function') ack({ ok: true, serverNow: Date.now() })
  })

  socket.on('room:create', async (payload: { character?: unknown; entry?: unknown }, ack?: (r: unknown) => void) => {
    const me = identityOf(socket)
    if (!me) return ack?.({ ok: false, error: 'Identify first' })
    if (hasOtherLiveMatch(socket)) return ack?.({ ok: false, error: liveMatchMessage })

    const entry = readMatchEntry(payload?.entry)
    if (entry === undefined) return ack?.({ ok: false, error: 'Choose a listed coin entry.' })
    const blocked = await checkEntry(me.playerId, entry)
    if (blocked) return ack?.({ ok: false, error: blocked })
    if (!socket.connected || roomOfSocket(socket.id)) return ack?.({ ok: false, error: 'Leave your current room first.' })
    const room = createRoom(me.playerId, me.name, false, readCharacter(payload?.character), entry)
    bindSocket(room, me.playerId, socket.id)
    socket.join(room.code)
    ack?.({ ok: true, snapshot: snapshot(room) })
    publish(room)
    trackActivity({ kind: 'room.created', accountId: me.playerId, name: me.name, detail: 'Friends · ' + room.code })
  })

  socket.on('room:quick', async (payload: { character?: unknown; entry?: unknown }, ack?: (r: unknown) => void) => {
    const me = identityOf(socket)
    if (!me) return ack?.({ ok: false, error: 'Identify first' })
    if (hasOtherLiveMatch(socket)) return ack?.({ ok: false, error: liveMatchMessage })
    const entry = readMatchEntry(payload?.entry)
    if (entry === undefined) return ack?.({ ok: false, error: 'Choose a listed coin entry.' })
    const blocked = await checkEntry(me.playerId, entry)
    if (blocked) return ack?.({ ok: false, error: blocked })
    if (!socket.connected) return
    const current = roomOfSocket(socket.id)
    if (current) return ack?.({ ok: true, snapshot: snapshot(current) })
    const open = allRooms().find(room => room.publicTable && room.entry === entry && room.phase === 'lobby' &&
      room.members.length < 4 && !startingRooms.has(room))
    const room = open ?? createRoom(me.playerId, me.name, true, undefined, entry)
    const joined = joinRoom(room.code, me.playerId, me.name, socket.id, readCharacter(payload?.character))
    if (!joined.ok) return ack?.({ ok: false, error: joined.error })
    socket.join(room.code)
    ack?.({ ok: true, snapshot: snapshot(room) })
    publish(room)
    trackActivity({ kind: 'room.joined', accountId: me.playerId, name: me.name, detail: 'Online · ' + room.code })
  })

  socket.on('room:join', async (payload: { code?: string; character?: unknown }, ack?: (r: unknown) => void) => {
    const me = identityOf(socket)
    if (!me) return ack?.({ ok: false, error: 'Identify first' })

    const code = typeof payload?.code === 'string' ? payload.code.trim() : ''
    if (!/^\d{6}$/.test(code)) return ack?.({ ok: false, error: 'Enter the 6-digit code' })

    const room = getRoom(code)
    if (!room) return ack?.({ ok: false, error: 'No room with that code' })
    if (hasOtherLiveMatch(socket, room)) return ack?.({ ok: false, error: liveMatchMessage })
    if (!room.members.some(member => member.playerId === me.playerId)) {
      const blocked = await checkEntry(me.playerId, room.entry)
      if (blocked) return ack?.({ ok: false, error: blocked })
    }
    if (!socket.connected) return
    const current = roomOfSocket(socket.id)
    if (current && current !== room) return ack?.({ ok: false, error: 'Leave your current room first.' })
    if (room !== getRoom(code) || startingRooms.has(room)) return ack?.({ ok: false, error: 'The room is starting. Try again shortly.' })
    const oldSocketId = room.members.find(member => member.playerId === me.playerId)?.socketId
    const result = joinRoom(code, me.playerId, me.name, socket.id, readCharacter(payload?.character))
    if (!result.ok) return ack?.({ ok: false, error: result.error })

    if (oldSocketId && oldSocketId !== socket.id) void io.sockets.sockets.get(oldSocketId)?.leave(code)
    socket.join(code)
    ack?.({ ok: true, snapshot: snapshot(result.room) })
    if (result.room.phase === 'playing') socket.emit('match:started', snapshot(result.room, true))
    publish(result.room)
    trackActivity({ kind: 'room.joined', accountId: me.playerId, name: me.name, detail: 'Room ' + code })
  })

  socket.on('room:suspend', () => {
    const room = roomOfSocket(socket.id)
    if (room?.phase !== 'playing') return
    void socket.leave(room.code)
    markDisconnected(socket.id)
    publish(room)
  })

  socket.on('room:ready', (payload: { ready?: boolean }) => {
    const me = identityOf(socket)
    const room = roomOfSocket(socket.id)
    if (!me || !room || startingRooms.has(room)) return
    setReady(room, me.playerId, !!payload?.ready)
    publish(room)
  })

  socket.on('room:variant', (payload: { variant?: unknown }, ack?: (r: unknown) => void) => {
    const me = identityOf(socket)
    const room = roomOfSocket(socket.id)
    if (!me || !room) return ack?.({ ok: false, error: 'Not in a room' })
    if (startingRooms.has(room)) return ack?.({ ok: false, error: 'This match is starting.' })
    const error = setRoomVariant(room, me.playerId, payload?.variant)
    if (error) return ack?.({ ok: false, error })
    ack?.({ ok: true, snapshot: snapshot(room) })
    publish(room)
  })

  socket.on('room:start', async (_p: unknown, ack?: (r: unknown) => void) => {
    const me = identityOf(socket)
    const room = roomOfSocket(socket.id)
    if (!me || !room) return ack?.({ ok: false, error: 'Not in a room' })
    if (room.hostId !== me.playerId) return ack?.({ ok: false, error: 'Only the host can start' })
    if (startingRooms.has(room)) return ack?.({ ok: false, error: 'This match is starting.' })

    const blocked = canStart(room)
    if (blocked) return ack?.({ ok: false, error: blocked })
    if (fundedRooms.has(room)) return ack?.({ ok: false, error: 'The earlier entry refund is processing. Try again.' })
    if (room.entry) {
      const seats = new Map(room.members.flatMap(member => member.seat === null ? [] : [[member.seat, member.playerId] as const]))
      const pot = { id: randomUUID(), entry: room.entry, accounts: [...seats.values()], expiresAt: Date.now() + POT_LEASE_MS }
      startingRooms.add(room)
      try {
        const store = await accountStore()
        const balances = await store.fundMatchPot(pot)
        fundedRooms.set(room, { pot, seats })
        const sameSeats = room.members.every(member => member.seat === null || seats.get(member.seat) === member.playerId) &&
          room.members.filter(member => member.seat !== null).length === seats.size
        if (!sameSeats || room.hostId !== me.playerId || canStart(room)) {
          void settlePot(room, [])
          return ack?.({ ok: false, error: 'The room changed before the match started. Try again.' })
        }
        for (const { id, coins } of balances) io.to(`wallet:${id}`).emit('wallet:changed', { accountId: id, coins })
      } catch (error) {
        if (error instanceof InsufficientMatchCoins) {
          const player = room.members.find(member => member.playerId === error.accountId)
          return ack?.({ ok: false, error: `${player?.name ?? 'A player'} needs more online coins for this table.` })
        }
        return ack?.({ ok: false, error: 'Could not reserve the entry coins. Try again.' })
      } finally {
        startingRooms.delete(room)
      }
    }

    startMatch(room, Date.now() + 750 + MATCH_INTRO_MS)
    trackMatchStart(room, fundedRooms.get(room)?.pot.id)
    ack?.({ ok: true })
    io.to(room.code).emit('match:started', snapshot(room, true))
    publish(room)
  })

  socket.on('room:leave', () => {
    const me = identityOf(socket)
    const room = roomOfSocket(socket.id)
    if (!me || !room) return
    socket.leave(room.code)
    const seat = seatOf(room, me.playerId)
    if (seat !== null) trackMatchActivity(room, seat, 'match.left')
    if (room.phase === 'playing') {
      const member = room.members.find(item => item.playerId === me.playerId)
      if (member) member.forfeited = true
      markDisconnected(socket.id)
      if (seat !== null && eliminateSeat(room, seat)) settleResults(room)
      publish(room)
      return
    }
    leaveRoom(room, me.playerId)
    if (room.members.length === 0 && room.phase !== 'finished') {
      trackMatchEnd(room, 'abandoned')
      void settlePot(room, [])
    }
    publish(room)
  })

  socket.on('match:roll', (payload: { deadline?: number }, ack?: (r: unknown) => void) => {
    const me = identityOf(socket)
    const room = roomOfSocket(socket.id)
    if (!me || !room) return ack?.({ ok: false, error: 'Not in a room' })
    const seat = seatOf(room, me.playerId)
    if (seat === null) return ack?.({ ok: false, error: 'No seat' })
    if (payload?.deadline !== undefined && payload.deadline !== room.match?.deadline) {
      return ack?.({ ok: false, error: 'Your turn changed.' })
    }

    const result = performRoll(room, seat)
    ack?.('error' in result ? { ok: false, error: result.error } : { ok: true })
  })

  socket.on('match:reaction', (payload: { kind?: unknown; to?: unknown; tokenId?: unknown }, reply?: (r: unknown) => void) => {
    if (typeof reply !== 'function') return
    const room = roomOfSocket(socket.id)
    const sender = room?.members.find(member => member.socketId === socket.id && member.connected)
    if (room?.phase !== 'playing' || !room.match || !sender || sender.seat === null ||
      room.match.eliminated.includes(sender.seat)) return reply({ ok: false, error: 'Join an active match first.' })
    if (typeof payload?.kind !== 'string' || !reactions.has(payload.kind) || !room.members.some(
      member => member.seat !== null && member.connected && member.seat === payload.to && member.seat !== sender.seat
        && !room.match?.eliminated.includes(member.seat),
    )) return reply({ ok: false, error: 'Choose a connected player and a reaction.' })
    const tokenId = payload.kind === 'bomb' ? undefined : payload.tokenId
    if (tokenId !== undefined && !room.match.tokens.some(token => token.id === tokenId && token.seat === payload.to)) {
      return reply({ ok: false, error: 'Choose a pawn belonging to that player.' })
    }
    const now = Date.now()
    if (now < (reactionAvailableAt.get(room) ?? 0)) return reply({ ok: false, error: 'Wait for the current reaction to finish.' })
    // Reserve the room for the launch delay plus the visual effect.
    reactionAvailableAt.set(room, now + (payload.kind === 'bomb' ? 6900 : 4850))
    trackMatchActivity(room, sender.seat, 'match.reaction', payload.kind)
    io.to(room.code).emit('match:reaction', { roomCode: room.code, kind: payload.kind, from: sender.seat,
      to: payload.to, tokenId, serverNow: now, startsAt: now + REACTION_LEAD_MS })
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
    soundAvailableAt.set(room, now + (clip === 11 ? SOUND_LEAD_MS + 6100 : 900))
    if (sender.seat !== null) trackMatchActivity(room, sender.seat, 'match.sound', 'Clip ' + clip)
    io.to(room.code).emit('match:sound', { roomCode: room.code, clip, serverNow: now, startsAt: now + SOUND_LEAD_MS })
    reply({ ok: true })
  })

  socket.on('match:move', (payload: { tokenId?: string; deadline?: number }, ack?: (r: unknown) => void) => {
    const me = identityOf(socket)
    const room = roomOfSocket(socket.id)
    if (!me || !room) return ack?.({ ok: false, error: 'Not in a room' })
    const seat = seatOf(room, me.playerId)
    if (seat === null) return ack?.({ ok: false, error: 'No seat' })
    if (payload?.deadline !== undefined && payload.deadline !== room.match?.deadline) {
      return ack?.({ ok: false, error: 'Your turn changed.' })
    }
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
      const seat = m.current
      if (missRoll(room)) {
        trackMatchActivity(room, seat, 'match.eliminated', 'Five missed dice rolls')
        settleResults(room)
        publish(room)
      } else performRoll(room, seat, false)
    } else if (m.phase === 'await-move') {
      const tokenId = autoPick(room)
      if (tokenId) performMove(room, m.current, tokenId)
    }
  }
  for (const room of sweepIdleRooms()) if (room.phase !== 'finished') {
    trackMatchEnd(room, 'abandoned')
    void settlePot(room, [])
  }
}, 1000)

let maintainingPots = false
setInterval(async () => {
  if (maintainingPots) return
  maintainingPots = true
  try {
    const store = await accountStore()
    const now = Date.now()
    await store.renewMatchPots([...fundedRooms.values()].map(({ pot }) => pot.id), now + POT_LEASE_MS)
    for (const [room, funded] of fundedRooms) if (funded.winners) await settlePot(room, funded.winners)
    for (const pot of await store.expiredMatchPots(now)) {
      if (await store.settleMatchPot(pot.id, [], now)) walletChanged(pot.accounts)
    }
  } catch (error) {
    console.warn('[match pot] Maintenance will retry:', error instanceof Error ? error.name : 'Unknown error')
  } finally {
    maintainingPots = false
  }
}, 30_000).unref()

function roomsNeedingAttention(now: number): Room[] {
  return allRooms().filter((room) => {
    const m = room.match
    return !!m && room.phase === 'playing' && m.phase !== 'ended' && now >= m.deadline
  })
}

http.listen({ port:PORT, host:process.env.LUDO_BIND_HOST }, () => {
  console.log(`[ludo] listening on :${PORT} (turn clock ${TURN_MS / 1000}s)`)
})
