import assert from 'node:assert/strict'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { io } from 'socket.io-client'

const base = process.env.URL ?? 'http://localhost:8080'
const clients = []
async function connect(namespace = '/voice') {
  const socket = io(base + namespace, { transports: ['websocket'], reconnection: false, forceNew: true })
  clients.push(socket)
  await once(socket, 'connect', { signal: AbortSignal.timeout(5000) })
  return socket
}
const enter = (s, options) => s.timeout(3000).emitWithAck('enter', { name: 'Tester', ...options })
const call = (s, event, payload) => s.timeout(3000).emitWithAck(event, payload)
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

  const [gameHost, gameGuest, listener] = await Promise.all([connect('/'), connect('/'), connect('/')])
  await call(gameHost, 'identify', { playerId:'voice-host', name:'Host' })
  await call(gameGuest, 'identify', { playerId:'voice-guest', name:'Guest' })
  assert.equal((await call(listener, 'match:voice', {})).ok, false)
  const created = await call(gameHost, 'room:create', {})
  const matchCode = created.snapshot.code
  assert.equal((await call(gameHost, 'match:voice', {})).ok, false, 'voice opens once the match starts')
  assert.equal((await call(gameGuest, 'room:join', { code:matchCode })).ok, true)
  gameGuest.emit('room:ready', { ready:true })
  await once(gameHost, 'room:state', { signal:AbortSignal.timeout(3000) })
  assert.equal((await call(gameHost, 'room:start', {})).ok, true)
  const hostTicket = (await call(gameHost, 'match:voice', {})).ticket
  const guestTicket = (await call(gameGuest, 'match:voice', {})).ticket
  const [hostMic, guestMic, outsiderMic] = await Promise.all([connect(), connect(), connect()])
  assert.ok((await call(outsiderMic, 'enterMatch', matchCode)).error)
  const hosted = await call(hostMic, 'enterMatch', hostTicket)
  assert.equal(hosted.members[0].muted, true)
  assert.ok((await call(outsiderMic, 'enterMatch', hostTicket)).error, 'tickets cannot be replayed')
  assert.equal((await call(guestMic, 'enterMatch', guestTicket)).members.length, 2)
  for (const [sender, receiver] of [[hostMic, guestMic], [guestMic, hostMic]]) {
    sender.emit('mute', false)
    const delivered = once(receiver, 'audio', { signal:AbortSignal.timeout(3000) })
    sender.emit('audio', frame)
    assert.deepEqual(await delivered, [sender.id, frame])
  }
  const stopped = once(guestMic, 'disconnect', { signal:AbortSignal.timeout(3000) })
  gameGuest.emit('room:leave')
  await stopped
  console.log('Friends match passed: seats only, starts muted, single-use admission, two-way audio and voice closes on leave.')
} finally {
  clients.forEach((client) => client.disconnect())
}
