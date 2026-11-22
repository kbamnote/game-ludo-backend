import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { accountStore } from './accountStore.js'
import type { Activity } from './adminStore.js'
import { flushAdminTracking, trackedMatch } from './adminTracking.js'
import { allRooms } from './room.js'

const digest = (value: string) => createHash('sha256').update(value).digest()
const accessKey = process.env.ADMIN_ACCESS_KEY
const accessDigest = accessKey && /^[^\s]{32,256}$/.test(accessKey) ? digest(accessKey) : undefined
const allowedOrigin = process.env.ADMIN_PANEL_ORIGIN
const resourceId = /^[a-z\d_-]{1,90}$/i

function json(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

function pagination(params: URLSearchParams) {
  const bounded = (key: string, fallback: number, min: number, max: number) => {
    const raw = params.get(key)
    if (!raw || !/^\d+$/.test(raw)) return fallback
    return Math.min(max, Math.max(min, Number(raw)))
  }
  return { limit: bounded('limit', 20, 1, 100), offset: bounded('offset', 0, 0, 10_000_000) }
}

export async function serveAdmin(req: IncomingMessage, res: ServerResponse, connected: () => Set<string>) {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Vary', 'Origin')
  if (!accessDigest) return json(res, 503, { error: 'Admin access is not configured on this server.' })
  const origin = req.headers.origin
  if (origin && origin === allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Headers', 'Authorization')
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  }
  if (req.method === 'OPTIONS') { res.writeHead(origin && origin === allowedOrigin ? 204 : 403); return res.end() }
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' })
  const key = req.headers.authorization?.match(/^Bearer ([^\s]{32,256})$/i)?.[1]
  if (!key || !timingSafeEqual(digest(key), accessDigest)) return json(res, 401, { error: 'Enter a valid admin access key.' })

  try {
    const { pathname, searchParams } = new URL(req.url ?? '/', 'http://localhost')
    const path = pathname.replace(/^\/api\/admin\//, '')
    const page = pagination(searchParams)
    const search = searchParams.get('q')?.trim().slice(0, 80) ?? ''
    const view = searchParams.get('view')
    const accountId = searchParams.get('accountId') ?? undefined
    const matchId = searchParams.get('matchId') ?? undefined
    const playerPath = /^players\/([a-z\d_-]{1,90})$/i.exec(path)?.[1]
    const matchPath = /^matches\/([a-z\d_-]{1,90})$/i.exec(path)?.[1]
    if ([accountId, matchId].some(id => id !== undefined && !resourceId.test(id))) return json(res, 400, { error: 'Invalid filter.' })
    if (!['overview', 'players', 'matches', 'activity', 'leaderboard'].includes(path) && !playerPath && !matchPath) {
      return json(res, 404, { error: 'Admin resource not found.' })
    }
    await flushAdminTracking()
    const store = await accountStore()
    const withPlayerNames = async (rows: Activity[]) => {
      const missing = new Set(rows.flatMap(row => !row.name && row.accountId ? [row.accountId] : []))
      const names = new Map(await Promise.all([...missing].map(async id => [id, (await store.accountById(id))?.name] as const)))
      return rows.map(row => row.name || !row.accountId ? row : { ...row, name: names.get(row.accountId) })
    }
    const online = connected()
    const liveMatches = allRooms().filter(room => room.phase === 'playing')
    const liveIds = new Set(liveMatches.flatMap(room => {
      const tracked = trackedMatch(room)
      return tracked ? [tracked.id] : []
    }))
    const matchStatus = <T extends { status: string; id: string }>(match: T) => ({
      ...match, status: match.status === 'playing' && !liveIds.has(match.id) ? 'interrupted' : match.status,
    })
    if (path === 'overview') {
      const [stats, activity, matches] = await Promise.all([
        store.admin.summary(), store.admin.activity({ limit: 8, offset: 0 }, {}), store.admin.matches({ limit: 6, offset: 0 }),
      ])
      return json(res, 200, { ...stats, online: online.size, live: liveMatches.length,
        activity: await withPlayerNames(activity.rows), recent: matches.rows.map(matchStatus) })
    }
    if (path === 'players') {
      const result = await store.admin.players(page, search, {
        ids: view === 'online' ? [...online] : undefined,
        balance: view === 'coins' || view === 'diamonds' ? view : undefined,
      })
      return json(res, 200, { ...result, rows: result.rows.map(player => ({ ...player, online: online.has(player.id) })) })
    }
    if (path === 'matches') {
      const result = await store.admin.matches(page, accountId, search, {
        ids: view === 'live' ? [...liveIds] : undefined,
        completed: view === 'completed',
      })
      return json(res, 200, { ...result, rows: result.rows.map(matchStatus) })
    }
    if (path === 'activity') {
      const result = await store.admin.activity(page, { accountId, matchId })
      return json(res, 200, { ...result, rows: await withPlayerNames(result.rows) })
    }
    if (path === 'leaderboard') return json(res, 200, await store.admin.leaderboard(page))
    if (matchPath) {
      const match = await store.admin.match(matchPath)
      return match ? json(res, 200, matchStatus(match)) : json(res, 404, { error: 'Match not found.' })
    }
    if (playerPath) {
      const account = await store.accountById(playerPath)
      return account ? json(res, 200, {
        id: account.id, name: account.name, provider: account.provider, coins: account.coins,
        diamonds: account.diamonds, online: online.has(account.id),
      }) : json(res, 404, { error: 'Player account not found.' })
    }
  } catch (error) {
    console.warn('[admin] Request failed:', error instanceof Error ? error.name : 'Unknown error')
    return json(res, 503, { error: 'The admin data store is temporarily unavailable.' })
  }
}
