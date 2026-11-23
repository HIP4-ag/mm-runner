import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { bidStopFor, entryGate, hourlyLoss, lossCheck, marketGate, pullCheck, quotingHoursOpen, startBlocked } from './guards.mjs'
import { loadPolicy } from './policy/index.mjs'

const policy = loadPolicy()
const hour = 3600e3
const start = Date.parse('2026-11-20T20:00:00Z')
const good = [
  { bestBid: 0.49, bestAsk: 0.51 },
  { bestBid: 0.49, bestAsk: 0.51 },
]
const gate = (overrides = {}) =>
  entryGate({ mid: 0.5, legs: good, start, now: start - 6 * hour, family: 'nfl', hasResting: false, policy, ...overrides })
const codes = (result) => result.reasons.map((reason) => reason.code)

test('a clean market allows both legs', () => {
  const result = gate()
  assert.deepEqual(result.legs, [true, true])
  assert.deepEqual(result.reasons, [])
})

test('no bids inside the bid stop: 3 h for every family by default, no family singled out', () => {
  for (const family of ['nba', 'nfl', 'soccer', 'esports', 'other']) {
    assert.deepEqual(gate({ now: start - 2.5 * hour, family }).legs, [false, false], family)
    assert.deepEqual(codes(gate({ now: start - 2.5 * hour, family })), ['bid_stop'])
    assert.deepEqual(gate({ now: start - 3.5 * hour, family }).legs, [true, true], family)
  }
})

test('the user bid stop per family, never shorter than that family entry close', () => {
  const settings = policy.settingsFor({ bidStopHours: { nba: 72, soccer: 0.1, nfl: 1 } })
  const stop = (family) => bidStopFor({ family, settings, policy })
  assert.equal(stop('nba'), 72 * hour)
  assert.equal(stop('soccer'), hour)
  assert.equal(stop('nfl'), hour)
  // A family the user has no value for gets the longest of their stops.
  assert.equal(stop('futures'), 72 * hour)
  assert.equal(stop('tennis'), 72 * hour)
  // Passed straight to the gate, a stop under the entry close is raised to it.
  assert.deepEqual(gate({ now: start - 30 * 60e3, family: 'nfl', bidStopMs: 60e3 }).legs, [true, true])
  assert.deepEqual(gate({ now: start - 19 * 60e3, family: 'nfl', bidStopMs: 60e3 }).legs, [false, false])
  assert.deepEqual(gate({ now: start - 59 * 60e3, family: 'soccer', bidStopMs: 60e3 }).legs, [false, false])
  assert.deepEqual(gate({ now: start - 2 * hour, family: 'nfl', bidStopMs: stop('nba') }).legs, [false, false])
  assert.equal(gate({ bidStopMs: NaN }).reasons[0].code, 'bid_stop')
  // Without settings the policy default is used.
  assert.equal(bidStopFor({ family: 'nba', policy }), 3 * hour)
})

test('no bids when the mid is outside the range', () => {
  assert.deepEqual(codes(gate({ mid: 0.04 })), ['mid'])
  assert.deepEqual(codes(gate({ mid: 0.96 })), ['mid'])
  assert.deepEqual(gate({ mid: 0.05 }).legs, [true, true])
})

test('a leg priced under the minimum is skipped, the other stays', () => {
  const result = gate({
    legs: [
      { bestBid: 0.88, bestAsk: 0.9 },
      { bestBid: 0.08, bestAsk: 0.1 },
    ],
    mid: 0.89,
  })
  assert.deepEqual(result.legs, [true, false])
  assert.equal(result.reasons[0].code, 'min_price')
  assert.equal(result.reasons[0].leg, 1)
})

test('a wide spread blocks a new bid but not one already resting', () => {
  const wide = [
    { bestBid: 0.47, bestAsk: 0.51 },
    { bestBid: 0.49, bestAsk: 0.53 },
  ]
  assert.deepEqual(gate({ legs: wide }).legs, [false, false])
  assert.deepEqual(gate({ legs: wide, hasResting: true }).legs, [true, true])
  assert.deepEqual(gate({ legs: wide, hasResting: [true, false] }).legs, [true, false])
})

