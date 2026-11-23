import test from 'node:test'
import assert from 'node:assert/strict'
import { HttpTransport } from '@nktkas/hyperliquid'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { exchangeClientFor } from './exchange-client.mjs'
import { mainnetOrdersEnabled, networks, networkOf } from '../../lib/mm/network.mjs'

const wallet = privateKeyToAccount(generatePrivateKey())
const t0 = Date.UTC(2026, 10, 21, 12)
const arming = { verified: true, agent: wallet.address, expiresAt: t0 + 86400e3 }

const fake = (isTestnet = false) => {
  const sent = []
  let reads = 0
  return {
    sent,
    reads: () => reads,
    get isTestnet() {
      reads++
      return isTestnet
    },
    request: async (endpoint, payload) => {
      sent.push({ endpoint, payload })
      return { status: 'ok', response: { type: 'default' } }
    },
  }
}

// Every test that could reach the network runs with fetch replaced, so a stray real call is recorded, not sent.
async function withFetchStub(run) {
  const calls = []
  const real = globalThis.fetch
  globalThis.fetch = async (input) => {
    calls.push(String(input?.url ?? input))
    throw Error('stubbed fetch')
  }
  try {
    await run(calls)
  } finally {
    globalThis.fetch = real
  }
}

test('the mainnet switch is off and the network records are what the plan says', () => {
  assert.equal(mainnetOrdersEnabled, false)
  assert.equal(networks.mainnet.isTestnet, false)
  assert.equal(networks.testnet.isTestnet, true)
  assert.equal(networkOf('mainnet'), networks.mainnet)
  assert.equal(networkOf(networks.testnet), networks.testnet)
  for (const bad of ['', 'main', 'MAINNET', undefined, null, 5]) assert.throws(() => networkOf(bad))
  assert.ok(Object.isFrozen(networks) && Object.isFrozen(networks.mainnet))
})

test('a mainnet real transport throws while the switch is off, even with a verified arming', () => {
  assert.throws(() => exchangeClientFor({ network: 'mainnet', wallet, arming, now: t0 }), /switched off/)
  assert.throws(
    () =>
      exchangeClientFor({ network: 'mainnet', wallet, arming, transport: new HttpTransport({ isTestnet: false }), now: t0 }),
    /switched off/
  )
})

test('under NODE_TEST_CONTEXT a real mainnet transport is refused whatever else holds', () => {
  assert.ok(process.env.NODE_TEST_CONTEXT, 'node --test sets this')
  assert.throws(() => exchangeClientFor({ network: 'mainnet', wallet, arming, now: t0 }))
})

test('a fake mainnet transport needs a verified arming for this agent', () => {
  const t = fake(false)
  const other = privateKeyToAccount(generatePrivateKey())
  for (const bad of [
    undefined,
    {},
    { verified: false, agent: wallet.address, expiresAt: t0 + 1000 },
    { verified: 'yes', agent: wallet.address, expiresAt: t0 + 1000 },
    { verified: true, agent: other.address, expiresAt: t0 + 1000 },
    { verified: true, expiresAt: t0 + 1000 },
    { verified: true, agent: wallet.address, expiresAt: t0 - 1 },
    { verified: true, agent: wallet.address },
  ])
    assert.throws(() => exchangeClientFor({ network: 'mainnet', wallet, arming: bad, transport: t, now: t0 }), /arming/)
  // A fake that does not say it signs for mainnet is refused too.
  assert.throws(() => exchangeClientFor({ network: 'mainnet', wallet, arming, transport: fake(true), now: t0 }), /mainnet/)
  assert.throws(() => exchangeClientFor({ network: 'mainnet', wallet, arming, transport: {}, now: t0 }))
  assert.equal(t.sent.length, 0)
})

test('a fake mainnet transport with arming signs for mainnet and never touches fetch', async () => {
  await withFetchStub(async (calls) => {
    const t = fake(false)
    const client = exchangeClientFor({ network: 'mainnet', wallet, arming, transport: t, now: t0 })
    await client.scheduleCancel({ time: Date.now() + 60e3 })
    assert.equal(t.sent.length, 1)
    assert.equal(t.sent[0].endpoint, 'exchange')
    assert.equal(t.sent[0].payload.action.type, 'scheduleCancel')
    assert.ok(t.reads() > 0, 'the SDK read isTestnet to pick the signing domain')
    assert.equal(calls.filter((url) => url.includes('api.hyperliquid.xyz/exchange')).length, 0)
    assert.equal(calls.length, 0)
  })
})

test('every refused mainnet path leaves the mainnet exchange url uncalled', async () => {
  await withFetchStub(async (calls) => {
    const attempts = [
      () => exchangeClientFor({ network: 'mainnet', wallet, arming, now: t0 }),
      () => exchangeClientFor({ network: 'mainnet', wallet, now: t0 }),
      () =>
        exchangeClientFor({ network: 'mainnet', wallet, arming, transport: new HttpTransport({ isTestnet: false }), now: t0 }),
      () => exchangeClientFor({ network: 'mainnet', wallet, transport: fake(false), now: t0 }),
    ]
    for (const attempt of attempts) assert.throws(attempt)
    assert.deepEqual(
      calls.filter((url) => url.includes('api.hyperliquid.xyz/exchange')),
      []
    )
  })
})

test('testnet works as before and refuses a mainnet transport', () => {
  assert.ok(exchangeClientFor({ network: 'testnet', wallet }))
  assert.ok(exchangeClientFor({ network: 'testnet', wallet, transport: fake(true) }))
  assert.throws(() => exchangeClientFor({ network: 'testnet', wallet, transport: new HttpTransport({ isTestnet: false }) }))
  assert.throws(() => exchangeClientFor({ network: 'testnet', wallet, transport: fake(false) }))
  assert.throws(() => exchangeClientFor({ network: 'testnet' }))
  assert.throws(() => exchangeClientFor({ network: 'devnet', wallet }))
})
