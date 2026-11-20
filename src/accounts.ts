import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const WELCOME_COINS = 1000
const WELCOME_DIAMONDS = 10
const SESSION_MS = 90 * 24 * 60 * 60 * 1000
const LOGIN_MS = 5 * 60 * 1000
const keyPattern = /^[a-f0-9]{64}$/
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const randomKey = () => randomBytes(32).toString('hex')
const publicUrl = process.env.AUTH_PUBLIC_URL?.replace(/\/$/, '')
const webOrigin = process.env.AUTH_WEB_ORIGIN?.replace(/\/$/, '')
const facebookVersion = process.env.FACEBOOK_GRAPH_VERSION ?? 'v26.0'
type Provider = 'google' | 'facebook'
type Account = { id: string; name: string; coins: number; diamonds: number; avatar: number | null }

let database: DatabaseSync | undefined

function db() {
  if (database) return database
  const mount = process.env.RAILWAY_VOLUME_MOUNT_PATH
  const file = process.env.AUTH_DB_PATH || (mount && join(mount, 'accounts.sqlite'))
  if (!file && (process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production')) {
    throw new HttpError(503, 'Account storage is being set up')
  }
  const connection = new DatabaseSync(file || '.accounts.sqlite')
  try {
    connection.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        subject TEXT NOT NULL,
        name TEXT NOT NULL,
        coins INTEGER NOT NULL,
        diamonds INTEGER NOT NULL,
        avatar INTEGER CHECK (avatar BETWEEN 0 AND 4),
        UNIQUE (provider, subject)
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        expires INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth (
        state TEXT PRIMARY KEY,
        request_hash TEXT UNIQUE NOT NULL,
        provider TEXT NOT NULL,
        verifier TEXT NOT NULL,
        expires INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        return_web INTEGER NOT NULL DEFAULT 0,
        receipt_hash TEXT,
        account_id TEXT REFERENCES accounts(id)
      );
    `)
    database = connection
    return connection
  } catch (error) {
    connection.close()
    throw error
  }
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

function getAccount(id: string) {
  return db().prepare('SELECT id, name, coins, diamonds, avatar FROM accounts WHERE id = ?').get(id) as Account | undefined
}

function accountFor(provider: Provider | 'guest', subject: string) {
  const name = 'Player ' + randomBytes(2).toString('hex')
  db().prepare(`INSERT INTO accounts (id, provider, subject, name, coins, diamonds)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(provider, subject) DO NOTHING`).run(
    'acct_' + randomUUID(), provider, subject, name, WELCOME_COINS, WELCOME_DIAMONDS,
  )
  return db().prepare('SELECT id, name, coins, diamonds, avatar FROM accounts WHERE provider = ? AND subject = ?')
    .get(provider, subject) as Account
}

function sessionFor(account: Account, secret: string) {
  const token = digest('cgp-session:' + secret)
  db().prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now())
  db().prepare(`INSERT INTO sessions (token_hash, account_id, expires) VALUES (?, ?, ?)
    ON CONFLICT(token_hash) DO UPDATE SET expires = excluded.expires`).run(digest(token), account.id, Date.now() + SESSION_MS)
  return { token, account }
}

export function authenticatedAccount(token: unknown): Account | undefined {
  if (typeof token !== 'string' || !keyPattern.test(token)) return
  try {
    return db().prepare(`SELECT a.id, a.name, a.coins, a.diamonds, a.avatar FROM sessions s
      JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ? AND s.expires > ?`)
      .get(digest(token), Date.now()) as Account | undefined
  } catch {
    return undefined
  }
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
  const message = link ? 'Return to Cockroach Game Party to finish signing in.' : 'Sign-in could not be completed. Return to the game and try again.'
  res.writeHead(link ? 200 : 400, {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  })
  res.end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>CGP Sign-in</title><h1>' + message + '</h1>'
    + (link ? '<p><a href="' + link + '">Return to the game</a></p>' : '') + '</html>')
}

async function finishOAuth(res: ServerResponse, provider: Provider, params: URLSearchParams) {
  const config = providerConfig(provider)
  const state = params.get('state')
  if (!config || !state || !keyPattern.test(state)) return callbackPage(res)

  const attempt = db().prepare(`UPDATE oauth SET status = 'exchanging'
    WHERE state = ? AND provider = ? AND expires > ? AND status = 'pending' RETURNING verifier, return_web`)
    .get(state, provider, Date.now()) as { verifier: string; return_web: number } | undefined
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
    const account = accountFor(provider, digest(subject))
    const receipt = randomKey()
    db().prepare("UPDATE oauth SET status = 'done', account_id = ?, receipt_hash = ? WHERE state = ?")
      .run(account.id, digest(receipt), state)
    const returnUrl = attempt.return_web ? new URL('/onboarding', webOrigin).href : 'cgp://onboarding'
    return callbackPage(res, returnUrl + '?receipt=' + receipt)
  } catch {
    db().prepare("UPDATE oauth SET status = 'failed' WHERE state = ?").run(state)
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
      const account = accountFor('guest', digest(key))
      return json(res, 200, sessionFor(account, key))
    }
    if (req.method === 'GET' && pathname === '/auth/callback/google') return await finishOAuth(res, 'google', searchParams)
    if (req.method === 'GET' && pathname === '/auth/callback/facebook') return await finishOAuth(res, 'facebook', searchParams)
    if (req.method === 'POST' && pathname === '/auth/oauth/start') {
      const { provider, web } = await body(req)
      if (provider !== 'google' && provider !== 'facebook') throw new HttpError(400, 'Invalid sign-in provider')
      const config = providerConfig(provider)
      if (!config) throw new HttpError(503, 'This sign-in option is being set up. You can play as a guest.')
      if (web === true && !webOrigin?.startsWith('https://')) {
        throw new HttpError(503, 'Browser sign-in is unavailable. Open the game on your phone or play as a guest.')
      }
      const state = randomKey()
      const requestKey = randomKey()
      const verifier = randomKey()
      db().prepare('DELETE FROM oauth WHERE expires <= ?').run(Date.now())
      db().prepare('INSERT INTO oauth (state, request_hash, provider, verifier, expires, return_web) VALUES (?, ?, ?, ?, ?, ?)')
        .run(state, digest(requestKey), provider, verifier, Date.now() + LOGIN_MS, Number(web === true))
      const url = new URL(config.authorize)
      url.search = new URLSearchParams({
        client_id: config.id, redirect_uri: config.redirect, response_type: 'code',
        scope: provider === 'google' ? 'openid' : 'public_profile', state,
      }).toString()
      if (provider === 'google') {
        url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'))
        url.searchParams.set('code_challenge_method', 'S256')
      }
      return json(res, 200, { url: url.toString(), requestKey })
    }
    if (req.method === 'POST' && pathname === '/auth/oauth/result') {
      const { requestKey, receipt } = await body(req)
      if (typeof requestKey !== 'string' || !keyPattern.test(requestKey) || typeof receipt !== 'string' || !keyPattern.test(receipt)) {
        throw new HttpError(400, 'Invalid sign-in request')
      }
      const attempt = db().prepare("SELECT account_id FROM oauth WHERE request_hash = ? AND receipt_hash = ? AND status = 'done' AND expires > ?")
        .get(digest(requestKey), digest(receipt), Date.now()) as { account_id: string } | undefined
      const account = attempt && getAccount(attempt.account_id)
      if (!account) throw new HttpError(410, 'Sign-in ended. Please try again.')
      return json(res, 200, sessionFor(account, requestKey))
    }
    if (pathname === '/auth/me' || pathname === '/auth/avatar') {
      const account = authenticatedAccount(req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1])
      if (!account) throw new HttpError(401, 'Your session expired. Please sign in again.')
      if (req.method === 'GET' && pathname === '/auth/me') return json(res, 200, account)
      if (req.method === 'PUT' && pathname === '/auth/avatar') {
        const { avatar } = await body(req)
        if (typeof avatar !== 'number' || !Number.isInteger(avatar) || avatar < 0 || avatar > 4) {
          throw new HttpError(400, 'Choose one of the available avatars')
        }
        db().prepare('UPDATE accounts SET avatar = ? WHERE id = ?').run(avatar, account.id)
        return json(res, 200, getAccount(account.id))
      }
    }
    return json(res, 404, { error: 'Not found' })
  } catch (error) {
    if (error instanceof HttpError) return json(res, error.status, { error: error.message })
    console.error('[auth] Account request failed', error instanceof Error ? error.name : 'Unknown error')
    return json(res, 503, { error: 'Account service unavailable. Please try again.' })
  }
}
