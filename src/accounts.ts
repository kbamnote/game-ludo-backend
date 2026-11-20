import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { accountStore, AccountStorageUnavailable, type Account, type Provider } from './accountStore.js'

const WELCOME_COINS = 1000
const WELCOME_DIAMONDS = 10
const SESSION_MS = 90 * 24 * 60 * 60 * 1000
const LOGIN_MS = 5 * 60 * 1000
const keyPattern = /^[a-f0-9]{64}$/
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const randomKey = () => randomBytes(32).toString('hex')
const publicUrl = process.env.AUTH_PUBLIC_URL?.replace(/\/$/, '')
const webOrigin = process.env.AUTH_WEB_ORIGIN?.replace(/\/$/, '')
const configuredExpoGoReturnUrl = expoGoUrl(process.env.AUTH_EXPO_GO_RETURN_URL)
const facebookVersion = process.env.FACEBOOK_GRAPH_VERSION ?? 'v26.0'

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

async function accountFor(provider: Provider | 'guest', subject: string) {
  const store = await accountStore()
  return store.createAccount({
    id: 'acct_' + randomUUID(), provider, subject,
    name: 'Player ' + randomBytes(2).toString('hex'),
    coins: WELCOME_COINS, diamonds: WELCOME_DIAMONDS, avatar: null,
  })
}

async function sessionFor(account: Account, secret: string) {
  const token = digest('cgp-session:' + secret)
  const store = await accountStore()
  await store.saveSession(digest(token), account.id, Date.now() + SESSION_MS)
  return { token, account }
}

export async function authenticatedAccount(token: unknown): Promise<Account | undefined> {
  if (typeof token !== 'string' || !keyPattern.test(token)) return
  const store = await accountStore()
  return store.sessionAccount(digest(token))
}

function providerConfig(provider: Provider) {
  const google = provider === 'google'
  const id = google ? process.env.GOOGLE_CLIENT_ID : process.env.FACEBOOK_APP_ID
  const secret = google ? process.env.GOOGLE_CLIENT_SECRET : process.env.FACEBOOK_APP_SECRET
  if (!id || !secret || !publicUrl?.startsWith('https://') || (!google && !/^v\d+\.\d+$/.test(facebookVersion ?? ''))) return
  const graph = 'https://graph.facebook.com/' + facebookVersion
  return {
    id, secret, redirect: publicUrl + '/auth/callback/' + provider,
    authorize: google ? 'https://accounts.google.com/o/oauth2/v2/auth' : 'https://www.facebook.com/' + facebookVersion + '/dialog/oauth',
    token: google ? 'https://oauth2.googleapis.com/token' : graph + '/oauth/access_token',
    profile: google ? 'https://openidconnect.googleapis.com/v1/userinfo' : graph + '/me?fields=id',
  }
}

function expoGoUrl(value: unknown) {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value.trim())
    if ((url.protocol === 'exp:' || url.protocol === 'exps:') && url.hostname &&
        url.pathname === '/--/onboarding' && !url.username && !url.password && !url.search && !url.hash) {
      return url.href
    }
  } catch {
    // An invalid preview URL is treated as unconfigured.
  }
  return undefined
}

function json(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(payload))
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Expected JSON')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 4096) throw new HttpError(413, 'Request is too large')
    chunks.push(chunk)
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (data && typeof data === 'object' && !Array.isArray(data)) return data
  } catch {
    // Respond with a generic error without echoing the request.
  }
  throw new HttpError(400, 'Invalid request')
}

function callbackPage(res: ServerResponse, link?: string) {
  const message = link ? 'Opening Cockroach Game Party…' : 'Sign-in could not be completed. Return to the game and try again.'
  const nonce = randomBytes(16).toString('base64')
  res.writeHead(link ? 200 : 400, {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': `default-src 'none'; base-uri 'none'; frame-ancestors 'none'; script-src 'nonce-${nonce}'`,
  })
  res.end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>CGP Sign-in</title><h1>' + message + '</h1>'
    + (link ? '<p>If the game doesn’t open, tap <a id="return-link" href="' + link + '">Return to the game</a>.</p>'
      + '<script nonce="' + nonce + '">location.replace(document.getElementById("return-link").href)</script>' : '') + '</html>')
}

