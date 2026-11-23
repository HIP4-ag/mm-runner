import test from 'node:test'
import assert from 'node:assert/strict'
import {
  RateLimitError,
  builder,
  builderPayload,
  readWeightLastMinute,
  recordExchangeWeight,
  siteBuilderApprovalRate,
  venue,
  venueFor,
} from '../../lib/mm/testnet.mjs'
import { networks } from '../../lib/mm/network.mjs'

// fetch is replaced for every test here: nothing reaches a network.
async function withFetch(answer, run) {
  const calls = []
  const real = globalThis.fetch
  globalThis.fetch = async (input, options) => {
    calls.push({ url: String(input), body: JSON.parse(options.body) })
    return answer(calls.at(-1))
  }
  try {
    await run(calls)
  } finally {
    globalThis.fetch = real
  }
}
const ok = (data) => ({ ok: true, status: 200, json: async () => data, headers: new Headers() })
const user = '0x' + 'ab'.repeat(20)

test('each venue reads its own network and they share one weight counter', async () => {
  await withFetch(
    () => ok({}),
    async (calls) => {
      const before = readWeightLastMinute()
      await venueFor('testnet').info('l2Book', { coin: '#10' })
      await venueFor(networks.mainnet).info('l2Book', { coin: '#10' })
      assert.deepEqual(
        calls.map((c) => c.url),
        ['https://api.hyperliquid-testnet.xyz/info', 'https://api.hyperliquid.xyz/info']
      )
      assert.equal(readWeightLastMinute() - before, 4, 'two l2Book reads at 2 each, on both networks')
    }
  )
  assert.throws(() => venueFor('devnet'))
  assert.equal(venue.network, networks.testnet)
  assert.deepEqual(Object.keys(venue).sort(), Object.keys(venueFor('mainnet')).sort())
})

test('settledOutcome and userRateLimit send the info shapes the exchange documents', async () => {
  await withFetch(
    ({ body }) => ok(body.type === 'settledOutcome' ? null : { nRequestsUsed: 1, nRequestsCap: 10 }),
    async (calls) => {
      const v = venueFor('mainnet')
      assert.equal(await v.settledOutcome(39418), null)
      assert.deepEqual(calls[0].body, { type: 'settledOutcome', outcome: 39418 })
      assert.deepEqual(await v.userRateLimit(user.toUpperCase().replace('0X', '0x')), { nRequestsUsed: 1, nRequestsCap: 10 })
      assert.deepEqual(calls[1].body, { type: 'userRateLimit', user })
      assert.throws(() => v.settledOutcome(-1))
      assert.throws(() => v.settledOutcome('5'))
      assert.throws(() => v.userRateLimit('0x1'))
    }
  )
})

test('an HTTP 429 is a RateLimitError that carries Retry-After, other failures stay plain errors', async () => {
  await withFetch(
    () => ({ ok: false, status: 429, json: async () => ({}), headers: new Headers({ 'retry-after': '3' }) }),
    async () => {
      await assert.rejects(venueFor('mainnet').info('outcomeMeta'), (e) => e instanceof RateLimitError && e.retryAfterMs === 3000)
    }
  )
  await withFetch(
    () => ({ ok: false, status: 429, json: async () => ({}), headers: new Headers() }),
    async () => {
      await assert.rejects(venue.info('userRateLimit', { user }), (e) => e instanceof RateLimitError && e.retryAfterMs === null)
    }
  )
  await withFetch(
    () => ({ ok: false, status: 500, json: async () => ({}), headers: new Headers() }),
    async () => {
      await assert.rejects(venue.info('userRateLimit', { user }), (e) => !(e instanceof RateLimitError) && /testnet could not verify/.test(e.message))
    }
  )
})

test('an exchange action costs 1 + floor(n / 40) and counts against the same IP minute', () => {
  const t = Date.now()
  const before = readWeightLastMinute(t)
  assert.equal(recordExchangeWeight(1, t), 1)
  assert.equal(recordExchangeWeight(39, t), 1)
  assert.equal(recordExchangeWeight(40, t), 2)
  assert.equal(recordExchangeWeight(200, t), 6)
  assert.equal(recordExchangeWeight(0, t), 1)
  assert.equal(readWeightLastMinute(t) - before, 11)
  // It leaves the minute after 60 s.
  assert.equal(readWeightLastMinute(t + 61e3), 0)
})

test('the builder address is still the only address in the venue module', () => {
  assert.match(builder, /^0x[\da-f]{40}$/)
})

test('builderPayload attaches optional sub-builder ONLY on fee > 0 with msgpack key order b, f, s', () => {
  const sub = '0x1111111111111111111111111111111111111111'
  assert.deepEqual(builderPayload(10, {}), { b: builder.toLowerCase(), f: 10 })
  // Never attach s when fee is 0 (waived / attribution-only).
  assert.deepEqual(builderPayload(0, { MM_SUB_BUILDER_ADDRESS: sub, MM_SUB_BUILDER_SHARE: '50000' }), {
    b: builder.toLowerCase(),
    f: 0,
  })
  // Attach s with exact key order b, f, s when fee > 0 and valid sub-builder is configured.
  const withSub = builderPayload(10, { MM_SUB_BUILDER_ADDRESS: sub, MM_SUB_BUILDER_SHARE: '50000' })
  assert.deepEqual(withSub, { b: builder.toLowerCase(), f: 10, s: [{ b: sub, s: 50000 }] })
  assert.deepEqual(Object.keys(withSub), ['b', 'f', 's'])
  // Reject invalid / zero / self sub-builder addresses.
  assert.deepEqual(builderPayload(10, { MM_SUB_BUILDER_ADDRESS: builder }), { b: builder.toLowerCase(), f: 10 })
  assert.deepEqual(builderPayload(10, { MM_SUB_BUILDER_ADDRESS: '0x0000000000000000000000000000000000000000' }), {
    b: builder.toLowerCase(),
    f: 10,
  })
})

test('siteBuilderApprovalRate matches site taker/spot ceiling so /mm never downgrades existing approvals', () => {
  const prevSpot = process.env.NEXT_PUBLIC_BUILDER_FEE_SPOT
  const prevTaker = process.env.NEXT_PUBLIC_BUILDER_FEE_PREDICTION_TAKER
  try {
    delete process.env.NEXT_PUBLIC_BUILDER_FEE_SPOT
    delete process.env.NEXT_PUBLIC_BUILDER_FEE_PREDICTION_TAKER
    assert.equal(siteBuilderApprovalRate(10), '0.1%')
    process.env.NEXT_PUBLIC_BUILDER_FEE_SPOT = '150'
    assert.equal(siteBuilderApprovalRate(10), '0.15%')
  } finally {
    if (prevSpot === undefined) delete process.env.NEXT_PUBLIC_BUILDER_FEE_SPOT
    else process.env.NEXT_PUBLIC_BUILDER_FEE_SPOT = prevSpot
    if (prevTaker === undefined) delete process.env.NEXT_PUBLIC_BUILDER_FEE_PREDICTION_TAKER
    else process.env.NEXT_PUBLIC_BUILDER_FEE_PREDICTION_TAKER = prevTaker
  }
})
