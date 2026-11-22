import type { DatabaseSync } from 'node:sqlite'
import type { ClientSession, Db, Filter } from 'mongodb'
import type { Account } from './accountStore.js'
import type { GameVariant } from './room.js'
import type { Seat } from './rules.js'

export type AdminAccount = Omit<Account, 'avatar'>
export type AdminMatch = {
  id: string; room: string; variant: GameVariant; mode: 'Friends' | 'Online' | 'Computer' | 'Pass & Play' | 'Tournament'
  status: 'playing' | 'completed' | 'abandoned'
  startedAt: number; endedAt?: number; entry: number; prize: number
  players: { id: string; name: string; seat: Seat; place?: number }[]
  winners: string[]
}
export type Activity = {
  id: string; at: number; kind: string; accountId?: string; name?: string; matchId?: string
  coins?: number; diamonds?: number; detail?: string
}
export type Page = { limit: number; offset: number }
export type ActivityFilter = { accountId?: string; matchId?: string }
type Summary = { players: number; matches: number; completed: number; coins: number; diamonds: number }
export type RankedAccount = AdminAccount & { wins: number; rank: number }

export interface AdminStore {
  summary(): Summary | Promise<Summary>
  players(page: Page, search: string): PageResult<AdminAccount> | Promise<PageResult<AdminAccount>>
  matches(page: Page, accountId?: string, search?: string): PageResult<AdminMatch> | Promise<PageResult<AdminMatch>>
  match(id: string): AdminMatch | null | Promise<AdminMatch | null>
  activity(page: Page, filter: ActivityFilter): PageResult<Activity> | Promise<PageResult<Activity>>
  leaderboard(page: Page): PageResult<RankedAccount> | Promise<PageResult<RankedAccount>>
  saveMatch(match: AdminMatch): void | Promise<void>
  saveActivity(events: Activity[], session?: ClientSession): void | Promise<void>
}
export type PageResult<T> = { rows: T[]; total: number }