test('a one-sided or missing book blocks the leg', () => {
  const result = gate({ legs: [{ bestBid: 0.49 }, good[1]] })
  assert.deepEqual(result.legs, [false, true])
  assert.equal(result.reasons[0].code, 'book')
})

test('start minus 60 s blocks everything, whatever the other gates say', () => {
  assert.equal(startBlocked(start, start - 60000), true)
  assert.equal(startBlocked(start, start - 60001), false)
  const result = gate({ now: start - 30000, hasResting: true })
  assert.deepEqual(result.legs, [false, false])
  assert.deepEqual(codes(result), ['start'])
  assert.deepEqual(codes(gate({ start: undefined })), ['start'])
})

test('a pull fires on a move above half the distance and not below it', () => {
  const now = 1e9
  const state = { refMid: 0.5, lastMoveAt: null }
  const bids = [{ leg: 0, px: 0.48 }, { leg: 1, px: 0.48 }]
  const small = pullCheck({ state, mid: 0.509, restingBids: bids, now, policy })
  assert.equal(small.pull, false)
  assert.deepEqual(small.state, { refMid: 0.5, lastMoveAt: null })
  const big = pullCheck({ state, mid: 0.511, restingBids: bids, now, policy })
  assert.equal(big.pull, true)
  assert.deepEqual(big.state, { refMid: 0.511, lastMoveAt: now })
  const down = pullCheck({ state, mid: 0.489, restingBids: bids, now, policy })
  assert.equal(down.pull, true)
})

test('the nearest resting bid sets the distance, in YES terms for a NO bid', () => {
  const state = { refMid: 0.5, lastMoveAt: null }
  // The NO bid at 0.49 is 0.01 from the mid in YES terms: half of that is 0.005.
  const close = [{ leg: 0, px: 0.4 }, { leg: 1, px: 0.49 }]
  assert.equal(pullCheck({ state, mid: 0.504, restingBids: close, now: 1e9, policy }).pull, false)
  assert.equal(pullCheck({ state, mid: 0.506, restingBids: close, now: 1e9, policy }).pull, true)
})

test('our own fill pulls the other bids', () => {
  const result = pullCheck({
    state: { refMid: 0.5, lastMoveAt: null },
    mid: 0.5,
    restingBids: [{ leg: 0, px: 0.48 }],
    now: 5e8,
    filled: true,
    policy,
  })
  assert.equal(result.pull, true)
  assert.equal(result.state.lastMoveAt, 5e8)
})

test('re-entry only after 60 s of calm', () => {
  const t = 1e9
  const pulled = pullCheck({
    state: { refMid: 0.5, lastMoveAt: null },
    mid: 0.52,
    restingBids: [{ leg: 0, px: 0.48 }],
    now: t,
    policy,
  })
  assert.equal(pulled.pull, true)
  assert.equal(pulled.calm, false)
  const early = pullCheck({ state: pulled.state, mid: 0.52, restingBids: [], now: t + 59999, policy })
  assert.equal(early.calm, false)
  assert.equal(early.state.refMid, 0.52)
  const later = pullCheck({ state: pulled.state, mid: 0.521, restingBids: [], now: t + 60000, policy })
  assert.equal(later.pull, false)
  assert.equal(later.calm, true)
  assert.equal(later.state.refMid, 0.521)
})

// A wall-clock time in US Eastern on 2026-11-20 (EST, UTC-5) as epoch ms, whatever the zone of this machine.
const at = (h, m) => Date.UTC(2026, 10, 20, h + 5, m)

test('quoting hours: null is always open, windows may wrap midnight, read in US Eastern', () => {
  assert.equal(quotingHoursOpen(null, at(3, 0)), true)
  const day = { from: '09:00', to: '17:30' }
  assert.equal(quotingHoursOpen(day, at(9, 0)), true)
  assert.equal(quotingHoursOpen(day, at(17, 29)), true)
  assert.equal(quotingHoursOpen(day, at(17, 30)), false)
  assert.equal(quotingHoursOpen(day, at(8, 59)), false)
  const night = { from: '22:00', to: '06:00' }
  assert.equal(quotingHoursOpen(night, at(23, 0)), true)
  assert.equal(quotingHoursOpen(night, at(5, 59)), true)
  assert.equal(quotingHoursOpen(night, at(12, 0)), false)
})

