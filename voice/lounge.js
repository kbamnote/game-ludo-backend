'use strict'

const el = (id) => document.getElementById(id)
const nameField = el('name')
const codeField = el('code')
nameField.value = new URLSearchParams(location.hash.slice(1)).get('name')?.slice(0, 16) || 'Player'
let socket = null
let context = null
let roomCode = ''
let stream = null
let input = null
let capture = null
let micRequest = 0
const playAt = new Map()

function notice(message) { el('status').textContent = message }

function stopMic() {
  micRequest++
  if (capture) {
    capture.port.onmessage = null
    capture.port.close()
    capture.disconnect()
  }
  input?.disconnect()
  stream?.getTracks().forEach((track) => track.stop())
  capture = input = stream = null
  if (roomCode && socket?.connected) socket.emit('mute', true)
  el('mic').textContent = 'Unmute microphone'
  el('mic').disabled = false
}

function leave(message = '') {
  stopMic()
  roomCode = ''
  if (socket) { socket.removeAllListeners(); socket.disconnect(); socket = null }
  if (context) {
    context.onstatechange = null
    void context.close().catch(() => {})
    context = null
  }
  playAt.clear()
  el('setup').hidden = false
  el('lounge').hidden = true
  el('create').disabled = el('join').disabled = false
  notice(message)
}

function roster(members) {
  const ids = new Set(members.map((member) => member.id))
  for (const id of playAt.keys()) if (!ids.has(id)) playAt.delete(id)
  el('members').replaceChildren(...members.map((member) => {
    const li = document.createElement('li')
    const state = document.createElement('span')
    state.textContent = member.muted ? 'Muted' : 'Mic on'
    li.append(member.name + (member.id === socket?.id ? ' (you)' : ''), state)
    return li
  }))
}

function play(id, frame) {
  if (!roomCode || context?.state !== 'running' || !(frame instanceof ArrayBuffer) || frame.byteLength !== 960) return
  const now = context.currentTime
  const next = playAt.get(id) || 0
  // Drop backed-up packets instead of letting a slow connection delay the conversation.
  if (next > now + 0.18) return
  const start = next > now ? next : now + 0.045
  const pcm = new Int16Array(frame)
  const buffer = context.createBuffer(1, pcm.length, 24000)
  const output = buffer.getChannelData(0)
  for (let i = 0; i < pcm.length; i++) output[i] = pcm[i] / 32768
  const source = context.createBufferSource()
  source.buffer = buffer
  source.connect(context.destination)
  source.onended = () => source.disconnect()
  source.start(start)
  playAt.set(id, start + buffer.duration)
}

function enter(create) {
  if (socket) return
  const code = codeField.value.trim().toUpperCase()
  if (!create && !/^[A-Z2-9]{8}$/.test(code)) return notice('Enter the eight-character code from your friend.')
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) return notice('Voice needs a secure HTTPS connection and microphone support.')
  try {
    context = new AudioContext()
    el('resume').hidden = true
    context.onstatechange = () => { el('resume').hidden = context?.state === 'running' }
    void context.resume().catch(() => { el('resume').hidden = false })
    socket = io('/voice', { transports: ['websocket'], reconnection: false, timeout: 10000, autoConnect: false })
  } catch { return leave('Audio could not start on this device.') }
  const session = socket
  el('create').disabled = el('join').disabled = true
  notice('Connecting to the voice room…')
  session.on('connect_error', () => leave('Could not reach the Ludo voice server. Try again.'))
  session.on('disconnect', () => leave('Voice disconnected. You can rejoin with your room code.'))
  session.on('roster', roster)
  session.on('audio', play)
  session.on('connect', () => {
    session.timeout(8000).emit('enter', { create, code, name: nameField.value }, (error, reply) => {
      if (session !== socket) return
      if (error || !reply?.code) return leave(reply?.error || 'The voice server did not respond.')
      roomCode = reply.code
      codeField.value = roomCode
      el('roomCode').textContent = roomCode
      el('setup').hidden = true
      el('lounge').hidden = false
      roster(reply.members)
      notice('Microphone muted. Unmute when you want to speak.')
    })
  })
  session.connect()
}

async function toggleMic() {
  if (stream) { stopMic(); return notice('Microphone muted.') }
  if (!socket?.connected || !roomCode || !context) return
  const request = ++micRequest
  const audio = context
  el('mic').disabled = true
  try {
    await audio.resume()
    await audio.audioWorklet.addModule('./microphone.js')
    if (request !== micRequest) return
    const media = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false,
    })
    if (request !== micRequest) { media.getTracks().forEach((track) => track.stop()); return }
    stream = media
    input = audio.createMediaStreamSource(media)
    capture = new AudioWorkletNode(audio, 'voice-capture')
    capture.port.onmessage = ({ data }) => {
      if (stream && socket?.connected) socket.volatile.emit('audio', data)
    }
    input.connect(capture)
    // The worklet writes no output samples. Connecting keeps its render clock active.
    capture.connect(audio.destination)
    media.getAudioTracks()[0].onended = () => { stopMic(); notice('Microphone disconnected.') }
    socket.emit('mute', false)
    el('mic').textContent = 'Mute microphone'
    notice('Your microphone is live.')
  } catch (error) {
    if (request !== micRequest) return
    stopMic()
    notice(error.name === 'NotAllowedError' ? 'Microphone permission was denied. You can still listen.' : 'Could not start the microphone. Check your audio device and try again.')
  } finally {
    if (request === micRequest) el('mic').disabled = false
  }
}

el('joinForm').onsubmit = (event) => { event.preventDefault(); enter(false) }
el('create').onclick = () => enter(true)
el('mic').onclick = toggleMic
el('leave').onclick = () => leave('You left the lounge.')
el('resume').onclick = () => context?.resume().catch(() => notice('Sound is paused by your device.'))
el('invite').onclick = async () => {
  if (window.ReactNativeWebView) { window.ReactNativeWebView.postMessage(JSON.stringify({ shareCode: roomCode })); return }
  try {
    await navigator.clipboard.writeText(roomCode)
    notice('Room code copied.')
  } catch { notice('Share this room code with your friends: ' + roomCode) }
}
function pauseVoice() {
  if (!roomCode) return
  stopMic()
  notice('Microphone muted while you were away.')
}
document.addEventListener('visibilitychange', () => { if (document.hidden) pauseVoice() })
document.addEventListener('voice-background', pauseVoice)
window.addEventListener('pagehide', () => leave())
