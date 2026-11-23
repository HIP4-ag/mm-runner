import test from 'node:test'
import assert from 'node:assert/strict'
import { loadPolicy } from './policy/index.mjs'
import { assertPolicyEnvelope, entryCloseMs, familyKeys, hardCaps, sealPolicy } from './guards.mjs'
import reference from './policy/reference.mjs'

const policy = loadPolicy()
const hour = 3600e3
const min = 60e3

test('the loaded policy is the reference policy and passes the envelope', () => {
  assert.equal(policy.version, 'reference-2')
  assert.doesNotThrow(() => assertPolicyEnvelope(policy))
  assert.equal(loadPolicy(), policy)
})

test('the policy holds hard limits and neutral defaults only: no strategy of ours', () => {
  for (const key of ['sizing', 'familyLevels', 'rank', 'preferenceBounds']) assert.equal(key in policy, false, key)
  assert.equal('fractionFor' in policy.pricing, false)
  // No family is singled out: the same bid stop and every family on by default.
  const stops = new Set(['nba', 'nfl', 'soccer', 'esports', 'other', 'futures', 'tennis'].map(policy.guards.bidStopMs))
  assert.deepEqual([...stops], [3 * hour])
  const s = policy.settingsFor({})
  assert.deepEqual(new Set(Object.values(s.bidStopMs)), new Set([3 * hour]))
  assert.ok(Object.values(s.families).every((on) => on === true))
  for (const key of ['risk', 'familyWeight']) assert.equal(key in reference.settingsFor({}), false, key)
  // Defaults are generic: budget 200, $30 a side (clears Monarch's $50 combined notional floor after whole-share rounding),
  // 2 markets, depth 30%, loss stops 10% and 40% of that, neutral 1 weights everywhere.
  assert.equal(s.budgetUsd, 200)
  assert.equal(s.perSideUsd, 30)
  assert.equal(s.maxHeldPerLegUsd, 30)
  assert.equal(s.marketCount, 2)
  assert.equal(s.depthFraction, 0.3)
  assert.equal(s.dailyLossStopUsd, 20)
  assert.equal(s.hourlyLossStopUsd, 8)
  assert.equal(s.requoteMs, 120e3)
  assert.equal(s.pullMoveFraction, 0.5)
  assert.equal(s.calmMs, 60e3)
  assert.equal(s.pick, 'manual')
  assert.deepEqual(s.manualMarkets, [])
  assert.deepEqual(s.excludeMarkets, [])
  assert.deepEqual(s.familyWeights, { nba: 1, nfl: 1, soccer: 1, esports: 1, other: 1 })
  assert.deepEqual(s.rankWeights, { pool: 1, start: 1, spread: 1 })
  assert.equal(s.hours, null)
})

test('settingsFor maps the user values straight through, clamped to the hard ranges', () => {
  const s = policy.settingsFor({
    budgetUsd: 1000,
    perSideUsd: 80,
    maxHeldPerLegUsd: 40,
    markets: 3,
    depthPct: 45,
    bidStopHours: { nba: 72, soccer: 2, esports: 0.5, nfl: 0.1 },
    requoteSeconds: 300,
    families: { nba: false },
    pick: 'auto',
    manualMarkets: [701, 702],
    dailyLossStopUsd: 30,
    hourlyLossStopUsd: 10,
    pullMovePct: 80,
    calmSeconds: 120,
    hours: { from: '09:00', to: '17:00' },
  })
  assert.equal(s.perSideUsd, 80)
  assert.equal(s.maxHeldPerLegUsd, 40)
  assert.equal(s.marketCount, 3)
  assert.equal(s.depthFraction, 0.45)
  assert.equal(s.bidStopMs.nba, 72 * hour)
  assert.equal(s.bidStopMs.soccer, 2 * hour)
  // Never later than the entry close: 60 min for esports, 20 min for nfl.
  assert.equal(s.bidStopMs.esports, 60 * min)
  assert.equal(s.bidStopMs.nfl, 20 * min)
  assert.equal(s.bidStopMs.other, 3 * hour)
  assert.equal(s.requoteMs, 300e3)
  assert.equal(s.families.nba, false)
  assert.equal(s.familyWeight.nba, 0)
  assert.equal(s.familyWeight.futures, 0)
  assert.equal(s.pick, 'auto')
  assert.deepEqual(s.manualMarkets, [701, 702])
  assert.equal(s.dailyLossStopUsd, 30)
  assert.equal(s.hourlyLossStopUsd, 10)
  assert.equal(s.pullMoveFraction, 0.8)
  assert.equal(s.calmMs, 120e3)
  assert.equal(s.fractionFor(701), 0.45)
  assert.deepEqual(s.hours, { from: '09:00', to: '17:00' })
})

