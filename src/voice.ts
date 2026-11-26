import { randomBytes, randomInt } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import type { Server } from 'socket.io'
import { getRoom, roomOfSocket } from './room.js'

const files = [
  ['/voice/', 'index.html', 'text/html; charset=utf-8'],
  ['/voice/lounge.js', 'lounge.js', 'text/javascript; charset=utf-8'],
  ['/voice/microphone.js', 'microphone.js', 'text/javascript; charset=utf-8'],
  ['/voice/lounge.css', 'lounge.css', 'text/css; charset=utf-8'],
] as const
const assets = new Map<string, { type: string; body: Buffer }>(files.map(([path, file, type]) =>
  [path, { type, body: readFileSync(new URL('../voice/' + file, import.meta.url)) }]))

export function serveVoice(path: string, res: ServerResponse) {
  const asset = assets.get(path)
  if (!asset) return false
  res.writeHead(200, {
    'content-type': asset.type,
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    'permissions-policy': 'camera=(), microphone=(self)',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; form-action 'none'",
  })
  res.end(asset.body)
  return true
}

const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const frameBytes = 960 // 20 ms of mono signed 16-bit PCM at 24 kHz
type Member = { id: string; name: string; muted: boolean; seat?: number }
type Lounge = Map<string, Member>

export function attachVoice(io: Server) {
  const voice = io.of('/voice')
  const rooms = new Map<string, Lounge>()
  const tickets = new Map<string, { socketId: string; roomCode: string }>()
  const matchSessions = new Map<string, () => void>()
  const gameSocketsByVoice = new Map<string, string>()
  const friendsRoom = (id: string) => {
    const room = roomOfSocket(id)
    const member = room?.members.find(member => member.socketId === id && member.connected && member.seat !== null)
    const seat = member?.seat
    return room?.phase === 'playing' && !room.publicTable && room.match && member && seat != null
      ? { room, member, seat, opensAt: room.match.opensAt } : undefined
  }
  io.on('connection', socket => {
    let ticket: string | undefined
    let expiration: ReturnType<typeof setTimeout> | undefined
    const clearTicket = () => {
      if (ticket) tickets.delete(ticket)
      clearTimeout(expiration)
    }
    const exitVoice = () => { clearTicket(); matchSessions.get(socket.id)?.() }
    socket.on('room:leave', exitVoice)
    socket.on('room:suspend', exitVoice)
    socket.on('disconnect', exitVoice)
    socket.on('match:voice', (request, reply) => {
      if (typeof reply !== 'function') return
      const match = friendsRoom(socket.id)
      if (!match || (request?.code !== undefined && request.code !== match.room.code)) {
        return reply({ ok: false, code: 'VOICE_SEAT_REQUIRED', error: 'Join a Friends match to use its voice chat.' })
      }
      clearTicket()
      ticket = randomBytes(24).toString('base64url')
      tickets.set(ticket, { socketId: socket.id, roomCode: match.room.code })
      expiration = setTimeout(clearTicket, 120_000)
      expiration.unref()
      reply({ ok: true, ticket })
    })
  })
  voice.on('connection', (socket) => {
    let code = ''
    let allowance = 15
    let lastFrame = performance.now()
    let gameSocketId: string | undefined
    let gameRoomCode: string | undefined
    const roster = () => voice.to(code).emit('roster', [...(rooms.get(code)?.values() ?? [])])
    function leave() {
      if (gameSocketId) matchSessions.delete(gameSocketId)
      gameSocketsByVoice.delete(socket.id)
      gameSocketId = gameRoomCode = undefined
      const room = rooms.get(code)
      if (!room) return
      room.delete(socket.id)
      void socket.leave(code)
      if (room.size === 0) rooms.delete(code)
      else roster()
      code = ''
    }
    function join(key: string, room: Lounge, name: string, reply: (result: unknown) => void,
      match?: { seat: number; id: string }) {
      code = key
      room.set(socket.id, { id: socket.id, name, muted: true, ...(match && { seat: match.seat }) })
      void socket.join(code)
      reply({ code, members: [...room.values()], ...(match && { matchId: match.id }) })
      roster()
    }
    socket.on('enterMatch', (ticket, reply) => {
      if (typeof reply !== 'function') return
      if (code || typeof ticket !== 'string') return reply({ error: 'Invalid match voice session.' })
      const grant = tickets.get(ticket)
      if (grant) tickets.delete(ticket)
      const match = grant && friendsRoom(grant.socketId)
      if (!grant || !match || match.room.code !== grant.roomCode) {
        return reply({ error: 'Reopen Voice chat in your match to connect.' })
      }
      matchSessions.get(grant.socketId)?.()
      gameSocketId = grant.socketId
      gameRoomCode = grant.roomCode
      matchSessions.set(grant.socketId, () => socket.disconnect())
      gameSocketsByVoice.set(socket.id, grant.socketId)
      const key = 'match:' + grant.roomCode
      const room = rooms.get(key) ?? new Map()
      rooms.set(key, room)
      join(key, room, match.member.name, reply, {
        seat: match.seat,
        id: grant.roomCode + ':' + match.opensAt,
      })
    })
    socket.on('enter', (request, reply) => {
      if (typeof reply !== 'function') return
      if (code) return reply({ error: 'Leave your current lounge first.' })
      if (typeof request?.name !== 'string') return reply({ error: 'Enter a player name.' })
      const name = request.name.trim().slice(0, 16) || 'Player'
      let key = request.code
      if (request.create === true) {
        do { key = Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join('') } while (rooms.has(key))
        rooms.set(key, new Map())
      }
      const room = typeof key === 'string' ? rooms.get(key) : undefined
      if (!room) return reply({ error: 'Lounge not found. Check the eight-character code.' })
      if (room.size >= 4) return reply({ error: 'This lounge has four players already.' })
      join(key, room, name, reply)
    })
    socket.on('mute', (muted) => {
      const member = rooms.get(code)?.get(socket.id)
      if (!member || typeof muted !== 'boolean' || member.muted === muted) return
      member.muted = muted
      roster()
    })
    socket.on('audio', (frame: unknown) => {
      const member = rooms.get(code)?.get(socket.id)
      if (!member || member.muted || !Buffer.isBuffer(frame) || frame.length !== frameBytes) return
      const now = performance.now()
      allowance = Math.min(15, allowance + (now - lastFrame) * 0.055)
      lastFrame = now
      if (allowance < 1) return
      allowance--
      if (gameRoomCode) {
        const match = getRoom(gameRoomCode)
        const activeSeats = match?.phase === 'playing' ? match.members.filter(member => member.connected && member.seat !== null) : []
        if (!activeSeats.some(member => member.socketId === gameSocketId)) { socket.disconnect(); return }
        for (const id of rooms.get(code)?.keys() ?? []) {
          if (id !== socket.id && activeSeats.some(member => member.socketId === gameSocketsByVoice.get(id))) {
            voice.sockets.get(id)?.volatile.emit('audio', socket.id, frame)
          }
        }
        return
      }
      socket.to(code).volatile.emit('audio', socket.id, frame)
    })
    socket.on('leave', leave)
    socket.on('disconnect', leave)
  })
}
