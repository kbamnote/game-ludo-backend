import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const lounge = readFileSync(new URL('../voice/lounge.js', import.meta.url), 'utf8')

function joinMatch({ mic = true, members = [], storage = new Map() } = {}) {
  const elements = new Map()
  const handlers = new Map()
  let microphoneRequests = 0
  let audio
  let played = 0
  let disconnected = 0
  const playback = Promise.withResolvers()
  const socket = {
    connected: true,
    id: 'self',
    on(event, callback) { handlers.set(event, callback) },
    connect() { handlers.get('connect')() },
    timeout() { return this },
    emit(event, payload, reply) {
      if (event === 'enterMatch') reply(null, { code: 'match:test', matchId: 'test:1', members })
    },
  }
  const url = new URL('https://example.test/voice/#match=ticket&auto=1' + (mic ? '&mic=1' : ''))
  const page = { isSecureContext: true, addEventListener() {} }
  page.parent = page
  const element = () => ({
    value: '', attributes: {}, children: [],
    replaceChildren(...children) { this.children = children },
    append(...children) { this.children.push(...children) },
    setAttribute(name, value) { this.attributes[name] = value },
  })
  runInNewContext(lounge, {
    ArrayBuffer,
    URL,
    URLSearchParams,
    location: url,
    window: page,
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    document: {
      hidden: false,
      documentElement: { classList: { add() {} } },
      addEventListener() {},
      createElement: element,
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, element())
        return elements.get(id)
      },
    },
    navigator: {
      mediaDevices: { getUserMedia() { microphoneRequests++; return new Promise(() => {}) } },
    },
    AudioContext: class {
      state = 'suspended'
      currentTime = 0
      constructor() { audio = this }
      resume() { return playback.promise }
      createGain() { return { gain: {}, connect() {}, disconnect() { disconnected++ } } }
      createBuffer() { return { duration: 0.02, getChannelData: () => new Float32Array(480) } }
      createBufferSource() { return { connect() {}, start() { played++ } } }
    },
    io: () => socket,
  })
  return {
    get microphoneRequests() { return microphoneRequests },
    get played() { return played },
    get disconnected() { return disconnected },
    sendAudio: id => handlers.get('audio')(id, new ArrayBuffer(960)),
    updateRoster: peers => handlers.get('roster')(peers),
    buttons: () => elements.get('playerAudioList').children.map(row => row.children[1]),
    status: () => elements.get('status').textContent,
    async allowPlayback() {
      audio.state = 'running'
      audio.onstatechange()
      playback.resolve()
      await playback.promise
    },
  }
}

test('Friends microphone starts once when audio becomes ready after the room joins', async () => {
  const match = joinMatch()
  assert.equal(match.microphoneRequests, 0)
  assert.match(match.status(), /Resume sound/)
  await match.allowPlayback()
  assert.equal(match.microphoneRequests, 1)
  assert.equal(match.status(), 'Starting microphone…')
})

test('Friends listen-only connection never requests the microphone', async () => {
  const match = joinMatch({ mic: false })
  await match.allowPlayback()
  assert.equal(match.microphoneRequests, 0)
  assert.equal(match.status(), 'Listening to match voice.')
})

test('muting a Friends player stops queued audio and survives reconnect without silencing others', async () => {
  const members = [
    { id: 'self', seat: 0, name: 'Me' },
    { id: 'a', seat: 1, name: 'Player A' },
    { id: 'b', seat: 2, name: 'Player B' },
  ]
  const storage = new Map()
  const match = joinMatch({ mic: false, members, storage })
  await match.allowPlayback()
  assert.equal(match.buttons().length, 2)
  match.sendAudio('a')
  match.buttons()[0].onclick()
  assert.equal(match.disconnected, 1)
  match.sendAudio('a')
  match.sendAudio('b')
  assert.equal(match.played, 2)

  const peers = members.map(member => member.id === 'a' ? { ...member, id: 'new-a' } : member)
  match.updateRoster(peers)
  match.sendAudio('new-a')
  assert.equal(match.played, 2)
  const reopened = joinMatch({ mic: false, members: peers, storage })
  await reopened.allowPlayback()
  assert.equal(reopened.buttons()[0].textContent, 'Unmute')
  reopened.sendAudio('new-a')
  assert.equal(reopened.played, 0)
  reopened.buttons()[0].onclick()
  reopened.sendAudio('new-a')
  assert.equal(reopened.played, 1)
})