test('settingsFor never passes a hard limit whatever the preferences', () => {
  for (const budgetUsd of [1, 50, 100, 499, 2000, 10000, 1e9]) {
    for (const markets of [0, 1, 3, 6, 500]) {
      const s = policy.settingsFor({
        budgetUsd,
        markets,
        perSideUsd: 1e9,
        maxHeldPerLegUsd: 1e9,
        depthPct: 1,
        dailyLossStopUsd: 1e9,
        hourlyLossStopUsd: 1e9,
        requoteSeconds: 1,
        pullMovePct: 1,
        calmSeconds: 1,
        bidStopHours: { nba: 1e9, soccer: 0 },
        manualMarkets: [1, 2, 3, 4, 5, 6, 7, 8, -1, 'x'],
      })
      assert.ok(s.budgetUsd <= 10000 && s.budgetUsd >= 50)
      assert.ok(s.marketCount >= 1 && s.marketCount <= 6)
      assert.ok(s.perSideUsd <= 250 + 1e-9)
      assert.ok(s.perSideUsd <= s.budgetUsd / (2 * s.marketCount) + 1e-9)
      assert.ok(s.maxHeldPerLegUsd <= s.perSideUsd + 1e-9)
      assert.ok(s.depthFraction >= 0.15 && s.depthFraction <= 0.6)
      assert.ok(s.dailyLossStopUsd <= 0.25 * s.budgetUsd + 1e-9 && s.dailyLossStopUsd > 0)
      assert.ok(s.hourlyLossStopUsd <= s.dailyLossStopUsd && s.hourlyLossStopUsd > 0)
      assert.ok(s.requoteMs >= 60e3 && s.calmMs >= 60e3)
      assert.ok(s.pullMoveFraction >= 0.25 && s.pullMoveFraction <= 1)
      assert.ok(s.bidStopMs.nba <= 168 * hour && s.bidStopMs.soccer >= 60 * min)
      assert.ok(s.manualMarkets.length <= 6 && s.manualMarkets.every(Number.isSafeInteger))
    }
  }
})

// A mutable copy of the reference policy to tamper with before sealing it.
const fresh = () => {
  const copy = structuredClone({ ...reference, guards: { ...reference.guards, bidStopMs: undefined }, settingsFor: undefined })
  copy.guards.bidStopMs = reference.guards.bidStopMs
  copy.settingsFor = reference.settingsFor
  return copy
}
const refuses = (mutate, label) => {
  const p = fresh()
  mutate(p)
  assert.throws(() => sealPolicy(p), /envelope/, label)
}

test('the loaded policy is deep-frozen plain data and a sealed copy ignores later changes to its source', () => {
  const frozen = (value, path) => {
    if (value && typeof value === 'object') {
      assert.ok(Object.isFrozen(value), path)
      for (const key of Object.keys(value)) frozen(value[key], `${path}.${key}`)
    }
  }
  frozen(policy, 'policy')
  assert.throws(() => {
    'use strict'
    policy.guards.exit.times.default.forceMs = 1
  }, TypeError)
  assert.throws(() => {
    'use strict'
    policy.limits.perSideUsd[1] = 1e6
  }, TypeError)
  const source = fresh()
  const sealed = sealPolicy(source)
  source.guards.exit.refFloorFraction = 0.01
  source.limits.perSideUsd[1] = 1e9
  source.requests.cancelBatchMax = 5000
  assert.equal(sealed.guards.exit.refFloorFraction, 0.5)
  assert.equal(sealed.limits.perSideUsd[1], 250)
  assert.equal(sealed.requests.cancelBatchMax, 200)
  assert.doesNotThrow(() => sealPolicy(fresh()))
})