async function finishOAuth(res: ServerResponse, provider: Provider, params: URLSearchParams) {
  const config = providerConfig(provider)
  const state = params.get('state')
  if (!config || !state || !keyPattern.test(state)) return callbackPage(res)

  const store = await accountStore()
  const attempt = await store.claimOAuth(state, provider)
  if (!attempt) return callbackPage(res)

  try {
    const code = params.get('code')
    if (!code || params.has('error')) throw new Error()
    const data = new URLSearchParams({ client_id: config.id, client_secret: config.secret, redirect_uri: config.redirect, code })
    if (provider === 'google') {
      data.set('grant_type', 'authorization_code')
      data.set('code_verifier', attempt.verifier)
    }
    const tokenUrl = new URL(config.token)
    if (provider === 'facebook') tokenUrl.search = data.toString()
    const tokenRes = await fetch(tokenUrl, {
      ...(provider === 'google' ? { method: 'POST', body: data } : {}),
      signal: AbortSignal.timeout(12000),
    })
    if (!tokenRes.ok) throw new Error()
    const token = (await tokenRes.json() as { access_token?: string }).access_token
    if (!token) throw new Error()
    const profileUrl = new URL(config.profile)
    if (provider === 'facebook') {
      profileUrl.searchParams.set('appsecret_proof', createHmac('sha256', config.secret).update(token).digest('hex'))
    }
    const profileRes = await fetch(profileUrl, {
      headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(12000),
    })
    if (!profileRes.ok) throw new Error()
    const profile = await profileRes.json() as { sub?: string; id?: string }
    const subject = provider === 'google' ? profile.sub : profile.id
    if (typeof subject !== 'string' || !subject || subject.length > 256) throw new Error()
    const account = await accountFor(provider, digest(subject))
    const receipt = randomKey()
    await store.finishOAuth(state, { accountId: account.id, receiptHash: digest(receipt) })
    const returnUrl = attempt.returnTarget === 'expoGo' ? configuredExpoGoReturnUrl
      : attempt.returnTarget === 'web' ? new URL('/onboarding', webOrigin).href : 'cgp://onboarding'
    if (!returnUrl) return callbackPage(res)
    const link = new URL(returnUrl)
    link.searchParams.set('receipt', receipt)
    return callbackPage(res, link.href.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;'))
  } catch {
    await store.finishOAuth(state)
    return callbackPage(res)
  }
}

export async function serveAccounts(req: IncomingMessage, res: ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  try {
    const { pathname, searchParams } = new URL(req.url ?? '/', 'http://localhost')
    if (req.method === 'GET' && pathname === '/auth/providers') {
      return json(res, 200, { google: !!providerConfig('google'), facebook: !!providerConfig('facebook') })
    }
    if (req.method === 'POST' && pathname === '/auth/guest') {
      const { key } = await body(req)
      if (typeof key !== 'string' || !keyPattern.test(key)) throw new HttpError(400, 'Invalid guest key')
      const account = await accountFor('guest', digest(key))
      return json(res, 200, await sessionFor(account, key))
    }
    if (req.method === 'GET' && pathname === '/auth/callback/google') return await finishOAuth(res, 'google', searchParams)
    if (req.method === 'GET' && pathname === '/auth/callback/facebook') return await finishOAuth(res, 'facebook', searchParams)
    if (req.method === 'POST' && pathname === '/auth/oauth/start') {
      const { provider, web, expoGoReturnUrl } = await body(req)
      if (provider !== 'google' && provider !== 'facebook') throw new HttpError(400, 'Invalid sign-in provider')
      const config = providerConfig(provider)
      if (!config) throw new HttpError(503, 'This sign-in option is being set up. You can play as a guest.')
      if (web === true && !webOrigin?.startsWith('https://')) {
        throw new HttpError(503, 'Browser sign-in is unavailable. Open the game on your phone or play as a guest.')
      }
      if (expoGoReturnUrl !== undefined && (!configuredExpoGoReturnUrl ||
          web === true || expoGoUrl(expoGoReturnUrl) !== configuredExpoGoReturnUrl)) {
        throw new HttpError(409, 'Set AUTH_EXPO_GO_RETURN_URL on the backend to match this Expo Go session.')
      }
      const state = randomKey()
      const requestKey = randomKey()
      const verifier = randomKey()
      const returnTarget = expoGoReturnUrl !== undefined ? 'expoGo' : web === true ? 'web' : 'app'
      const store = await accountStore()
      await store.startOAuth({
        state, requestHash: digest(requestKey), provider, verifier, expires: Date.now() + LOGIN_MS,
        returnTarget,
      })
      const url = new URL(config.authorize)
      url.search = new URLSearchParams({
        client_id: config.id, redirect_uri: config.redirect, response_type: 'code',
        scope: provider === 'google' ? 'openid' : 'public_profile', state,
      }).toString()
      if (provider === 'google') {
        url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'))
        url.searchParams.set('code_challenge_method', 'S256')
      }
      return json(res, 200, { url: url.toString(), requestKey, returnTarget })
    }
    if (req.method === 'POST' && pathname === '/auth/oauth/result') {
      const { requestKey, receipt } = await body(req)
      if (typeof requestKey !== 'string' || !keyPattern.test(requestKey) || typeof receipt !== 'string' || !keyPattern.test(receipt)) {
        throw new HttpError(400, 'Invalid sign-in request')
      }
      const store = await accountStore()
      const account = await store.oauthAccount(digest(requestKey), digest(receipt))
      if (!account) throw new HttpError(410, 'Sign-in ended. Please try again.')
      return json(res, 200, await sessionFor(account, requestKey))
    }
    if (pathname === '/auth/me' || pathname === '/auth/avatar') {
      const account = await authenticatedAccount(req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1])
      if (!account) throw new HttpError(401, 'Your session expired. Please sign in again.')
      if (req.method === 'GET' && pathname === '/auth/me') return json(res, 200, account)
      if (req.method === 'PUT' && pathname === '/auth/avatar') {
        const { avatar } = await body(req)
        if (typeof avatar !== 'number' || !Number.isInteger(avatar) || avatar < 0 || avatar > 4) {
          throw new HttpError(400, 'Choose one of the available avatars')
        }
        const store = await accountStore()
        return json(res, 200, await store.saveAvatar(account.id, avatar))
      }
    }
    return json(res, 404, { error: 'Not found' })
  } catch (error) {
    if (error instanceof HttpError) return json(res, error.status, { error: error.message })
    if (error instanceof AccountStorageUnavailable) return json(res, 503, { error: error.message })
    console.error('[auth] Account request failed', error instanceof Error ? error.name : 'Unknown error')
    return json(res, 503, { error: 'Account service unavailable. Please try again.' })
  }
}
