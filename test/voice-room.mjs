import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { on, once } from 'node:events'
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
async function waitForReady(socket, name) {
  for await (const [snapshot] of on(socket, 'room:state', { signal: AbortSignal.timeout(5000) })) {
    if (snapshot.members.some(member => member.name === name && member.ready)) return
  }
}
async function waitForUnmute(socket) {
  for await (const [members] of on(socket, 'roster', { signal: AbortSignal.timeout(5000) })) {
    if (members.some(member => member.id === socket.id && !member.muted)) return
  }
}

let step = 'lounge'
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

  step = 'Friends room creation'
  const [gameHost, gameGuest, listener] = await Promise.all([connect('/'), connect('/'), connect('/')])
  const guestId = randomUUID()
  assert.equal((await call(gameHost, 'identify', { playerId:randomUUID(), name:'Voice Test Host' })).ok, true)
  assert.equal((await call(gameGuest, 'identify', { playerId:guestId, name:'Voice Test Guest' })).ok, true)
  assert.equal((await call(listener, 'match:voice', {})).ok, false)
  const created = await call(gameHost, 'room:create', {})
  assert.equal(created.ok, true, created.error)
  const matchCode = created.snapshot.code
  assert.equal((await call(gameHost, 'match:voice', {})).ok, false, 'voice opens once the match starts')
  assert.equal((await call(gameGuest, 'room:join', { code:matchCode })).ok, true)
  step = 'Friends guest ready and start'
  const ready = waitForReady(gameHost, 'Voice Test Guest')
  gameGuest.emit('room:ready', { ready:true })
  await ready
  assert.equal((await call(gameHost, 'room:start', {})).ok, true)
  step = 'Friends voice admission'
  const payload = { code: matchCode }
  const reconnectedGuest = await connect('/')
  gameGuest.disconnect()
  assert.equal((await call(reconnectedGuest, 'identify', { playerId:guestId, name:'Voice Test Guest' })).ok, true)
  assert.equal((await call(reconnectedGuest, 'match:voice', payload)).ok, false, 'identifying alone does not restore voice')
  assert.equal((await call(reconnectedGuest, 'room:join', payload)).snapshot.phase, 'playing')
  const hostTicket = (await call(gameHost, 'match:voice', payload)).ticket
  const guestTicket = (await call(reconnectedGuest, 'match:voice', payload)).ticket
  const [hostMic, guestMic, outsiderMic] = await Promise.all([connect(), connect(), connect()])
  assert.ok((await call(outsiderMic, 'enterMatch', matchCode)).error)
  const hosted = await call(hostMic, 'enterMatch', hostTicket)
  assert.equal(hosted.members[0].muted, true)
  assert.equal(hosted.members[0].seat, 0)
  assert.match(hosted.matchId, /^\d{6}:\d+$/)
  assert.ok((await call(outsiderMic, 'enterMatch', hostTicket)).error, 'tickets cannot be replayed')
  const joinedVoice = await call(guestMic, 'enterMatch', guestTicket)
  assert.equal(joinedVoice.matchId, hosted.matchId)
  assert.deepEqual(joinedVoice.members.map(member => member.seat), [0, 2])
  for (const [sender, receiver] of [[hostMic, guestMic], [guestMic, hostMic]]) {
    step = sender === hostMic ? 'host-to-guest audio' : 'guest-to-host audio'
    const unmuted = waitForUnmute(sender)
    sender.emit('mute', false)
    await unmuted
    const delivered = once(receiver, 'audio', { signal:AbortSignal.timeout(5000) })
    const senderFrames = setInterval(() => sender.volatile.emit('audio', frame), 20)
    try {
      assert.deepEqual(await delivered, [sender.id, frame])
    } finally {
      clearInterval(senderFrames)
    }
  }
  step = 'voice disconnect on game room leave'
  const stopped = once(guestMic, 'disconnect', { signal:AbortSignal.timeout(3000) })
  reconnectedGuest.emit('room:leave')
  await stopped
  console.log('Friends match passed: seats only, starts muted, single-use admission, two-way audio and voice closes on leave.')
} catch (error) {
  console.error('Voice test failed during ' + step)
  throw error
} finally {
  clients.forEach((client) => client.disconnect())
}
