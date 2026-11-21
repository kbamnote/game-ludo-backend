import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MongoClient, MongoServerError } from 'mongodb'
import type { MatchPot } from './matchEntry.js'

export type Provider = 'google' | 'facebook'
export type Account = { id: string; provider: Provider | 'guest'; name: string; coins: number; diamonds: number; avatar: number | null }
type OAuthReturnTarget = 'app' | 'web' | 'expoGo'
const returnTargets = ['app', 'web', 'expoGo'] as const
type OAuthClaim = { verifier: string; returnTarget: OAuthReturnTarget }
type AccountRecord = Account & { subject: string }
type OAuthStart = {
  state: string
  requestHash: string
  provider: Provider
  verifier: string
  expires: number
  returnTarget: OAuthReturnTarget
}

interface AccountStore {
  accountById(id: string): Account | undefined | Promise<Account | undefined>
  fundMatchPot(pot: MatchPot): void | Promise<void>
  settleMatchPot(id: string, winners: string[], expiredBefore?: number): boolean | Promise<boolean>
  renewMatchPots(ids: string[], expiresAt: number): void | Promise<void>
  expiredMatchPots(now: number): Pick<MatchPot, 'id' | 'accounts'>[] | Promise<Pick<MatchPot, 'id' | 'accounts'>[]>
  createAccount(input: AccountRecord): Account | Promise<Account>
  replaceAccountName(id: string, previous: string, name: string): Account | undefined | Promise<Account | undefined>
  saveAvatar(id: string, avatar: number): Account | undefined | Promise<Account | undefined>
  saveSession(hash: string, accountId: string, expires: number): void | Promise<void>
  sessionAccount(hash: string): Account | undefined | Promise<Account | undefined>
  startOAuth(attempt: OAuthStart): void | Promise<void>
  claimOAuth(state: string, provider: Provider): OAuthClaim | undefined | Promise<OAuthClaim | undefined>
  finishOAuth(state: string, result?: { accountId: string; receiptHash: string }): void | Promise<void>
  oauthAccount(requestHash: string, receiptHash: string): Account | undefined | Promise<Account | undefined>
}

export class AccountStorageUnavailable extends Error {}
export class InsufficientMatchCoins extends Error {
  constructor(readonly accountId: string) { super('A player does not have enough online coins.') }
}

function potCredits(pot: Pick<MatchPot, 'accounts' | 'entry'>, winners: string[]) {
  if (!winners.length) return pot.accounts.map(id => ({ id, amount: pot.entry }))
  const recipients = [...new Set(winners)]
  if (recipients.some(id => !pot.accounts.includes(id))) throw Error('Winner was not in the match pot')
  const total = pot.entry * pot.accounts.length
  return recipients.map((id, index) => ({ id,
    amount: Math.floor(total / recipients.length) + Number(index < total % recipients.length),
  }))
}

