import assert from 'node:assert/strict'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { io } from 'socket.io-client'

const base = process.env.URL ?? 'http://localhost:8080'
const clients = []
async function connect() {
  const socket = io(base + '/voice', { transports: ['websocket'], reconnection: false, forceNew: true })
  clients.push(socket)
  await once(socket, 'connect', { signal: AbortSignal.timeout(5000) })
  return socket
}
const enter = (s, options) => s.timeout(3000).emitWithAck('enter', { name: 'Tester', ...options })
const frame = Buffer.alloc(960, 23)
try {
  const [host, guest, outside, third, fourth] = await Promise.all(Array.from({ length: 5 }, connect))
  const room = await enter(host, { create: true })
  const { code } = room
  assert.match(code, /^[A-Z2-9]{8}$/)
  assert.equal(room.members[0].muted, true)
  assert.equal((await enter(guest, { code })).members.length, 2)
  await enter(third, { code })
  await enter(fourth, { code })
  assert.ok((await enter(outside, { code })).error)
  assert.notEqual((await enter(outside, { create: true })).code, code)
  let received = 0
  let leaked = 0
  guest.on('audio', () => received++)
  outside.on('audio', () => leaked++)
  host.emit('audio', frame)
  await delay(100)
  assert.equal(received, 0, 'a newly joined microphone is muted')
  host.emit('mute', false)
  host.emit('audio', Buffer.alloc(500))
  const next = once(guest, 'audio', { signal: AbortSignal.timeout(2000) })
  host.emit('audio', frame)
  const [sender, audio] = await next
  assert.equal(sender, host.id)
  assert.deepEqual(audio, frame)
  host.emit('mute', true)
  host.emit('audio', frame)
  host.emit('leave')
  host.emit('mute', false)
  host.emit('audio', frame)
  await delay(100)
  assert.equal(received, 1)
  assert.equal(leaked, 0)
  guest.disconnect()
  third.disconnect()
  fourth.disconnect()
  await delay(100)
  assert.ok((await enter(host, { code })).error, 'empty rooms expire')
  console.log('Voice passed: room capacity, membership, binary audio, mute, isolation and cleanup.')
} finally {
  clients.forEach((client) => client.disconnect())
}