function sqliteAdmin(db: DatabaseSync): AdminStore {
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_matches (
      id TEXT PRIMARY KEY, room TEXT NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL, data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS admin_matches_started ON admin_matches(started_at DESC, id);
    CREATE TABLE IF NOT EXISTS admin_match_players (
      match_id TEXT NOT NULL REFERENCES admin_matches(id), account_id TEXT NOT NULL, won INTEGER NOT NULL,
      PRIMARY KEY (match_id, account_id)
    );
    CREATE INDEX IF NOT EXISTS admin_match_player ON admin_match_players(account_id, match_id);
    CREATE TABLE IF NOT EXISTS admin_activity (
      id TEXT PRIMARY KEY, at INTEGER NOT NULL, account_id TEXT, match_id TEXT, data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS admin_activity_at ON admin_activity(at DESC, id);
    CREATE INDEX IF NOT EXISTS admin_activity_player ON admin_activity(account_id, at DESC, id);
    CREATE INDEX IF NOT EXISTS admin_activity_match ON admin_activity(match_id, at DESC, id);
  `)
  const jsonRows = <T>(rows: { data?: unknown }[]) => rows.map(row => JSON.parse(String(row.data)) as T)
  return {
    summary() {
      return db.prepare(`SELECT COUNT(*) players, COALESCE(SUM(coins),0) coins, COALESCE(SUM(diamonds),0) diamonds,
        (SELECT COUNT(*) FROM admin_matches) matches,
        (SELECT COUNT(*) FROM admin_matches WHERE status='completed') completed FROM accounts`).get() as Summary
    },
    players({ limit, offset }, search) {
      const args = [search.toLowerCase(), search.toLowerCase()]
      const where = 'WHERE instr(lower(name), ?) > 0 OR instr(lower(id), ?) > 0'
      if (!search) return {
        total: Number(db.prepare('SELECT COUNT(*) count FROM accounts').get()?.count),
        rows: db.prepare('SELECT id, name, provider, coins, diamonds FROM accounts ORDER BY name COLLATE NOCASE, id LIMIT ? OFFSET ?').all(limit, offset) as AdminAccount[],
      }
      return {
        total: Number(db.prepare('SELECT COUNT(*) count FROM accounts ' + where).get(...args)?.count),
        rows: db.prepare('SELECT id, name, provider, coins, diamonds FROM accounts ' + where + ' ORDER BY name COLLATE NOCASE, id LIMIT ? OFFSET ?')
          .all(...args, limit, offset) as AdminAccount[],
      }
    },
    matches({ limit, offset }, accountId, search) {
      const conditions = []
      const args: string[] = []
      if (accountId) {
        conditions.push('id IN (SELECT match_id FROM admin_match_players WHERE account_id = ?)')
        args.push(accountId)
      }
      if (search) { conditions.push('(instr(room, ?) > 0 OR instr(id, ?) > 0)'); args.push(search, search) }
      const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : ''
      return {
        total: Number(db.prepare('SELECT COUNT(*) count FROM admin_matches' + where).get(...args)?.count),
        rows: jsonRows(db.prepare('SELECT data FROM admin_matches' + where + ' ORDER BY started_at DESC, id LIMIT ? OFFSET ?').all(...args, limit, offset)),
      }
    },
    match(id) {
      const row = db.prepare('SELECT data FROM admin_matches WHERE id=?').get(id)
      return row ? jsonRows<AdminMatch>([row])[0] : null
    },
    activity({ limit, offset }, { accountId, matchId }) {
      const args: string[] = []
      const conditions: string[] = []
      if (accountId) { conditions.push('account_id = ?'); args.push(accountId) }
      if (matchId) { conditions.push('match_id = ?'); args.push(matchId) }
      const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : ''
      return {
        total: Number(db.prepare('SELECT COUNT(*) count FROM admin_activity' + where).get(...args)?.count),
        rows: jsonRows(db.prepare('SELECT data FROM admin_activity' + where + ' ORDER BY at DESC, rowid DESC LIMIT ? OFFSET ?').all(...args, limit, offset)),
      }
    },
    leaderboard({ limit, offset }) {
      const rows = db.prepare(`SELECT a.id, a.name, a.provider, a.coins, a.diamonds, COUNT(*) wins
        FROM admin_match_players p JOIN accounts a ON a.id=p.account_id
        WHERE p.won=1 GROUP BY a.id ORDER BY wins DESC, a.name COLLATE NOCASE, a.id LIMIT ? OFFSET ?`).all(limit, offset) as RankedAccount[]
      return {
        total: Number(db.prepare(`SELECT COUNT(DISTINCT p.account_id) count FROM admin_match_players p
          JOIN accounts a ON a.id=p.account_id WHERE p.won=1`).get()?.count),
        rows: rows.map((row, index) => ({ ...row, rank: offset + index + 1 })),
      }
    },
    saveMatch(match) {
      db.exec('BEGIN')
      try {
        db.prepare(`INSERT INTO admin_matches VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET status=excluded.status, data=excluded.data`)
          .run(match.id, match.room, match.status, match.startedAt, JSON.stringify(match))
        const save = db.prepare(`INSERT INTO admin_match_players VALUES (?, ?, ?)
          ON CONFLICT(match_id, account_id) DO UPDATE SET won=excluded.won`)
        for (const player of match.players) save.run(match.id, player.id, Number(match.winners.includes(player.id)))
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    saveActivity(events) {
      if (!events.length) return
      const values = events.map(() => '(?, ?, ?, ?, ?)').join(', ')
      db.prepare('INSERT INTO admin_activity VALUES ' + values + ' ON CONFLICT(id) DO NOTHING')
        .run(...events.flatMap(event => [event.id, event.at, event.accountId ?? null, event.matchId ?? null, JSON.stringify(event)]))
    },
  }
}

type DocumentId<T> = Omit<T, 'id'> & { _id: string }
function withId<T extends { _id: string }>({ _id, ...row }: T) { return { ...row, id: _id } }
const accountFields = { _id: 1, name: 1, provider: 1, coins: 1, diamonds: 1 }
const searchRegex = (value: string) => new RegExp(
  [...value].map(char => '^$\\.*+?()[]{}|'.includes(char) ? '\\' + char : char).join(''), 'i',
)

async function mongoAdmin(db: Db): Promise<AdminStore> {
  const accounts = db.collection<DocumentId<AdminAccount>>('accounts')
  const matches = db.collection<DocumentId<AdminMatch>>('admin_matches')
  const activity = db.collection<DocumentId<Activity>>('admin_activity')
  await Promise.all([
    matches.createIndexes([{ key: { startedAt: -1, _id: 1 } }, { key: { 'players.id': 1, startedAt: -1 } }, { key: { status: 1 } }]),
    activity.createIndexes([{ key: { at: -1, _id: -1 } }, { key: { accountId: 1, at: -1 } }, { key: { matchId: 1, at: -1 } }]),
  ])
  return {
    async summary() {
      const [wallet, total, completed] = await Promise.all([
        accounts.aggregate<{ players: number; coins: number; diamonds: number }>([
          { $group: { _id: null, players: { $sum: 1 }, coins: { $sum: '$coins' }, diamonds: { $sum: '$diamonds' } } },
        ]).next(),
        matches.countDocuments(), matches.countDocuments({ status: 'completed' }),
      ])
      return { players: wallet?.players ?? 0, coins: wallet?.coins ?? 0, diamonds: wallet?.diamonds ?? 0, matches: total, completed }
    },
    async players({ limit, offset }, search) {
      const query = search ? { $or: [{ name: searchRegex(search) }, { _id: searchRegex(search) }] } : {}
      const [rows, total] = await Promise.all([
        accounts.find(query, { projection: accountFields }).collation({ locale: 'en', strength: 2 })
          .sort({ name: 1, _id: 1 }).skip(offset).limit(limit).toArray(),
        accounts.countDocuments(query),
      ])
      return { rows: rows.map(withId), total }
    },
    async matches({ limit, offset }, accountId, search) {
      const query: Filter<DocumentId<AdminMatch>> = {
        ...(accountId && { 'players.id': accountId }),
        ...(search && { $or: [{ room: searchRegex(search) }, { _id: searchRegex(search) }] }),
      }
      const [rows, total] = await Promise.all([
        matches.find(query).sort({ startedAt: -1, _id: 1 }).skip(offset).limit(limit).toArray(), matches.countDocuments(query),
      ])
      return { rows: rows.map(withId), total }
    },
    async match(id) {
      const row = await matches.findOne({ _id: id })
      return row ? withId(row) : null
    },
    async activity({ limit, offset }, query) {
      const [rows, total] = await Promise.all([
        activity.find(query).sort({ at: -1, _id: -1 }).skip(offset).limit(limit).toArray(), activity.countDocuments(query),
      ])
      return { rows: rows.map(withId), total }
    },
    async leaderboard({ limit, offset }) {
      const result = await matches.aggregate<{ rows: (AdminAccount & { wins: number })[]; total: { count: number }[] }>([
        { $match: { status: 'completed' } }, { $unwind: '$winners' },
        { $group: { _id: '$winners', wins: { $sum: 1 } } },
        { $lookup: { from: 'accounts', localField: '_id', foreignField: '_id', as: 'account' } }, { $unwind: '$account' },
        { $facet: { rows: [{ $sort: { wins: -1, 'account.name': 1, _id: 1 } }, { $skip: offset }, { $limit: limit },
          { $project: { _id: 0, id: '$_id', wins: 1, name: '$account.name', provider: '$account.provider',
            coins: '$account.coins', diamonds: '$account.diamonds' } }], total: [{ $count: 'count' }] } },
      ], { collation: { locale: 'en', strength: 2 } }).next()
      return { rows: (result?.rows ?? []).map((row, index) => ({ ...row, rank: offset + index + 1 })), total: result?.total[0]?.count ?? 0 }
    },
    async saveMatch({ id, ...record }) {
      await matches.updateOne({ _id: id }, { $set: record }, { upsert: true })
    },
    async saveActivity(events, session) {
      if (!events.length) return
      await activity.bulkWrite(events.map(({ id, ...event }) => ({
        updateOne: { filter: { _id: id }, update: { $setOnInsert: event }, upsert: true },
      })), { ordered: false, session })
    },
  }
}

export { sqliteAdmin, mongoAdmin }
