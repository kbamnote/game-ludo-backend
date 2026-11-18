import { randomInt } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import type { Server } from 'socket.io'

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
type Member = { id: string; name: string; muted: boolean }
type Lounge = Map<string, Member>

export function attachVoice(io: Server) {
  const voice = io.of('/voice')
  const rooms = new Map<string, Lounge>()
  voice.on('connection', (socket) => {
    let code = ''
    let allowance = 15
    let lastFrame = performance.now()
    const roster = () => voice.to(code).emit('roster', [...(rooms.get(code)?.values() ?? [])])
    function leave() {
      const room = rooms.get(code)
      if (!room) return
      room.delete(socket.id)
      void socket.leave(code)
      if (room.size === 0) rooms.delete(code)
      else roster()
      code = ''
    }
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
      code = key
      room.set(socket.id, { id: socket.id, name, muted: true })
      void socket.join(code)
      reply({ code, members: [...room.values()] })
      roster()
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
      socket.to(code).volatile.emit('audio', socket.id, frame)
    })
    socket.on('leave', leave)
    socket.on('disconnect', leave)
  })
}
