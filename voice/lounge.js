'use strict'

const el = (id) => document.getElementById(id)
const nameField = el('name')
const codeField = el('code')
const params = new URLSearchParams(location.hash.slice(1))
const matchTicket = params.get('match')
const autoJoinMatch = !!matchTicket && params.get('auto') === '1'
const autoStartMic = autoJoinMatch && params.get('mic') === '1'
let startMatchMic = autoStartMic
nameField.value = params.get('name')?.slice(0, 16) || 'Player'
if (matchTicket) {
  document.documentElement.classList.add('match-chat')
  el('setup').hidden = true
  el('matchSetup').hidden = autoJoinMatch
}
let socket = null
let context = null
let speaker = null
let speakerMuted = false
let roomCode = ''
let stream = null
let input = null
let capture = null
let micRequest = 0
let micStartupTimer
const playAt = new Map()
const playerOutputs = new Map()
const playerSeats = new Map()
const mutedSeats = new Set()
const muteStorageKey = 'friends-voice-muted-players'
let matchId = ''

// The app and the web preview both embed this page; report status to whichever
// is hosting it so the failure is readable outside the lounge's own panel.
const hostOrigin = (() => {
  try {
    if (window.parent !== window && document.referrer) return new URL(document.referrer).origin
  } catch { /* An opaque referrer leaves the preview without a host origin. */ }
  return ''
})()

function notice(message) {
  el('status').textContent = message
  if (!message) return
  const payload = {
    voiceStatus: message,
    joined: Boolean(roomCode),
    live: Boolean(stream),
    audio: context ? context.state : 'none',
  }
  try { window.ReactNativeWebView?.postMessage(JSON.stringify(payload)) }
  catch { /* Not embedded in the app. */ }
  if (hostOrigin) {
    try { window.parent.postMessage({ type: 'voice-status', ...payload }, hostOrigin) }
    catch { /* The host page went away. */ }
  }
}

function stopMic() {
  micRequest++
  clearTimeout(micStartupTimer)
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
    speaker = null
  }
  playAt.clear()
  playerOutputs.clear()
  playerSeats.clear()
  mutedSeats.clear()
  matchId = ''
  el('setup').hidden = Boolean(matchTicket)
  el('matchSetup').hidden = !matchTicket || autoJoinMatch
  el('lounge').hidden = true
  el('create').disabled = el('join').disabled = el('joinMatch').disabled = false
  notice(message)
}

function roster(members) {
  const ids = new Set(members.map((member) => member.id))
  for (const id of playerOutputs.keys()) if (!ids.has(id)) clearPlayerAudio(id)
  for (const id of playAt.keys()) if (!ids.has(id)) playAt.delete(id)
  if (matchTicket) {
    const peers = members.filter(member => member.id !== socket?.id && Number.isInteger(member.seat)
      && member.seat >= 0 && member.seat <= 3)
    playerSeats.clear()
    for (const member of peers) playerSeats.set(member.id, member.seat)
    el('playerAudio').hidden = peers.length === 0
    el('playerAudioList').replaceChildren(...peers.map(member => {
      const row = document.createElement('li')
      const name = document.createElement('span')
      name.textContent = 'P' + (member.seat + 1) + ' · ' + member.name
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'secondary'
      button.setAttribute('aria-label', 'Mute voice for ' + name.textContent)
      const update = () => {
        const muted = mutedSeats.has(member.seat)
        button.textContent = muted ? 'Unmute' : 'Mute'
        button.setAttribute('aria-pressed', String(muted))
      }
      button.onclick = () => {
        if (mutedSeats.has(member.seat)) mutedSeats.delete(member.seat)
        else {
          mutedSeats.add(member.seat)
          for (const [id, seat] of playerSeats) if (seat === member.seat) clearPlayerAudio(id)
        }
        if (matchId) {
          try { localStorage.setItem(muteStorageKey, JSON.stringify({ matchId, seats: [...mutedSeats] })) }
          catch { /* The setting still applies to this connection. */ }
        }
        update()
      }
      update()
      row.append(name, button)
      return row
    }))
    return
  }
  el('members').replaceChildren(...members.map((member) => {
    const li = document.createElement('li')
    const state = document.createElement('span')
    state.textContent = member.muted ? 'Muted' : 'Mic on'
    li.append(member.name + (member.id === socket?.id ? ' (you)' : ''), state)
    return li
  }))
}

