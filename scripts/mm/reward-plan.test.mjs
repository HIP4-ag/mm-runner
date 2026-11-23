import test from 'node:test'
import assert from 'node:assert/strict'
import { budgetChoices, guardedRewardTick, planRewardQuotes, rewardTick } from './reward-plan.mjs'
import { loadPolicy } from './policy/index.mjs'

const now = Date.parse('2026-11-19T12:02:00Z')
const asOf = '2026-11-19T12:00:30Z'
const row = (overrides = {}) => ({
  market_id: 'O412',
  hyperliquid_outcome_id: 412,
  scoring_params: {
    baseline_total_spread_cents: 4,
    settlement_band_multiplier: 1,
    settlement_band_maximum_multiplier: 2,
    midpoint_min: 0.02,
    midpoint_max: 0.98,
    ...overrides,
  },
})
const book = (bid, ask, time = now - 1000) => ({
  coin: '#4120',
  time,
  levels: [[{ px: String(bid), sz: '100' }], [{ px: String(ask), sz: '100' }]],
})
const plan = (overrides = {}) =>
  planRewardQuotes({ row: row(), book: book(0.49, 0.51), asOf, now, budget: 100, approved: true, ...overrides })
const codes = (result) => result.blockers.map((entry) => entry.code)

test('a budget that covers $50 in band quotes both sides inside the band', () => {
  const result = plan()
  assert.equal(result.ok, true)
  assert.deepEqual(result.quotes, [
    { side: 'YES', price: 0.48999, shares: 102 },
    { side: 'NO', price: 0.48999, shares: 102 },
  ])
  assert.ok(result.depth >= 50)
  assert.ok(result.debit <= 100)
  assert.ok(result.quotes[0].price > result.band.low && 1 - result.quotes[1].price < result.band.high)
})

test('a $50 budget falls short of $50 in band once shares are whole and fees are reserved', () => {
  const result = plan({ budget: 50, feeRate: 0.0001 })
  assert.deepEqual(codes(result), ['depth'])
  assert.deepEqual(result.quotes, [])
  assert.ok(result.depth < 50)
  assert.ok(result.minBudget > 50 && result.minBudget < 51)
  assert.match(result.blockers[0].message, /Monarch needs \$50\.00/)
})

test('every plan is blocked when the frontend is not a confirmed reward frontend', () => {
  const result = planRewardQuotes({ row: row(), book: book(0.49, 0.51), asOf, now, budget: 100, approved: false })
  assert.equal(result.ok, false)
  assert.deepEqual(codes(result), ['frontend'])
})

test('a best price outside the band leaves nothing to quote behind it', () => {
  // 4 cent band at a 50% mid is 48 to 52: bids stay behind a 44 touch, which is outside the band, so both legs skip.
  const result = plan({ book: book(0.44, 0.56), budget: 250 })
  assert.equal(result.ok, false)
  assert.deepEqual(codes(result), ['touch'])
  assert.deepEqual(result.quotes, [])
})

test('a wider fraction rests further from the mid', () => {
  const near = plan({ fraction: 0.2, book: book(0.499, 0.501), budget: 250 })
  const far = plan({ fraction: 0.4, book: book(0.499, 0.501), budget: 250 })
  assert.equal(near.quotes[0].price, 0.49599)
  assert.ok(far.quotes[0].price < near.quotes[0].price)
  assert.throws(() => plan({ fraction: 0.9 }), /fraction/)
})

test('stale or unverifiable inputs block the plan', () => {
  assert.deepEqual(codes(plan({ book: book(0.49, 0.51, now - 7000) })), ['unverified'])
  assert.deepEqual(codes(plan({ book: book(0.985, 0.995) })), ['unverified'])
  assert.deepEqual(codes(plan({ row: row({ baseline_total_spread_cents: 0 }) })), ['unverified'])
  assert.deepEqual(codes(plan({ budget: 75 })), ['budget'])
})

test('budget choices mark exactly the budgets the runner would accept', () => {
  const choices = budgetChoices({ row: row(), book: book(0.49, 0.51), asOf, now, approved: true, feeRate: 0.0001 })
  assert.deepEqual(
    choices.map((choice) => [choice.budget, choice.ok]),
    [
      [50, false],
      [100, true],
      [250, true],
      [500, true],
    ]
  )
})

