import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { after, before, test } from 'node:test'

process.env.AUTH_DB_PATH = ':memory:'
process.env.MONGODB_URI = process.env.CGP_TEST_MONGODB_URI ?? ''
process.env.MONGODB_DATABASE = 'cgp_account_test'
process.env.AUTH_PUBLIC_URL = 'https://accounts.example.test'
process.env.AUTH_WEB_ORIGIN = 'https://game.example.test'
process.env.AUTH_EXPO_GO_RETURN_URL = 'exp://192.168.1.25:8081/--/onboarding'
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
  assert.equal((await authenticatedAccount(token)).id, account.id)
  assert.equal((await call('avatar', { method: 'PUT', data: { avatar: 2 } })).status, 401)
  assert.equal((await call('avatar', { method: 'PUT', token, data: { avatar: 9 } })).status, 400)
  assert.equal((await call('avatar', { method: 'PUT', token, data: { avatar: 2 } })).result.avatar, 2)
  assert.equal((await call('me', { token })).result.avatar, 2)
  assert.deepEqual((await call('guest', { method: 'POST', data })).result, { token, account: { ...account, avatar: 2 } })
})

test('social sign-in requires both the device key and the provider callback receipt', async (t) => {
  let googleSubject = 'google-person'
  let googleName
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input)
    if (url.pathname.endsWith('/token') || url.pathname.endsWith('/access_token')) {
      return Response.json({ access_token: 'test-provider-token' })
    }
    assert.ok(url.pathname.endsWith('/userinfo') || url.pathname.endsWith('/me'))
    return Response.json({ sub: googleSubject, id: 'facebook-person', name: googleName })
  })

  async function authorize(provider, settings = {}, returnUrl = 'cgp://onboarding', target = 'app') {
    const { result: { url, requestKey, returnTarget } } = await call('oauth/start', { method: 'POST', data: { provider, ...settings } })
    assert.equal(returnTarget, target)
    const params = new URL(url).searchParams
    assert.equal(params.get('redirect_uri'), 'https://accounts.example.test/auth/callback/' + provider)
    assert.equal(params.get('scope'), provider === 'google' ? 'openid profile' : 'public_profile')
    if (provider === 'google') assert.equal(params.get('code_challenge_method'), 'S256')
    const state = params.get('state')
    assert.equal((await call('callback/' + provider + '?code=test&state=invalid')).status, 400)
    const verified = await call('callback/' + provider + '?code=test&state=' + state)
    assert.equal(verified.status, 200)
    assert.match(verified.result, /location\.replace\(document\.getElementById\("return-link"\)\.href\)/)
    const link = new URL(verified.result.match(/id="return-link" href="([^"]+)"/)[1])
    const receipt = link.searchParams.get('receipt')
    assert.match(receipt, /^[a-f0-9]{64}$/)
    link.search = ''
    assert.equal(link.href, returnUrl)
    assert.equal((await call('oauth/result', { method: 'POST', data: { requestKey, receipt: 'a'.repeat(64) } })).status, 410)
    assert.equal((await call('oauth/result', { method: 'POST', data: { requestKey: 'b'.repeat(64), receipt } })).status, 410)
    assert.equal((await call('callback/' + provider + '?code=test&state=' + state)).status, 400)
    return (await call('oauth/result', { method: 'POST', data: { requestKey, receipt } })).result
  }

  const initialAccounts = new Map()
  for (const provider of ['google', 'facebook']) {
    const initial = await authorize(provider)
    initialAccounts.set(provider, initial.account)
    assert.match(initial.account.name, /^Player [a-f0-9]{4}$/)
    await call('avatar', { method: 'PUT', token: initial.token, data: { avatar: 3 } })
    const repeat = await authorize(provider)
    assert.equal(repeat.account.id, initial.account.id)
    assert.equal(repeat.account.avatar, 3)
    assert.equal(repeat.account.coins, 1000)
    assert.equal(repeat.account.diamonds, 10)
  }

  googleName = '  Asha Verma  '
  const expoGoReturnUrl = process.env.AUTH_EXPO_GO_RETURN_URL
  const preview = await authorize('google', { expoGoReturnUrl }, expoGoReturnUrl, 'expoGo')
  assert.equal(preview.account.id, initialAccounts.get('google').id)
  assert.equal(preview.account.name, 'Asha Verma')
  assert.equal(preview.account.avatar, 3)
  googleName = 'A Changed Name'
  const returned = await authorize('google', { web: true }, 'https://game.example.test/onboarding', 'web')
  assert.equal(returned.account.id, preview.account.id)
  assert.equal(returned.account.name, 'Asha Verma')
  assert.equal((await authorize('facebook')).account.name, initialAccounts.get('facebook').name)

  googleSubject = 'new-google-person'
  googleName = 'Ananya Venkataraman'
  const newGoogleAccount = await authorize('google')
  assert.equal(newGoogleAccount.account.provider, 'google')
  assert.equal(newGoogleAccount.account.name, 'Ananya Venkatara')

  for (const rejected of ['exp://different-host:8081/--/onboarding', expoGoReturnUrl + '?redirect=extra', 'https://other.example.test/onboarding']) {
    const result = await call('oauth/start', { method: 'POST', data: { provider: 'google', expoGoReturnUrl: rejected } })
    assert.equal(result.status, 409)
  }
})