function clearPlayerAudio(id) {
  playerOutputs.get(id)?.disconnect()
  playerOutputs.delete(id)
  playAt.delete(id)
}

function play(id, frame) {
  if (!roomCode || !speaker || speakerMuted || context?.state !== 'running' || !(frame instanceof ArrayBuffer) || frame.byteLength !== 960) return
  if (mutedSeats.has(playerSeats.get(id))) return
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
  let destination = speaker
  if (matchTicket) {
    destination = playerOutputs.get(id)
    if (!destination) {
      destination = context.createGain()
      destination.connect(speaker)
      playerOutputs.set(id, destination)
    }
  }
  source.connect(destination)
  source.onended = () => source.disconnect()
  source.start(start)
  playAt.set(id, start + buffer.duration)
}

function startPendingMicrophone() {
  if (!startMatchMic || !roomCode || document.hidden || context?.state !== 'running') return false
  void toggleMic()
  return true
}

function enter(create) {
  if (socket) return
  const code = codeField.value.trim().toUpperCase()
  if (!matchTicket && !create && !/^[A-Z2-9]{8}$/.test(code)) return notice('Enter the eight-character code from your friend.')
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) return notice('Voice needs a secure HTTPS connection and microphone support.')
  try {
    context = new AudioContext()
    speaker = context.createGain()
    speaker.gain.value = speakerMuted ? 0 : 1
    speaker.connect(context.destination)
    const updatePlayback = () => {
      el('resume').hidden = context?.state === 'running'
      if (!roomCode || context?.state !== 'running') return
      if (startPendingMicrophone()) return
      if (el('status').textContent === 'Tap Resume sound to start voice audio.') {
        notice(stream ? 'Your microphone is live.' : 'Listening to match voice.')
      }
    }
    context.onstatechange = updatePlayback
    updatePlayback()
    void context.resume().then(updatePlayback, updatePlayback)
    socket = io('/voice', { transports: ['websocket'], reconnection: false, timeout: 10000, autoConnect: false })
  } catch { return leave('Audio could not start on this device.') }
  const session = socket
  el('create').disabled = el('join').disabled = el('joinMatch').disabled = true
  notice('Connecting to the voice room…')
  session.on('connect_error', () => leave('Could not reach the Ludo voice server. Try again.'))
  session.on('disconnect', () => leave(matchTicket
    ? 'Voice disconnected. Close and reopen Voice chat to reconnect.'
    : 'Voice disconnected. You can rejoin with your room code.'))
  session.on('roster', roster)
  session.on('audio', play)
  session.on('connect', () => {
    const event = matchTicket ? 'enterMatch' : 'enter'
    const payload = matchTicket ?? { create, code, name: nameField.value }
    session.timeout(8000).emit(event, payload, (error, reply) => {
      if (session !== socket) return
      if (error || !reply?.code) return leave(reply?.error || 'The voice server did not respond.')
      roomCode = reply.code
      if (matchTicket && typeof reply.matchId === 'string') {
        matchId = reply.matchId
        try {
          const saved = JSON.parse(localStorage.getItem(muteStorageKey))
          if (saved?.matchId === matchId && Array.isArray(saved.seats)) {
            for (const seat of saved.seats) if (Number.isInteger(seat) && seat >= 0 && seat <= 3) mutedSeats.add(seat)
          }
        } catch { /* Voice works when storage is unavailable. */ }
      }
      codeField.value = roomCode
      el('roomCode').textContent = roomCode
      el('setup').hidden = true
      el('matchSetup').hidden = true
      el('lounge').hidden = false
      roster(reply.members)
      el('mic').hidden = autoJoinMatch && !autoStartMic
      if (!startPendingMicrophone()) {
        notice(context.state !== 'running' ? 'Tap Resume sound to start voice audio.'
          : autoJoinMatch ? 'Listening to match voice.' : 'Microphone muted. Unmute when you want to speak.')
      }
    })
  })
  session.connect()
}

