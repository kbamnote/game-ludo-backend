import assert from 'node:assert/strict'
import { test } from 'node:test'
import { accountStore, InsufficientMatchCoins } from '../dist/accountStore.js'
import { readMatchEntry } from '../dist/matchEntry.js'

process.env.AUTH_DB_PATH = ':memory:'
delete process.env.MONGODB_URI

test('match entry accepts only the fixed numeric tiers or legacy free play', () => {
  for (const entry of [100, 300, 500, 1000, 2000]) assert.equal(readMatchEntry(entry), entry)
  for (const entry of [1, -100, '500', 100.5, null]) assert.equal(readMatchEntry(entry), undefined)
  assert.equal(readMatchEntry(undefined), 0)
})

test('coin pots debit atomically, settle once, split team prizes and refund expired holds', async () => {
  const store = await accountStore()
  for (const id of ['a', 'b', 'c', 'd']) {
    await store.createAccount({ id, subject: id, provider: 'guest', name: id, coins: 1000, diamonds: 10, avatar: null })
  }
  const balance = async id => (await store.accountById(id)).coins
  const balances = () => Promise.all(['a', 'b', 'c', 'd'].map(balance))
  const fund = (id, entry, accounts, expiresAt = 200) => store.fundMatchPot({ id, entry, accounts, expiresAt })

  assert.deepEqual(await fund('duel', 300, ['a', 'b']), [{ id: 'a', coins: 700 }, { id: 'b', coins: 700 }])
  assert.deepEqual(await balances(), [700, 700, 1000, 1000])
  await assert.rejects(async () => fund('overlap', 1000, ['d', 'a']), InsufficientMatchCoins)
  assert.deepEqual(await balances(), [700, 700, 1000, 1000])
  assert.equal(await store.settleMatchPot('duel', ['a']), true)
  assert.equal(await store.settleMatchPot('duel', ['a']), false)
  assert.deepEqual(await balances(), [1300, 700, 1000, 1000])

  await fund('team', 500, ['a', 'b', 'c', 'd'])
  assert.equal(await store.settleMatchPot('team', ['a', 'c']), true)
  assert.deepEqual(await balances(), [1800, 200, 1500, 500])

  await fund('abandoned', 100, ['b', 'd'])
  assert.equal(await store.settleMatchPot('abandoned', [], 199), false)
  await store.renewMatchPots(['abandoned'], 500)
  assert.deepEqual(await store.expiredMatchPots(200), [])
  assert.deepEqual(await store.expiredMatchPots(500), [{ id: 'abandoned', accounts: ['b', 'd'] }])
  assert.equal(await store.settleMatchPot('abandoned', [], 500), true)
  assert.deepEqual(await balances(), [1800, 200, 1500, 500])
})