test('loss check marks held shares at the best bid after the taker fee and breaches at the stop', () => {
  const positions = { 7010: { shares: 100, cost: 50 } }
  const fee = 0.0011
  const flat = lossCheck({ realizedTodayUsd: 0, positions, marks: { 7010: 0.5 }, stopUsd: 10 })
  assert.ok(Math.abs(flat.markedLossUsd - 50 * fee) < 1e-9)
  assert.equal(flat.breached, false)
  assert.equal(lossCheck({ positions, marks: { 7010: 0.5 }, stopUsd: 10, feeRate: 0 }).markedLossUsd, 0)
  const down = lossCheck({ realizedTodayUsd: -3, positions, marks: { 7010: 0.45 }, stopUsd: 10 })
  assert.ok(Math.abs(down.markedLossUsd - (8 + 45 * fee)) < 1e-9)
  assert.equal(down.breached, false)
  const breach = lossCheck({ realizedTodayUsd: -3, positions, marks: { 7010: 0.4 }, stopUsd: 10 })
  assert.equal(breach.breached, true)
  assert.equal(lossCheck({ realizedTodayUsd: 5, positions: {}, marks: {}, stopUsd: 1 }).markedLossUsd, 0)
  // A missing mark counts as worthless.
  assert.equal(lossCheck({ positions, marks: {}, stopUsd: 10 }).markedLossUsd, 50)
})

test('loss check fails closed on unreadable input', () => {
  const positions = { 7010: { shares: 100, cost: 50 } }
  const marks = { 7010: 0.5 }
  for (const bad of [
    { stopUsd: undefined },
    { stopUsd: NaN },
    { stopUsd: 0 },
    { stopUsd: -5 },
    { stopUsd: '10' },
    { stopUsd: 10, realizedTodayUsd: NaN },
    { stopUsd: 10, realizedTodayUsd: null },
    { stopUsd: 10, positions: { 7010: { shares: NaN, cost: 50 } } },
    { stopUsd: 10, positions: { 7010: { shares: 100, cost: undefined } } },
    { stopUsd: 10, positions: { 7010: null } },
    { stopUsd: 10, feeRate: -1 },
    { stopUsd: 10, feeRate: 2 },
    { stopUsd: 10, feeRate: NaN },
  ]) {
    const result = lossCheck({ positions, marks, ...bad })
    assert.equal(result.breached, true, JSON.stringify(bad))
    assert.equal(result.markedLossUsd, Infinity)
  }
})

test('entryGate fails closed on a missing clock, short legs and missing limits', () => {
  for (const now of [NaN, undefined, null, '1700000000000']) {
    const result = gate({ now })
    assert.deepEqual(result.legs, [false, false], String(now))
    assert.equal(result.reasons[0].code, 'start')
  }
  // One entry, none, or not an array: the missing leg is shut, never allowed.
  assert.deepEqual(gate({ legs: [good[0]] }).legs, [true, false])
  assert.deepEqual(gate({ legs: [] }).legs, [false, false])
  assert.deepEqual(gate({ legs: undefined }).legs, [false, false])
  assert.deepEqual(gate({ legs: [undefined, good[1]] }).legs, [false, true])
  // A policy without a leg price or spread limit shuts the market instead of turning those checks off.
  const missing = (key) => ({ ...policy, guards: { ...policy.guards, [key]: undefined } })
  assert.equal(gate({ policy: missing('minLegPrice') }).reasons[0].code, 'policy')
  assert.equal(gate({ policy: missing('maxEntrySpread') }).reasons[0].code, 'policy')
  assert.deepEqual(gate({ policy: missing('midMin') }).legs, [false, false])
  // A bid stop that is not a number shuts the market.
  const nanStop = { ...policy, guards: { ...policy.guards, bidStopMs: () => NaN } }
  assert.equal(gate({ policy: nanStop }).reasons[0].code, 'bid_stop')
  assert.equal(marketGate({ mid: 0.5, start, now: start - 6 * hour, family: 'nfl', policy }), null)
})