test('the envelope rejects every loosened safety rail', () => {
  const later = (group, key, value) => (p) => (p.guards.exit.times[group][key] = value)
  const cases = {
    'entry close after T-20': later('default', 'closeMs', 19 * min),
    'force after T-6': later('default', 'forceMs', 5 * min),
    'sweep after T-2': later('default', 'sweepMs', 1.5 * min),
    'soccer close after T-60': later('long', 'closeMs', 59 * min),
    'soccer force after T-15': later('long', 'forceMs', 14 * min),
    'soccer sweep after T-5': later('long', 'sweepMs', 4 * min),
    'force not after close': (p) => (p.guards.exit.times.default.forceMs = p.guards.exit.times.default.closeMs),
    'sweep not after force': (p) => (p.guards.exit.times.long.sweepMs = p.guards.exit.times.long.forceMs + 1),
    'a floor under half the reference': (p) => (p.guards.exit.refFloorFraction = 0.49),
    'a forced sell into an 11c spread': (p) => (p.guards.exit.maxSpread = 0.11),
    'a trusted spread over 3c': (p) => (p.guards.exit.trustedSpread = 0.04),
    'fewer than 3 reference samples': (p) => (p.guards.exit.refMinSamples = 2),
    'a no-reference spread over 3c': (p) => (p.guards.exit.noRef.maxSpread = 0.05),
    'a stable time under 60 s': (p) => (p.guards.exit.noRef.stableMs = 30e3),
    'a stable range over 2c': (p) => (p.guards.exit.noRef.stableRange = 0.03),
    'samples kept shorter than the window needs': (p) => (p.guards.exit.sampleKeepMs = 40 * min),
    'a 5c minimum leg price': (p) => (p.guards.minLegPrice = 0.05),
    'a 4c entry spread': (p) => (p.guards.maxEntrySpread = 0.04),
    'a 3% lowest mid': (p) => (p.guards.midMin = 0.03),
    'a 97% highest mid': (p) => (p.guards.midMax = 0.97),
    'a 10 min deadline': (p) => (p.dms.deadlineMs = 600e3),
    'a re-arm over half the deadline': (p) => (p.dms.rearmEveryMs = 200e3),
    'a 6 min rollover hold': (p) => (p.rollover.holdMs = 360e3),
    'a 300 order cancel batch': (p) => (p.requests.cancelBatchMax = 300),
    'a 60 s feed liveness': (p) => (p.feeds.livenessMs = 60e3),
    'IP weight 2000': (p) => (p.requests.ipWeightPerMin = 2000),
    'info weight 1200': (p) => (p.requests.infoWeightPerMin = 1200),
    'a 10 s requote floor': (p) => (p.requests.minRequoteMs = 10e3),
    '7 markets': (p) => (p.requests.maxMarkets = 7),
    'a market limit of 12': (p) => (p.limits.markets = [1, 12]),
    'a $500 size per side': (p) => (p.limits.perSideUsd = [10, 500]),
    'a daily loss stop of half the budget': (p) => (p.limits.dailyLossShareMax = 0.5),
    'a depth of 10%': (p) => (p.limits.depthPct = [10, 60]),
    'a depth of 80%': (p) => (p.limits.depthPct = [15, 80]),
    'a pricing range under 0.15': (p) => (p.pricing.range = [0.1, 0.6]),
    'a 30 s calm floor': (p) => (p.limits.calmSeconds = [30, 3600]),
    'a 10% pull move': (p) => (p.limits.pullMovePct = [10, 100]),
    'a 30 s requote range': (p) => (p.limits.requoteSeconds = [30, 3600]),
    'a 300 h bid stop': (p) => (p.limits.bidStopHoursMax = 300),
    'a 10 min bid stop': (p) => (p.guards.bidStopMs = () => 10 * min),
    'a 30 min soccer bid stop': (p) => (p.guards.bidStopMs = (f) => (f === 'soccer' ? 30 * min : 3 * hour)),
    'a default outside its range': (p) => (p.defaults.perSideUsd = 300),
    'a default pick that is not a choice': (p) => (p.defaults.pick = 'best'),
    'shrinking backoff steps': (p) => (p.requests.backoffMs = [60e3, 7e3]),
  }
  for (const [label, mutate] of Object.entries(cases)) refuses(mutate, label)
  assert.throws(() => assertPolicyEnvelope({}), /envelope/)
  assert.throws(() => sealPolicy(undefined), /envelope/)
})

