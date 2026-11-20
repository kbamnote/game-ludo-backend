import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { after, before, test } from 'node:test'

process.env.AUTH_DB_PATH = ':memory:'
process.env.AUTH_PUBLIC_URL = 'https://accounts.example.test'
process.env.GOOGLE_CLIENT_ID = 'test-client'
process.env.GOOGLE_CLIENT_SECRET = 'test-secret'
process.env.FACEBOOK_APP_ID = 'test-app'
process.env.FACEBOOK_APP_SECRET = 'test-secret'

const realFetch = globalThis.fetch
const { serveAccounts, authenticatedAccount } = await import('../dist/accounts.js')
const server = createServer(serveAccounts)
let base

before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + server.address().port
})
after(async () => {
  await new Promise(resolve => server.close(resolve))
})

async function call(path, { method = 'GET', data, token } = {}) {
  const raw = await realFetch(base + '/auth/' + path, {
    method, headers: { ...(data && { 'Content-Type': 'application/json' }), ...(token && { Authorization: 'Bearer ' + token }) },
    ...(data && { body: JSON.stringify(data) }),
  })
  const result = raw.headers.get('content-type')?.includes('application/json') ? await raw.json() : await raw.text()
  return { status: raw.status, result }
}

test('guest retries share one account and starter balance and restore the avatar', async () => {
  const data = { key: randomBytes(32).toString('hex') }
  const attempts = await Promise.all([1, 2, 3].map(() => call('guest', { method: 'POST', data })))
  assert.ok(attempts.every(reply => reply.status === 200))
  const { account, token } = attempts[0].result
  assert.deepEqual(attempts.map(item => item.result.account.id), Array(3).fill(account.id))
  assert.equal(account.coins, 1000)
  assert.equal(account.diamonds, 10)
  assert.equal(account.avatar, null)
  assert.equal(authenticatedAccount(token).id, account.id)
  assert.equal((await call('avatar', { method: 'PUT', data: { avatar: 2 } })).status, 401)
  assert.equal((await call('avatar', { method: 'PUT', token, data: { avatar: 9 } })).status, 400)
  assert.equal((await call('avatar', { method: 'PUT', token, data: { avatar: 2 } })).result.avatar, 2)
  assert.equal((await call('me', { token })).result.avatar, 2)
  assert.deepEqual((await call('guest', { method: 'POST', data })).result, { token, account: { ...account, avatar: 2 } })
})

test('social sign-in requires both the device key and the provider callback receipt', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input)
    if (url.pathname.endsWith('/token') || url.pathname.endsWith('/access_token')) {
      return Response.json({ access_token: 'test-provider-token' })
    }
    assert.ok(url.pathname.endsWith('/userinfo') || url.pathname.endsWith('/me'))
    return Response.json({ sub: 'google-person', id: 'facebook-person' })
  })

  async function authorize(provider) {
    const { result: { url, requestKey } } = await call('oauth/start', { method: 'POST', data: { provider } })
    const params = new URL(url).searchParams
    assert.equal(params.get('redirect_uri'), 'https://accounts.example.test/auth/callback/' + provider)
    if (provider === 'google') assert.equal(params.get('code_challenge_method'), 'S256')
    const state = params.get('state')
    assert.equal((await call('callback/' + provider + '?code=test&state=invalid')).status, 400)
    const verified = await call('callback/' + provider + '?code=test&state=' + state)
    assert.equal(verified.status, 200)
    const receipt = verified.result.match(/cgp:\/\/onboarding\?receipt=([a-f0-9]{64})/)[1]
    assert.equal((await call('oauth/result', { method: 'POST', data: { requestKey, receipt: 'a'.repeat(64) } })).status, 410)
    assert.equal((await call('oauth/result', { method: 'POST', data: { requestKey: 'b'.repeat(64), receipt } })).status, 410)
    assert.equal((await call('callback/' + provider + '?code=test&state=' + state)).status, 400)
    return (await call('oauth/result', { method: 'POST', data: { requestKey, receipt } })).result
  }

  for (const provider of ['google', 'facebook']) {
    const initial = await authorize(provider)
    await call('avatar', { method: 'PUT', token: initial.token, data: { avatar: 3 } })
    const repeat = await authorize(provider)
    assert.equal(repeat.account.id, initial.account.id)
    assert.equal(repeat.account.avatar, 3)
    assert.equal(repeat.account.coins, 1000)
    assert.equal(repeat.account.diamonds, 10)
  }
})