test('an unlisted family gets the longest bid stop', () => {
  assert.deepEqual(gate({ family: 'tennis', now: start - 2.5 * hour }).legs, [false, false])
  assert.deepEqual(gate({ family: undefined, now: start - 2.5 * hour }).legs, [false, false])
  assert.deepEqual(gate({ family: 'tennis', now: start - 3.5 * hour }).legs, [true, true])
  assert.deepEqual(gate({ family: '__proto__', now: start - 2.5 * hour }).legs, [false, false])
})

test('pullCheck pulls and reports not calm on anything it cannot read', () => {
  const state = { refMid: 0.5, lastMoveAt: null }
  const bids = [{ leg: 0, px: 0.48 }]
  for (const input of [
    { mid: NaN },
    { mid: undefined },
    { mid: 0.5, now: NaN },
    { mid: 0.5, now: undefined },
    { mid: 0.5, restingBids: [{ leg: 0 }] },
    { mid: 0.5, restingBids: [{ leg: 0, px: NaN }] },
  ]) {
    const result = pullCheck({ state, restingBids: bids, now: 1e9, policy, ...input })
    assert.equal(result.pull, true, JSON.stringify(input))
    assert.equal(result.calm, false)
  }
  const broken = { ...policy, guards: { ...policy.guards, pullMoveFraction: undefined } }
  assert.equal(pullCheck({ state, mid: 0.5, restingBids: bids, now: 1e9, policy: broken }).pull, true)
  // An unreadable mid keeps the old reference rather than replacing it with NaN.
  assert.equal(pullCheck({ state, mid: NaN, restingBids: bids, now: 1e9, policy }).state.refMid, 0.5)
})

test('quoting hours reject times that are not on the clock and non-object windows', () => {
  for (const hours of [
    { from: '25:00', to: '06:00' },
    { from: '09:00', to: '24:00' },
    { from: '09:60', to: '17:00' },
    { from: '9:00', to: '17:00' },
    { from: ['09:00'], to: '17:00' },
    ['09:00', '17:00'],
    'always',
    { from: '09:00', to: '09:00' },
  ])
    assert.equal(quotingHoursOpen(hours, at(10, 0)), false, JSON.stringify(hours))
  assert.equal(quotingHoursOpen({ from: '09:00', to: '17:00' }, NaN), false)
  assert.equal(quotingHoursOpen({ from: '23:59', to: '00:01' }, at(0, 0)), true)
})

test('quoting hours follow US Eastern daylight saving and accept a Date', () => {
  const day = { from: '09:00', to: '17:00' }
  // 2026-07-01 is EDT (UTC-4): 09:30 Eastern is 13:30 UTC.
  assert.equal(quotingHoursOpen(day, Date.UTC(2026, 6, 1, 13, 30)), true)
  assert.equal(quotingHoursOpen(day, Date.UTC(2026, 6, 1, 12, 59)), false)
  // 2026-12-01 is EST (UTC-5): 13:30 UTC is 08:30 Eastern.
  assert.equal(quotingHoursOpen(day, Date.UTC(2026, 11, 1, 13, 30)), false)
  assert.equal(quotingHoursOpen(day, new Date(Date.UTC(2026, 11, 1, 14, 30))), true)
  assert.equal(quotingHoursOpen(day, Date.UTC(2026, 11, 1, 14, 30), 'Not/AZone'), false)
})

