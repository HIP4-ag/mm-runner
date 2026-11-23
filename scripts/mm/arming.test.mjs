import test from 'node:test'
import assert from 'node:assert/strict'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { verifyMessage } from 'viem'
import { armingMessage, armingPhrase, maxArmingMs, statementVersion, verifyArming } from '../../lib/mm/arming.mjs'

const owner = privateKeyToAccount(generatePrivateKey())
const agent = privateKeyToAccount(generatePrivateKey()).address
const target = owner.address
const now = Date.parse('2026-11-21T12:00:00Z')

async function record(over = {}) {
  const base = {
    owner: owner.address,
    target,
    agent,
    device: 'Test PC',
    issuedAt: now - 1000,
    expiresAt: now + 3 * 86400e3,
    phrase: armingPhrase(target),
    statementVersion,
    ...over,
  }
  return { ...base, signature: over.signature ?? (await owner.signMessage({ message: armingMessage(base) })) }
}
const check = (rec, extra = {}) => verifyArming({ record: rec, owner: owner.address, target, agent, now, verify: verifyMessage, ...extra })

test('the phrase is MAINNET plus the last four characters of the account', () => {
  assert.equal(armingPhrase('0x0fdd59414989f52989973fef8995b7d10248cc18'), 'MAINNET CC18')
})

test('a valid signed record verifies and reports its expiry', async () => {
  const rec = await record()
  const result = await check(rec)
  assert.equal(result.verified, true)
  assert.equal(result.reason, null)
  assert.equal(result.expiresAt, rec.expiresAt)
})

test('a changed field breaks the signature', async () => {
  const rec = await record()
  for (const change of [{ device: 'Other PC' }, { expiresAt: rec.expiresAt + 1000 }, { issuedAt: rec.issuedAt - 1 }]) {
    assert.equal((await check({ ...rec, ...change })).verified, false)
  }
})

test('a record signed by another wallet fails', async () => {
  const other = privateKeyToAccount(generatePrivateKey())
  const base = { owner: owner.address, target, agent, device: 'Test PC', issuedAt: now - 1000, expiresAt: now + 86400e3, phrase: armingPhrase(target), statementVersion }
  const rec = { ...base, signature: await other.signMessage({ message: armingMessage(base) }) }
  const result = await check(rec)
  assert.equal(result.verified, false)
  assert.match(result.reason, /signature/)
})

test('an expired record fails', async () => {
  const result = await check(await record({ issuedAt: now - 5 * 86400e3, expiresAt: now - 1000 }))
  assert.equal(result.verified, false)
  assert.match(result.reason, /expired/)
})

test('a window longer than seven days fails', async () => {
  const result = await check(await record({ expiresAt: now - 1000 + maxArmingMs + 1 }))
  assert.equal(result.verified, false)
  assert.match(result.reason, /7 days/)
})

test('the wrong agent, owner, account or phrase fails', async () => {
  const rec = await record()
  assert.equal((await check(rec, { agent: privateKeyToAccount(generatePrivateKey()).address })).verified, false)
  assert.equal((await check(rec, { owner: privateKeyToAccount(generatePrivateKey()).address })).verified, false)
  assert.equal((await check(rec, { target: privateKeyToAccount(generatePrivateKey()).address })).verified, false)
  const wrongPhrase = await record({ phrase: 'MAINNET 0000' })
  const result = await check(wrongPhrase)
  assert.equal(result.verified, false)
  assert.match(result.reason, /phrase/)
})

test('a changed statement version, a missing record and a missing signature fail', async () => {
  assert.equal((await check(await record({ statementVersion: 'risk-0' }))).verified, false)
  assert.equal((await check(null)).verified, false)
  const rec = await record()
  assert.equal((await check({ ...rec, signature: undefined })).verified, false)
  assert.equal((await check(rec, { verify: undefined })).verified, false)
})

test('a verify function that throws fails closed', async () => {
  const result = await check(await record(), {
    verify: async () => {
      throw Error('boom')
    },
  })
  assert.equal(result.verified, false)
})