test('the envelope accepts a stricter rail', () => {
  const stricter = fresh()
  stricter.guards.exit.times.default = { closeMs: 40 * min, forceMs: 10 * min, sweepMs: 3 * min }
  stricter.guards.exit.refFloorFraction = 0.7
  stricter.guards.exit.maxSpread = 0.05
  stricter.limits.perSideUsd = [10, 100]
  stricter.requests.cancelBatchMax = 100
  stricter.rollover.holdMs = 60e3
  const sealed = sealPolicy(stricter)
  assert.equal(entryCloseMs('nfl', sealed), 40 * min)
  assert.equal(sealed.settingsFor({ perSideUsd: 250, budgetUsd: 10000 }).perSideUsd, 100)
})

test('NaN, a missing key or a wrong type refuses', () => {
  const paths = [
    ['guards', 'minLegPrice'],
    ['guards', 'maxEntrySpread'],
    ['guards', 'midMin'],
    ['guards', 'midMax'],
    ['guards', 'pullMoveFraction'],
    ['guards', 'calmMs'],
    ['guards', 'maxExitLossFraction'],
    ['dms', 'deadlineMs'],
    ['selection', 'reselectMs'],
    ['feeds', 'livenessMs'],
    ['feeds', 'restSpotCheckMs'],
    ['rollover', 'holdMs'],
    ['rollover', 'feedStaleMs'],
    ...['maxMarkets', 'infoWeightPerMin', 'cancelReservePerMin', 'ipWeightPerMin', 'maxOrderActionsPerHour', 'actionsPerMarketPerHour', 'exitActionReserve', 'addressReserve', 'cancelBatchMax', 'minRequoteMs', 'refusalBackoffMaxMs', 'jitter'].map((k) => ['requests', k]),
    ...['slideStartMs', 'maxSpread', 'refFloorFraction', 'trustedSpread', 'refWindowMs', 'refMinSamples', 'sampleKeepMs'].map((k) => ['guards', 'exit', k]),
    ...['budgetUsd', 'perSideUsd', 'markets', 'depthPct', 'bidStopHours', 'dailyLossShare', 'hourlyLossShare'].map((k) => ['defaults', k]),
    ...['budgetUsd', 'perSideUsd', 'markets', 'depthPct', 'dailyLossShareMax', 'manualMarketsMax'].map((k) => ['limits', k]),
  ]
  for (const path of paths) {
    const at = (p) => path.slice(0, -1).reduce((o, k) => o[k], p)
    const key = path.at(-1)
    refuses((p) => (at(p)[key] = NaN), `${path.join('.')} NaN`)
    refuses((p) => delete at(p)[key], `${path.join('.')} missing`)
    refuses((p) => (at(p)[key] = '1'), `${path.join('.')} string`)
  }
  refuses((p) => delete p.settingsFor, 'settingsFor missing')
  refuses((p) => delete p.guards.exit, 'exit missing')
  refuses((p) => delete p.guards.exit.noRef, 'noRef missing')
  refuses((p) => delete p.version, 'version missing')
})

test('a stateful or throwing bidStopMs, a getter and an unlisted family cannot slip through', () => {
  let calls = 0
  const drift = fresh()
  drift.guards.bidStopMs = () => (++calls <= 6 ? 3 * hour : 0)
  const sealedDrift = sealPolicy(drift)
  for (let i = 0; i < 50; i++) assert.equal(sealedDrift.guards.bidStopMs('nfl'), 3 * hour)
  let reads = 0
  const getter = fresh()
  Object.defineProperty(getter.guards.exit, 'refFloorFraction', { get: () => (++reads === 1 ? 0.5 : 0.01), enumerable: true })
  const sealedGetter = sealPolicy(getter)
  assert.equal(sealedGetter.guards.exit.refFloorFraction, 0.5)
  assert.equal(sealedGetter.guards.exit.refFloorFraction, 0.5)
  const nan = fresh()
  nan.guards.bidStopMs = (family) => (['nba', 'nfl', 'soccer', 'esports', 'futures', 'other'].includes(family) ? (family === 'nba' ? 5 * hour : 3 * hour) : NaN)
  assert.equal(sealPolicy(nan).guards.bidStopMs('tennis'), 5 * hour)
  assert.equal(sealPolicy(nan).guards.bidStopMs(undefined), 5 * hour)
  const bad = fresh()
  bad.guards.bidStopMs = (family) => {
    if (family === 'soccer') throw Error('boom')
    return 3 * hour
  }
  assert.throws(() => sealPolicy(bad), /envelope/)
})