test('quoting hours read the same under any server time zone', () => {
  const code = `
    import { quotingHoursOpen } from ${JSON.stringify(new URL('./guards.mjs', import.meta.url).href)}
    const day = { from: '09:00', to: '17:00' }
    const rows = [Date.UTC(2026, 10, 20, 14, 0), Date.UTC(2026, 10, 20, 13, 59), Date.UTC(2026, 10, 20, 21, 59), Date.UTC(2026, 10, 20, 22, 0)]
    process.stdout.write(JSON.stringify(rows.map((ms) => quotingHoursOpen(day, ms))))
  `
  for (const TZ of ['UTC', 'Asia/Tokyo', 'America/Los_Angeles']) {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, TZ }, encoding: 'utf8' })
    assert.deepEqual(JSON.parse(out), [true, false, true, false], TZ)
  }
})

test('hourly loss is the drop from the highest total in the trailing hour to the latest', () => {
  const t = Date.UTC(2026, 10, 20, 12)
  const history = [
    { at: t - 2 * hour, totalUsd: 50 },
    { at: t - 50 * 60e3, totalUsd: 10 },
    { at: t - 30 * 60e3, totalUsd: 12 },
    { at: t - 10 * 60e3, totalUsd: 4 },
    { at: t, totalUsd: 5 },
  ]
  assert.deepEqual(hourlyLoss({ history, now: t }), { lossUsd: 7, breached: false })
  assert.deepEqual(hourlyLoss({ history, now: t, stopUsd: 7 }), { lossUsd: 7, breached: true })
  assert.deepEqual(hourlyLoss({ history, now: t, stopUsd: 8 }), { lossUsd: 7, breached: false })
  // A rise is no loss; rows outside the hour and in the future do not count; no rows is no loss.
  assert.equal(hourlyLoss({ history: [{ at: t - 60e3, totalUsd: -5 }, { at: t, totalUsd: 3 }], now: t }).lossUsd, 0)
  assert.equal(hourlyLoss({ history: [...history, { at: t + 60e3, totalUsd: -100 }], now: t }).lossUsd, 7)
  assert.equal(hourlyLoss({ history: [], now: t }).lossUsd, 0)
  // Order does not matter.
  assert.equal(hourlyLoss({ history: [...history].reverse(), now: t }).lossUsd, 7)
})

test('hourly loss fails closed on anything it cannot read', () => {
  const t = 1e12
  for (const input of [
    { history: [{ at: t, totalUsd: NaN }], now: t },
    { history: [{ at: 'x', totalUsd: 1 }], now: t },
    { history: [null], now: t },
    { history: 'rows', now: t },
    { history: [], now: NaN },
    { history: [], now: t, stopUsd: 0 },
    { history: [], now: t, stopUsd: NaN },
  ])
    assert.deepEqual(hourlyLoss(input), { lossUsd: Infinity, breached: true }, JSON.stringify(input))
})

test('the user pull settings replace the defaults and stay inside the hard ranges', () => {
  const state = { refMid: 0.5, lastMoveAt: null }
  const bids = [{ leg: 0, px: 0.48 }]
  // Distance 0.02: at 25% a move of 0.006 pulls, at the default 50% it does not.
  assert.equal(pullCheck({ state, mid: 0.506, restingBids: bids, now: 1e9, policy }).pull, false)
  assert.equal(pullCheck({ state, mid: 0.506, restingBids: bids, now: 1e9, policy, moveFraction: 0.25 }).pull, true)
  // Below the 25% floor is raised to it; a 10 s calm time is raised to 60 s.
  assert.equal(pullCheck({ state, mid: 0.504, restingBids: bids, now: 1e9, policy, moveFraction: 0.01 }).pull, false)
  const pulled = pullCheck({ state, mid: 0.52, restingBids: bids, now: 1e9, policy, calmMs: 10e3 })
  assert.equal(pullCheck({ state: pulled.state, mid: 0.52, restingBids: [], now: 1e9 + 30e3, policy, calmMs: 10e3 }).calm, false)
  assert.equal(pullCheck({ state: pulled.state, mid: 0.52, restingBids: [], now: 1e9 + 200e3, policy, calmMs: 300e3 }).calm, false)
  assert.equal(pullCheck({ state: pulled.state, mid: 0.52, restingBids: [], now: 1e9 + 300e3, policy, calmMs: 300e3 }).calm, true)
})