test('a run withdraws its quotes on the tick eligibility stops being verifiable, and resumes after', () => {
  const input = { row: row(), asOf, now, budget: 100, approved: true }
  assert.equal(rewardTick({ ...input, book: book(0.49, 0.51) }).quotes.length, 2)

  const stale = rewardTick({ ...input, book: book(0.49, 0.51, now - 9000) })
  assert.deepEqual(stale.quotes, [])
  assert.match(stale.held, /fresh YES order book/)

  const outside = rewardTick({ ...input, book: book(0.005, 0.015) })
  assert.deepEqual(outside.quotes, [])
  assert.match(outside.held, /outside the campaign scoring range/)

  const revoked = rewardTick({ ...input, book: book(0.49, 0.51), approved: false })
  assert.deepEqual(revoked.quotes, [])
  assert.match(revoked.held, /whitelisted reward frontend/)

  assert.equal(rewardTick({ ...input, book: book(0.49, 0.51) }).quotes.length, 2)
  assert.deepEqual(rewardTick({ ...input, book: null }).quotes, [])
})

const cash = (quote) => quote.price * quote.shares

test('a single allowed leg is sized by the per-side limits, never by the whole budget', () => {
  const open = plan({ budget: 250 })
  assert.equal(open.quotes.length, 2)
  const yesOnly = plan({ budget: 250, allowedLegs: [true, false] })
  assert.equal(yesOnly.ok, true)
  assert.deepEqual(yesOnly.quotes.map((q) => q.side), ['YES'])
  // No limit given: one side of a pair, so half the budget.
  assert.ok(cash(yesOnly.quotes[0]) <= 125 + 1e-9, String(cash(yesOnly.quotes[0])))
  assert.ok(cash(yesOnly.quotes[0]) > 100)
  const capped = plan({ budget: 250, allowedLegs: [false, true], perSideUsd: 60, maxHeldPerLegUsd: 55 })
  assert.deepEqual(capped.quotes.map((q) => q.side), ['NO'])
  assert.ok(cash(capped.quotes[0]) <= 55 + 1e-9)
  assert.ok(capped.debit <= 55 + 1e-9)
})

test('each leg of a pair stays inside the per-side limit even when the prices differ', () => {
  const skewed = plan({ book: book(0.79, 0.81), budget: 250, perSideUsd: 60, maxHeldPerLegUsd: 60 })
  assert.equal(skewed.ok, true)
  assert.equal(skewed.quotes.length, 2)
  for (const quote of skewed.quotes) assert.ok(cash(quote) <= 60 + 1e-9, `${quote.side} ${cash(quote)}`)
  // Without limits the cheap leg is held to the same shares and the dear leg takes more cash.
  const free = plan({ book: book(0.79, 0.81), budget: 250 })
  assert.ok(Math.max(...free.quotes.map(cash)) > 60)
})

test('no allowed leg means no quotes and a gate reason', () => {
  const none = plan({ allowedLegs: [false, false] })
  assert.equal(none.ok, false)
  assert.deepEqual(codes(none), ['gate'])
  assert.deepEqual(none.quotes, [])
  assert.deepEqual(rewardTick({ row: row(), book: book(0.49, 0.51), asOf, now, budget: 100, approved: true, allowedLegs: [false, false] }).quotes, [])
  assert.equal(plan({ perSideUsd: 0 }).ok, false)
})

// The paper loop applies the entry guards. The market starts at `start`, family and policy decide the bid stop.
test('a paper tick applies start block, bid stop and mid range, and sizes a lone leg to the limits', () => {
  const policy = loadPolicy()
  const hour = 3600e3
  const at = (start, over = {}, bk = book(0.49, 0.51)) =>
    guardedRewardTick({
      row: row({ scheduled_event_start: new Date(now + start).toISOString(), ...over }),
      book: bk,
      asOf,
      now,
      budget: 250,
      approved: true,
      perSideUsd: 100,
      maxHeldPerLegUsd: 100,
      family: 'nfl',
      policy,
    })
  assert.equal(at(6 * hour).quotes.length, 2)
  // Within a minute of the start, and inside the 3 h bid stop: nothing, with the guard's reason.
  assert.deepEqual(at(30e3).quotes, [])
  assert.match(at(30e3).held, /one minute|start/i)
  assert.deepEqual(at(2 * hour).quotes, [])
  assert.match(at(2 * hour).held, /too close/i)
  // A start time that cannot be read is a closed market.
  assert.deepEqual(at(6 * hour, { scheduled_event_start: 'soon' }).quotes, [])
  // A 0.96 mid is outside the quoting range even though the feed's own range allows it.
  const high = at(6 * hour, {}, book(0.95, 0.97))
  assert.deepEqual(high.quotes, [])
  assert.match(high.held, /midpoint/i)
  // A 0.92 mid leaves the NO leg under the minimum price: only YES is quoted, and within the limits.
  const lone = at(6 * hour, {}, book(0.919, 0.921))
  assert.deepEqual(lone.quotes.map((q) => q.side), ['YES'])
  assert.ok(lone.quotes[0].price * lone.quotes[0].shares <= 100 + 1e-9)
  // An unreadable book is held, not quoted.
  assert.deepEqual(at(6 * hour, {}, null).quotes, [])
})