function setSpeakerMuted(muted) {
  if (!matchTicket || typeof muted !== 'boolean' || muted === speakerMuted) return
  speakerMuted = muted
  if (speaker) speaker.gain.value = muted ? 0 : 1
  if (muted) playAt.clear()
}

document.addEventListener('voice-speaker', (event) => setSpeakerMuted(event.detail))
window.addEventListener('message', (event) => {
  if (event.source === window.parent && event.data?.type === 'voice-speaker') setSpeakerMuted(event.data.muted)
})

async function toggleMic() {
  if (!socket?.connected || !roomCode || !context) return
  startMatchMic = false
  if (stream) { stopMic(); return notice('Microphone muted.') }
  const request = ++micRequest
  const audio = context
  el('mic').disabled = true
  notice('Starting microphone…')
  try {
    // Start resuming from the same tap that requests the microphone.
    const ready = audio.resume()
    void ready.catch(() => { el('resume').hidden = false })
    // Start the permission request from the button gesture, before loading the processor.
    const media = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false,
    })
    if (request !== micRequest) { media.getTracks().forEach((track) => track.stop()); return }
    stream = media
    void audio.resume().catch(() => { el('resume').hidden = false })
    await audio.audioWorklet.addModule('./microphone.js')
    if (request !== micRequest) return
    input = audio.createMediaStreamSource(media)
    capture = new AudioWorkletNode(audio, 'voice-capture')
    let receiving = false
    micStartupTimer = setTimeout(() => {
      if (request !== micRequest || receiving) return
      stopMic()
      notice(audio.state === 'running' ? 'The microphone sent no audio. Tap Unmute microphone to retry.'
        : 'Tap Resume sound to start voice audio.')
    }, 3500)
    capture.port.onmessage = ({ data }) => {
      if (request !== micRequest || !stream || !socket?.connected) return
      if (!(data instanceof ArrayBuffer) || data.byteLength !== 960) return
      if (!receiving) {
        receiving = true
        clearTimeout(micStartupTimer)
        socket.emit('mute', false)
        el('mic').textContent = 'Mute microphone'
        notice('Your microphone is live.')
      }
      socket.volatile.emit('audio', data)
    }
    input.connect(capture)
    // The worklet writes no output samples. Connecting keeps its render clock active.
    capture.connect(audio.destination)
    media.getAudioTracks()[0].onended = () => { stopMic(); notice('Microphone disconnected.') }
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
el('joinMatch').onclick = () => enter(false)
el('mic').onclick = toggleMic
el('leave').onclick = () => leave('You left the lounge.')
el('resume').onclick = () => {
  const audio = context
  if (!audio) return
  if (startMatchMic && roomCode && !stream && !el('mic').disabled) {
    void toggleMic()
    return
  }
  void audio.resume().then(() => {
    if (context === audio && roomCode && !el('mic').disabled) {
      notice(stream ? 'Your microphone is live.' : 'Listening to match voice.')
    }
  }, () => notice('Sound is paused by your device.'))
}
el('invite').onclick = async () => {
  if (window.ReactNativeWebView) { window.ReactNativeWebView.postMessage(JSON.stringify({ shareCode: roomCode })); return }
  try {
    await navigator.clipboard.writeText(roomCode)
    notice('Room code copied.')
  } catch { notice('Share this room code with your friends: ' + roomCode) }
}
function pauseVoice() {
  startMatchMic = false
  if (!roomCode) return
  stopMic()
  notice('Microphone muted while you were away.')
}
document.addEventListener('visibilitychange', () => { if (document.hidden) pauseVoice() })
document.addEventListener('voice-background', pauseVoice)
window.addEventListener('pagehide', () => leave())
if (autoJoinMatch) enter(false)