function sqliteStore(file: string): AccountStore {
  const db = new DatabaseSync(file)
  try {
    db.exec(`
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
      CREATE TABLE IF NOT EXISTS match_pots (
        id TEXT PRIMARY KEY,
        entry INTEGER NOT NULL,
        accounts TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS match_pots_expiry ON match_pots(expires_at);
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
  } catch (error) {
    db.close()
    throw error
  }
  const fields = 'id, provider, name, coins, diamonds, avatar'
  const getAccount = (id: string) => db.prepare('SELECT ' + fields + ' FROM accounts WHERE id = ?').get(id) as Account | undefined
  function transaction<T>(operation: () => T): T {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  return {
    accountById: getAccount,
    fundMatchPot(pot) {
      transaction(() => {
        db.prepare('INSERT INTO match_pots VALUES (?, ?, ?, ?)').run(pot.id, pot.entry, JSON.stringify(pot.accounts), pot.expiresAt)
        const debit = db.prepare('UPDATE accounts SET coins = coins - ? WHERE id = ? AND coins >= ?')
        for (const id of pot.accounts) {
          if (debit.run(pot.entry, id, pot.entry).changes !== 1) throw new InsufficientMatchCoins(id)
        }
      })
    },
    settleMatchPot(id, winners, expiredBefore) {
      return transaction(() => {
        const row = db.prepare('SELECT entry, accounts, expires_at FROM match_pots WHERE id = ?').get(id) as
          { entry: number; accounts: string; expires_at: number } | undefined
        if (!row || (expiredBefore !== undefined && row.expires_at > expiredBefore)) return false
        const credit = db.prepare('UPDATE accounts SET coins = coins + ? WHERE id = ?')
        for (const { id, amount } of potCredits({ entry: row.entry, accounts: JSON.parse(row.accounts) as string[] }, winners)) {
          if (credit.run(amount, id).changes !== 1) throw Error('Could not credit match coins')
        }
        db.prepare('DELETE FROM match_pots WHERE id = ?').run(id)
        return true
      })
    },
    renewMatchPots(ids, expiresAt) {
      const renew = db.prepare('UPDATE match_pots SET expires_at = ? WHERE id = ?')
      for (const id of ids) renew.run(expiresAt, id)
    },
    expiredMatchPots(now) {
      return db.prepare('SELECT id, accounts FROM match_pots WHERE expires_at <= ?').all(now)
        .map(row => ({ id: String(row.id), accounts: JSON.parse(String(row.accounts)) as string[] }))
    },
    createAccount({ id, provider, subject, name, coins, diamonds }) {
      db.prepare(`INSERT INTO accounts (id, provider, subject, name, coins, diamonds)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(provider, subject) DO NOTHING`).run(id, provider, subject, name, coins, diamonds)
      return db.prepare('SELECT ' + fields + ' FROM accounts WHERE provider = ? AND subject = ?').get(provider, subject) as Account
    },
    replaceAccountName(id, previous, name) {
      db.prepare('UPDATE accounts SET name = ? WHERE id = ? AND name = ?').run(name, id, previous)
      return getAccount(id)
    },
    saveAvatar(id, avatar) {
      db.prepare('UPDATE accounts SET avatar = ? WHERE id = ?').run(avatar, id)
      return getAccount(id)
    },
    saveSession(hash, accountId, expires) {
      db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now())
      db.prepare(`INSERT INTO sessions (token_hash, account_id, expires) VALUES (?, ?, ?)
        ON CONFLICT(token_hash) DO UPDATE SET expires = excluded.expires`).run(hash, accountId, expires)
    },
    sessionAccount(hash) {
      const session = db.prepare('SELECT account_id FROM sessions WHERE token_hash = ? AND expires > ?')
        .get(hash, Date.now()) as { account_id: string } | undefined
      return session && getAccount(session.account_id)
    },
    startOAuth({ state, requestHash, provider, verifier, expires, returnTarget }) {
      db.prepare('DELETE FROM oauth WHERE expires <= ?').run(Date.now())
      db.prepare('INSERT INTO oauth (state, request_hash, provider, verifier, expires, return_web) VALUES (?, ?, ?, ?, ?, ?)')
        .run(state, requestHash, provider, verifier, expires, returnTargets.indexOf(returnTarget))
    },
    claimOAuth(state, provider) {
      const attempt = db.prepare(`UPDATE oauth SET status = 'exchanging'
        WHERE state = ? AND provider = ? AND expires > ? AND status = 'pending' RETURNING verifier, return_web`)
        .get(state, provider, Date.now()) as { verifier: string; return_web: number } | undefined
      // Keep the existing 0/1 encoding for app and web attempts.
      return attempt && { verifier: attempt.verifier, returnTarget: returnTargets[attempt.return_web] ?? 'app' }
    },
    finishOAuth(state, result) {
      db.prepare('UPDATE oauth SET status = ?, account_id = ?, receipt_hash = ? WHERE state = ?')
        .run(result ? 'done' : 'failed', result?.accountId ?? null, result?.receiptHash ?? null, state)
    },
    oauthAccount(requestHash, receiptHash) {
      const attempt = db.prepare("SELECT account_id FROM oauth WHERE request_hash = ? AND receipt_hash = ? AND status = 'done' AND expires > ?")
        .get(requestHash, receiptHash, Date.now()) as { account_id: string } | undefined
      return attempt && getAccount(attempt.account_id)
    },
  }
}

type MongoAccount = Omit<AccountRecord, 'id'> & { _id: string }
type MongoSession = { _id: string; accountId: string; expires: Date }
type MongoAttempt = Omit<OAuthStart, 'expires' | 'state'> & {
  _id: string
  expires: Date
  status: 'pending' | 'exchanging' | 'done' | 'failed'
  accountId?: string
  receiptHash?: string
  returnWeb?: boolean
}

function publicAccount(row: MongoAccount): Account {
  return { id: row._id, provider: row.provider, name: row.name, coins: row.coins, diamonds: row.diamonds, avatar: row.avatar }
}

async function mongoStore(uri: string): Promise<AccountStore> {
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 4500,
    connectTimeoutMS: 4500,
    socketTimeoutMS: 7000,
    waitQueueTimeoutMS: 4500,
  })
  const database = client.db(process.env.MONGODB_DATABASE || 'cgp')
  const accounts = database.collection<MongoAccount>('accounts')
  const sessions = database.collection<MongoSession>('sessions')
  const oauth = database.collection<MongoAttempt>('oauth')
  const pots = database.collection<Omit<MatchPot, 'id'> & { _id: string }>('match_pots')
  try {
    await client.connect()
    await Promise.all([
      accounts.createIndex({ provider: 1, subject: 1 }, { unique: true }),
      sessions.createIndex({ expires: 1 }, { expireAfterSeconds: 0 }),
      pots.createIndex({ expiresAt: 1 }),
      oauth.createIndexes([
        { key: { requestHash: 1 }, unique: true },
        { key: { expires: 1 }, expireAfterSeconds: 0 },
      ]),
    ])
  } catch (error) {
    await client.close()
    throw error
  }

  const getAccount = async (id: string) => {
    const row = await accounts.findOne({ _id: id })
    return row ? publicAccount(row) : undefined
  }
  return {
    accountById: getAccount,
    async fundMatchPot({ id, ...pot }) {
      await client.withSession(session => session.withTransaction(async () => {
        await pots.insertOne({ _id: id, ...pot }, { session })
        for (const id of pot.accounts) {
          const debit = await accounts.updateOne({ _id: id, coins: { $gte: pot.entry } }, { $inc: { coins: -pot.entry } }, { session })
          if (!debit.matchedCount) throw new InsufficientMatchCoins(id)
        }
      }))
    },
    settleMatchPot(id, winners, expiredBefore) {
      return client.withSession(session => session.withTransaction(async () => {
        const pot = await pots.findOneAndDelete({ _id: id,
          ...(expiredBefore === undefined ? {} : { expiresAt: { $lte: expiredBefore } }),
        }, { session })
        if (!pot) return false
        for (const { id, amount } of potCredits(pot, winners)) {
          const credit = await accounts.updateOne({ _id: id }, { $inc: { coins: amount } }, { session })
          if (!credit.matchedCount) throw Error('Could not credit match coins')
        }
        return true
      }))
    },
    async renewMatchPots(ids, expiresAt) {
      if (ids.length) await pots.updateMany({ _id: { $in: ids } }, { $set: { expiresAt } })
    },
    async expiredMatchPots(now) {
      const rows = await pots.find({ expiresAt: { $lte: now } }, { projection: { _id: 1, accounts: 1 } }).toArray()
      return rows.map(row => ({ id: row._id, accounts: row.accounts }))
    },
    async createAccount({ id, provider, subject, ...account }) {
      const identity = { provider, subject }
      try {
        const row = await accounts.findOneAndUpdate(identity, { $setOnInsert: { _id: id, ...account } },
          { upsert: true, returnDocument: 'after' })
        if (row) return publicAccount(row)
      } catch (error) {
        if (!(error instanceof MongoServerError) || error.code !== 11000) throw error
        const row = await accounts.findOne(identity)
        if (row) return publicAccount(row)
        throw error
      }
      throw new Error('Account could not be created')
    },
    async replaceAccountName(id, previous, name) {
      const row = await accounts.findOneAndUpdate({ _id: id, name: previous }, { $set: { name } }, { returnDocument: 'after' })
      return row ? publicAccount(row) : getAccount(id)
    },
    async saveAvatar(id, avatar) {
      const row = await accounts.findOneAndUpdate({ _id: id }, { $set: { avatar } }, { returnDocument: 'after' })
      return row ? publicAccount(row) : undefined
    },
    async saveSession(hash, accountId, expires) {
      await sessions.updateOne({ _id: hash }, { $setOnInsert: { accountId }, $set: { expires: new Date(expires) } }, { upsert: true })
    },
    async sessionAccount(hash) {
      const session = await sessions.findOne({ _id: hash, expires: { $gt: new Date() } })
      return session ? getAccount(session.accountId) : undefined
    },
    async startOAuth({ state, expires, ...attempt }) {
      await oauth.insertOne({ _id: state, ...attempt, expires: new Date(expires), status: 'pending' })
    },
    async claimOAuth(state, provider) {
      const attempt = await oauth.findOneAndUpdate(
        { _id: state, provider, expires: { $gt: new Date() }, status: 'pending' },
        { $set: { status: 'exchanging' } },
      )
      return attempt ? {
        verifier: attempt.verifier,
        returnTarget: attempt.returnTarget ?? (attempt.returnWeb ? 'web' : 'app'),
      } : undefined
    },
    async finishOAuth(state, result) {
      await oauth.updateOne({ _id: state, status: 'exchanging' },
        { $set: result ? { ...result, status: 'done' } : { status: 'failed' } })
    },
    async oauthAccount(requestHash, receiptHash) {
      const attempt = await oauth.findOne({ requestHash, receiptHash, status: 'done', expires: { $gt: new Date() } })
      return attempt?.accountId ? getAccount(attempt.accountId) : undefined
    },
  }
}

let storage: Promise<AccountStore> | undefined

export function accountStore() {
  storage ??= (async () => {
    const uri = process.env.MONGODB_URI
    if (uri) return mongoStore(uri)

    const mount = process.env.RAILWAY_VOLUME_MOUNT_PATH
    const file = process.env.AUTH_DB_PATH || (mount && join(mount, 'accounts.sqlite'))
    if (!file && (process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production')) {
      throw new AccountStorageUnavailable('Account storage is being set up')
    }
    return sqliteStore(file || '.accounts.sqlite')
  })().catch(error => {
    storage = undefined
    throw error
  })
  return storage
}