test('settingsFor output is clamped against fixed caps whatever the policy returns', () => {
  const good = {
    budgetUsd: 1000,
    marketCount: 2,
    perSideUsd: 100,
    maxHeldPerLegUsd: 100,
    depthFraction: 0.3,
    bidStopMs: Object.fromEntries(familyKeys.map((f) => [f, 3 * hour])),
    requoteMs: 120e3,
    families: Object.fromEntries(familyKeys.map((f) => [f, true])),
    pick: 'manual',
    manualMarkets: [],
    dailyLossStopUsd: 50,
    hourlyLossStopUsd: 20,
    pullMoveFraction: 0.5,
    calmMs: 60e3,
    hours: null,
  }
  const evil = fresh()
  evil.settingsFor = () => ({
    ...good,
    budgetUsd: 1e9,
    marketCount: 500,
    perSideUsd: 1e9,
    maxHeldPerLegUsd: 1e9,
    depthFraction: 0.01,
    bidStopMs: Object.fromEntries(familyKeys.map((f) => [f, 0])),
    requoteMs: 1,
    dailyLossStopUsd: 1e9,
    hourlyLossStopUsd: 1e9,
    pullMoveFraction: 0,
    calmMs: 0,
    manualMarkets: [1, 2, 3, 4, 5, 6, 7, 8],
  })
  const s = sealPolicy(evil).settingsFor({})
  assert.equal(s.budgetUsd, hardCaps.maxBudgetUsd)
  assert.equal(s.marketCount, 6)
  assert.ok(s.perSideUsd <= 250)
  assert.ok(s.maxHeldPerLegUsd <= s.perSideUsd)
  assert.equal(s.depthFraction, 0.15)
  assert.equal(s.fractionFor('x'), 0.15)
  assert.equal(s.bidStopMs.nfl, 20 * min)
  assert.equal(s.bidStopMs.soccer, 60 * min)
  assert.equal(s.requoteMs, 60e3)
  assert.equal(s.dailyLossStopUsd, 0.25 * hardCaps.maxBudgetUsd)
  assert.equal(s.hourlyLossStopUsd, s.dailyLossStopUsd)
  assert.equal(s.pullMoveFraction, 0.25)
  assert.equal(s.calmMs, 60e3)
  assert.equal(s.manualMarkets.length, 6)
  const broken = (patch) => {
    const p = fresh()
    p.settingsFor = () => ({ ...good, ...patch })
    return () => sealPolicy(p).settingsFor({})
  }
  assert.doesNotThrow(broken({}))
  for (const patch of [
    { budgetUsd: NaN },
    { budgetUsd: 0 },
    { perSideUsd: undefined },
    { maxHeldPerLegUsd: NaN },
    { dailyLossStopUsd: 0 },
    { dailyLossStopUsd: -1 },
    { hourlyLossStopUsd: undefined },
    { marketCount: NaN },
    { depthFraction: NaN },
    { bidStopMs: undefined },
    { bidStopMs: { nba: 3 * hour } },
    { requoteMs: NaN },
    { families: { nba: 'yes' } },
    { pick: 'best' },
    { manualMarkets: ['701'] },
    { manualMarkets: 'all' },
    { pullMoveFraction: NaN },
    { calmMs: undefined },
    { hours: { from: '25:00', to: '06:00' } },
    { hours: ['09:00', '17:00'] },
  ])
    assert.throws(broken(patch), /refused/, JSON.stringify(patch))
})
