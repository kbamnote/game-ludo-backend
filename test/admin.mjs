import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { test } from 'node:test'

process.env.ADMIN_ACCESS_KEY = randomBytes(32).toString('hex')
process.env.ADMIN_PANEL_ORIGIN = 'https://admin.example.test'
process.env.AUTH_DB_PATH = ':memory:'
delete process.env.MONGODB_URI

const { serveAdmin } = await import('../dist/admin.js')
const { serveAccounts } = await import('../dist/accounts.js')
const { accountStore } = await import('../dist/accountStore.js')
const { createRoom, joinRoom, startMatch } = await import('../dist/room.js')
const { trackMatchStart, trackMatchActivity, trackMatchEnd } = await import('../dist/adminTracking.js')

test('admin access, balances, match placements and activity use persisted records', async t => {
  const active = new Set()
  const server = createServer((req, res) => {
    if (req.url.startsWith('/api/admin/')) void serveAdmin(req, res, () => active)
    else void serveAccounts(req, res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = 'http://127.0.0.1:' + server.address().port
  const admin = (path, key = process.env.ADMIN_ACCESS_KEY) => fetch(base + '/api/admin/' + path, {
    headers: { Authorization: 'Bearer ' + key, Origin: process.env.ADMIN_PANEL_ORIGIN },
  })
  const post = (path, data, token) => fetch(base + '/auth/' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token && { Authorization: 'Bearer ' + token }) },
    body: JSON.stringify(data),
  })
  const register = async () => (await post('guest', { key: randomBytes(32).toString('hex') })).json()
  const [host, guest] = await Promise.all([register(), register()])
  const hostId = host.account.id
  const guestId = guest.account.id
  assert.equal((await admin('overview', host.token)).status, 401)
  assert.equal((await fetch(base + '/api/admin/players')).status, 401)
  assert.equal((await admin('players', 'x'.repeat(64))).status, 401)
  active.add(hostId)

  const store = await accountStore()
  const room = createRoom(hostId, host.account.name, false, undefined, 100)
  assert.equal(joinRoom(room.code, guestId, guest.account.name, 'guest').ok, true)
  const match = startMatch(room)
  const id = 'admin-test-match'
  await store.fundMatchPot({ id, entry: 100, accounts: [hostId, guestId], expiresAt: Date.now() + 60_000 })
  trackMatchStart(room, id)
  trackMatchActivity(room, 0, 'match.roll', '6')
  let response = await admin('overview')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('access-control-allow-origin'), process.env.ADMIN_PANEL_ORIGIN)
  let overview = await response.json()
  assert.deepEqual([overview.players, overview.online, overview.live, overview.matches, overview.coins, overview.diamonds], [2, 1, 1, 1, 1800, 20])
  assert.equal(overview.recent[0].status, 'playing')

  match.ranking = [...match.seats]
  room.phase = 'finished'
  trackMatchEnd(room, 'completed')
  assert.equal(await store.settleMatchPot(id, [hostId]), true)
  const player = await (await admin('players/' + hostId)).json()
  assert.deepEqual([player.id, player.online, player.coins, player.diamonds], [hostId, true, 1100, 10])
  const { rows: listed } = await (await admin('players?q=' + hostId)).json()
  assert.equal(listed.length, 1)
  assert.equal(Object.hasOwn(listed[0], 'subject'), false)
  const history = await (await admin('matches?accountId=' + hostId)).json()
  assert.equal(history.total, 1)
  assert.equal(history.rows[0].players.find(player => player.id === hostId).place, 1)
  const ranking = await (await admin('leaderboard')).json()
  assert.deepEqual(ranking.rows.map(player => [player.id, player.rank, player.wins]), [[hostId, 1, 1]])
  const events = await (await admin('activity?matchId=' + id)).json()
  assert.ok(events.rows.some(row => row.kind === 'match.roll' && row.detail === '6'))
  assert.ok(events.rows.some(row => row.kind === 'coins.prize' && row.coins === 200 && row.name === host.account.name))

  const report = { mode: 'Computer', variant: 'classic', status: 'completed',
    startedAt: Date.now() - 1000, endedAt: Date.now(), seats: [0, 2], ranking: [0, 2] }
  assert.equal((await post('local-match', report)).status, 401)
  assert.equal((await post('local-match', { ...report, seats: [0, 0] }, host.token)).status, 400)
  for (let i = 0; i < 2; i++) assert.equal((await post('local-match', report, host.token)).status, 200)
  overview = await (await admin('overview')).json()
  assert.equal(overview.matches, 2)
  assert.equal(overview.completed, 2)
  assert.equal(overview.recent.find(row => row.mode === 'Computer').winners.length, 0)
  assert.equal((await (await admin('leaderboard')).json()).rows[0].wins, 1)
  const localEvents = await (await admin('activity?accountId=' + hostId)).json()
  assert.equal(localEvents.rows.filter(event => event.kind === 'local.reported').length, 1)
})
