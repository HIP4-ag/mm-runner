import test from 'node:test'
import assert from 'node:assert/strict'
import {
  planMarket,
  diffOrders,
  emptyMarketState,
  bookTop,
  bookLevels,
  effectiveTops,
  effectiveLevels,
  withoutOwn,
  yesMid,
} from './desk-plan.mjs'
import { loadPolicy } from './policy/index.mjs'
import { testnetWidth, ceilTick, slotFraction } from './band-price.mjs'
import { recordSample } from './exit-guard.mjs'
import { breakevenPx, feeRatesFor } from './inventory.mjs'

const policy = loadPolicy()
const now = Date.UTC(2026, 10, 20, 12)
const settings = policy.settingsFor({ budgetUsd: 2000, perSideUsd: 150, markets: 2 })
const tight = () => [
  { bestBid: 0.499, bestAsk: 0.501, bestBidSz: 1000 },
  { bestBid: 0.499, bestAsk: 0.501, bestBidSz: 1000 },
]
const feeRates = feeRatesFor(0.0001)
const base = (over = {}) => ({
  now,
  market: { id: 701, start: now + 5 * 3600e3, family: 'other' },
  books: tight(),
  mid: 0.5,
  width: testnetWidth,
  fraction: 0.3,
  settings,
  policy,
  state: emptyMarketState(),
  lossBudgetLeftUsd: 50,
  available: [0, 0],
  feeRates,
  ...over,
})
const held = { shares: 100, cost: 50.1 }
const min = 60e3

test('buys pay the builder fee only; sells pay the exchange fee plus the builder fee', () => {
  assert.equal(feeRates.buy, 0.0001)
  assert.ok(Math.abs(feeRates.sellMaker - 0.00065) < 1e-12)
  assert.ok(Math.abs(feeRates.sellTaker - 0.0012) < 1e-12)
  assert.throws(() => feeRatesFor(0.5))
  assert.throws(() => feeRatesFor(NaN))
})

test('bids on both legs at the user depth, equal size, strictly behind the best bid', () => {
  const plan = planMarket(base())
  assert.equal(plan.status, 'quoting')
  assert.equal(plan.phase, 'open')
  const bids = plan.desired.filter((d) => d.b)
  assert.equal(bids.length, 2)
  for (const b of bids) {
    assert.ok(Math.abs(b.px - 0.497) <= 2e-5)
    assert.equal(b.tif, 'Alo')
    assert.ok(b.px < 0.501 && b.px < 0.499)
    assert.ok(b.px * b.sz <= Math.min(settings.perSideUsd, settings.maxHeldPerLegUsd) + 1e-9)
  }
  assert.equal(bids[0].sz, bids[1].sz)
})

test('hard rule: a bid is never at the best price and never closer to the mid than the smallest depth', () => {
  for (const mid of [0.2, 0.35, 0.5, 0.65, 0.8]) {
    for (const half of [0.0001, 0.001, 0.005, 0.01]) {
      for (const fraction of [0, 0.05, 0.15, 0.3, 0.6, 0.9]) {
        const books = [
          { bestBid: Number((mid - half).toFixed(5)), bestAsk: Number((mid + half).toFixed(5)), bestBidSz: 1000 },
          { bestBid: Number((1 - mid - half).toFixed(5)), bestAsk: Number((1 - mid + half).toFixed(5)), bestBidSz: 1000 },
        ]
        const eff = effectiveTops(books)
        for (const b of planMarket(base({ books, mid: yesMid(books), fraction })).desired.filter((d) => d.b)) {
          assert.ok(Math.round(b.px * 1e5) < Math.round(eff[b.legIdx].bestBid * 1e5), `behind ${mid} ${half} ${fraction}`)
          assert.ok(slotFraction(b.px, b.legIdx, { mid: yesMid(books), width: testnetWidth }) >= policy.pricing.range[0] - 1e-9)
        }
      }
    }
  }
})

test('our own resting bid is not the market: with ours alone at the top, no bid is placed in front of the rest', () => {
  // Our YES bid at 0.498 is the whole top of the YES book; the NO book has no asks, so nothing implies a YES bid.
  const books = [{ bestBid: 0.498, bestAsk: 0.501, bestBidSz: 301 }, { bestBid: 0.499, bestAsk: NaN, bestBidSz: 1000 }]
  const restingOwn = [{ oid: 1, legIdx: 0, b: true, px: 0.498, sz: 301, placedAt: now - 600e3 }]
  const plan = planMarket(base({ books, restingOwn }))
  assert.equal(plan.desired.filter((d) => d.b).length, 0)
  assert.deepEqual(withoutOwn(books, restingOwn)[0].bestBid, NaN)
  // A NO ask at 0.5025 implies a YES bid at 0.4975: that is the real best bid, and a new YES bid stays behind it.
  const implied = [books[0], { bestBid: 0.499, bestAsk: 0.5025, bestBidSz: 1000, bestAskSz: 1000 }]
  for (const b of planMarket(base({ books: implied, restingOwn })).desired.filter((d) => d.b && d.legIdx === 0))
    assert.ok(b.px < 0.4975, String(b.px))
  // diffOrders replaces a bid of ours that is at the best price, alone or joined, young or old.
  const desired = [{ legIdx: 0, b: true, px: 0.498, sz: 301, tif: 'Alo', role: 'bid' }]
  for (const placedAt of [now - 1, now - 600e3])
    assert.deepEqual(diffOrders([{ ...restingOwn[0], placedAt }], desired, opts({ legs: effectiveTops(books) })).cancels, [1])
  // Someone else bids above us: we are behind, the bid stays.
  const above = [{ bestBid: 0.499, bestAsk: 0.501, bestBidSz: 50 }, tight()[1]]
  assert.deepEqual(diffOrders([restingOwn[0]], desired, opts({ legs: effectiveTops(above) })).keeps, [1])
  // A deeper level is known from the full book: the bid goes behind the real best bid.
  const levels = [
    { bids: [{ px: 0.498, sz: 301 }, { px: 0.497, sz: 500 }], asks: [{ px: 0.501, sz: 500 }] },
    { bids: [{ px: 0.499, sz: 1000 }], asks: [{ px: 0.5035, sz: 500 }] },
  ]
  const deep = planMarket(base({ books, levels, restingOwn }))
  for (const b of deep.desired.filter((d) => d.b && d.legIdx === 0)) assert.ok(b.px < 0.497, String(b.px))
  assert.ok(deep.desired.some((d) => d.b && d.legIdx === 0))
})

test('nothing is placed at or after start minus 60 s, exits included', () => {
  for (const start of [now + 60000, now + 30000, now, now - 1, NaN]) {
    const plan = planMarket(base({ market: { id: 701, start }, position0: held, available: [100, 0] }))
    assert.deepEqual(plan.desired, [])
    assert.equal(plan.status, 'stopped')
    assert.equal(plan.phase, 'started')
  }
  // A caller that says open cannot reopen a started market.
  assert.deepEqual(planMarket(base({ market: { id: 701, start: now + 30e3 }, phase: 'open', position0: held, available: [100, 0] })).desired, [])
})

test('a held leg is never re-bid, the other leg still is', () => {
  const plan = planMarket(base({ position0: held, available: [100, 0] }))
  assert.equal(plan.desired.filter((d) => d.b && d.legIdx === 0).length, 0)
  assert.equal(plan.desired.filter((d) => d.b && d.legIdx === 1).length, 1)
  assert.equal(plan.desired.filter((d) => !d.b && d.legIdx === 0).length, 1)
})

test('the exit ask is bounded by the floor, the book and the shares held and available', () => {
  for (const available of [[100, 0], [60, 0], [250, 0]]) {
    const plan = planMarket(base({ position0: held, available }))
    const exit = plan.desired.find((d) => d.role === 'exit')
    assert.ok(exit)
    assert.equal(exit.tif, 'Alo')
    assert.ok(exit.px >= exit.floor)
    assert.ok(exit.px >= breakevenPx(held, feeRates.sellMaker))
    assert.ok(exit.px > 0.499 && exit.px <= 1 - 1e-5)
    assert.equal(exit.sz, Math.min(100, available[0]))
  }
  assert.equal(planMarket(base({ position0: held, available: [0, 0] })).desired.filter((d) => !d.b).length, 0)
  const small = planMarket(base({ position0: { shares: 5, cost: 2.5 }, available: [5, 0] }))
  assert.equal(small.desired.filter((d) => !d.b).length, 0)
})

test('at the loss stop bids go and the exit floor is the breakeven after the taker fee', () => {
  const late = now + 5 * 3600e3 - 25 * 60e3
  const plan = planMarket(base({ now: late, position0: held, available: [100, 0], lossBreached: true, lossBudgetLeftUsd: 0 }))
  assert.equal(plan.desired.filter((d) => d.b).length, 0)
  const exit = plan.desired.find((d) => !d.b)
  assert.equal(exit.floor, ceilTick(held.cost / held.shares / (1 - feeRates.sellTaker)))
  assert.ok(exit.px >= exit.floor)
  assert.ok(exit.px * (1 - feeRates.sellTaker) * held.shares >= held.cost - 1e-9)
})

test('outside quoting hours exits are kept and bids are not', () => {
  const plan = planMarket(base({ position0: held, available: [100, 0], hoursOpen: false }))
  assert.equal(plan.desired.filter((d) => d.b).length, 0)
  assert.equal(plan.desired.filter((d) => !d.b).length, 1)
  assert.equal(plan.status, 'exit only')
})

test('the user bid stop shuts bids, never later than the entry close', () => {
  const s = policy.settingsFor({ budgetUsd: 2000, perSideUsd: 150, markets: 2, bidStopHours: { other: 6 } })
  assert.equal(planMarket(base({ settings: s })).desired.filter((d) => d.b).length, 0)
  const early = policy.settingsFor({ budgetUsd: 2000, perSideUsd: 150, markets: 2, bidStopHours: { other: 0.01 } })
  const at25 = { market: { id: 701, start: now + 25 * min, family: 'other' } }
  assert.equal(planMarket(base({ settings: early, ...at25 })).desired.filter((d) => d.b).length, 2)
  const at19 = { market: { id: 701, start: now + 19 * min, family: 'other' } }
  assert.equal(planMarket(base({ settings: early, ...at19 })).desired.filter((d) => d.b).length, 0)
})

test('no bids in the closed phase; resting exits slide from breakeven toward the floor until forceAt', () => {
  for (const [family, left] of [['nfl', 19 * min], ['soccer', 59 * min], ['esports', 16 * min]]) {
    const plan = planMarket(base({ market: { id: 701, start: now + left, family }, position0: held, available: [100, 0] }))
    assert.equal(plan.phase, 'closed')
    assert.equal(plan.desired.filter((d) => d.b).length, 0, family)
    const exit = plan.desired.find((d) => !d.b)
    assert.equal(exit.tif, 'Alo')
    assert.equal(exit.role, 'exit')
  }
  // No IOC before the force stage, at any time.
  for (let left = 5 * 3600e3; left > 6 * min; left -= 7 * min) {
    const plan = planMarket(base({ market: { id: 701, start: now + left, family: 'nba' }, position0: held, available: [100, 0] }))
    assert.equal(plan.desired.filter((d) => d.tif === 'Ioc').length, 0)
  }
  const atForce = planMarket(base({ market: { id: 701, start: now + 6 * min + 1, family: 'nba' }, position0: held, available: [100, 0] }))
  const floor = atForce.desired.find((d) => !d.b).floor
  assert.equal(atForce.desired.find((d) => !d.b).px, Math.max(floor, 0.49901))
})

// Held YES shares at 0.50 a share; a trusted book around 0.50 before the force stage.
const forceCase = (phase, over = {}) => {
  const start = now + (phase === 'force' ? 5 : 1.5) * min
  const forceAt = start - 6 * min
  let samples = []
  for (let at = forceAt - 20 * min; at <= forceAt; at += 30e3)
    samples = recordSample(samples, { top: { bestBid: 0.499, bestAsk: 0.501 }, now: at, policy })
  return base({
    market: { id: 701, start, family: 'nfl' },
    position0: { shares: 100, cost: 50 },
    available: [100, 0],
    samples: [samples, []],
    ...over,
  })
}
const blocks = ['kill', 'loss-day', 'loss-hour', 'actions', 'backoff', 'session-end', 'hours', 'rollover-ended']

test('in force and sweep every bid block still yields the forced order, and no bids', () => {
  for (const phase of ['force', 'sweep']) {
    for (const code of [null, ...blocks]) {
      const plan = planMarket(forceCase(phase, { bidBlock: code ? { code, message: `Blocked: ${code}.` } : null }))
      assert.equal(plan.phase, phase)
      const forced = plan.desired.filter((d) => d.tif === 'Ioc')
      assert.equal(forced.length, 1, `${phase} ${code}`)
      assert.equal(forced[0].role, phase)
      assert.equal(forced[0].legIdx, 0)
      assert.ok(forced[0].px >= forced[0].floor)
      assert.ok(forced[0].sz <= 100)
      assert.equal(plan.desired.filter((d) => d.b).length, 0)
      assert.deepEqual(plan.holds, [])
    }
    // The old booleans fold into the bid block and change nothing here either.
    for (const over of [{ lossBreached: true }, { hoursOpen: false }, { exitOnly: true }])
      assert.equal(planMarket(forceCase(phase, over)).desired.filter((d) => d.tif === 'Ioc').length, 1)
  }
  const sweep = planMarket(forceCase('sweep')).desired.find((d) => d.tif === 'Ioc')
  assert.equal(sweep.px, sweep.floor)
})

test('a collapsed book in the force stage holds with a plain message and sends no forced order', () => {
  const books = [{ bestBid: 0.01, bestAsk: 0.03, bestBidSz: 1e6 }, { bestBid: 0.97, bestAsk: 0.99, bestBidSz: 10 }]
  for (const phase of ['force', 'sweep']) {
    const plan = planMarket(forceCase(phase, { books, mid: yesMid(books) }))
    assert.equal(plan.desired.filter((d) => d.tif === 'Ioc').length, 0)
    assert.equal(plan.holds.length, 1)
    assert.equal(plan.holds[0].legIdx, 0)
    assert.match(plan.holds[0].message, /Sell by hand before the start\.$/)
    assert.equal(plan.status, 'hold')
    // A resting exit ask may stay, always above the bid and the cost floor.
    for (const d of plan.desired) {
      assert.equal(d.tif, 'Alo')
      assert.ok(d.px >= d.floor && d.px > 0.01)
    }
  }
})

test('the forced sell is planned again on every pass, not one shot', () => {
  const first = planMarket(forceCase('force'))
  const second = planMarket({ ...forceCase('force'), state: first.state, now: now + 10e3 })
  assert.equal(second.desired.filter((d) => d.tif === 'Ioc').length, 1)
})

test('a pull or a fill stops bids until the market is calm, on the user calm time', () => {
  const filled = planMarket(base({ filled: true }))
  assert.equal(filled.desired.filter((d) => d.b).length, 0)
  assert.equal(filled.status, 'pulled')
  const soon = planMarket(base({ now: now + 30e3, state: filled.state }))
  assert.equal(soon.desired.filter((d) => d.b).length, 0)
  const calm = planMarket(base({ now: now + settings.calmMs, state: filled.state }))
  assert.equal(calm.desired.filter((d) => d.b).length, 2)
  const patient = policy.settingsFor({ budgetUsd: 2000, perSideUsd: 150, markets: 2, calmSeconds: 300 })
  const still = planMarket(base({ settings: patient, now: now + 120e3, state: filled.state }))
  assert.equal(still.desired.filter((d) => d.b).length, 0)
})

const bidAt = (px, placedAt, oid = 1, sz = 301) => ({ oid, legIdx: 0, b: true, px, sz, placedAt })
const opts = (over = {}) => ({ now, policy, mid: 0.5, width: testnetWidth, legs: tight(), ...over })

test('hysteresis keeps an in-slot bid', () => {
  const desired = planMarket(base()).desired
  const sz = desired[0].sz
  const { cancels, places, keeps } = diffOrders([bidAt(0.4975, now - 600e3, 1, sz)], desired, opts())
  assert.deepEqual(cancels, [])
  assert.deepEqual(keeps, [1])
  assert.equal(places.length, 1)
  assert.equal(places[0].legIdx, 1)
})

test('with the user depth given, a bid drifted far from it is replaced', () => {
  const desired = planMarket(base()).desired
  const sz = desired[0].sz
  // Slot about 0.55: inside the allowed range, but far from a depth of 0.3.
  const drifted = bidAt(0.49445, now - 600e3, 1, sz)
  assert.deepEqual(diffOrders([drifted], desired, opts()).keeps, [1])
  assert.deepEqual(diffOrders([drifted], desired, opts({ fraction: 0.3 })).cancels, [1])
})

test('an out-of-slot bid is replaced, but not within the requote time unless there is a pull or fill', () => {
  const desired = planMarket(base()).desired
  const sz = desired[0].sz
  const old = diffOrders([bidAt(0.4935, now - 600e3, 1, sz)], desired, opts())
  assert.deepEqual(old.cancels, [1])
  assert.equal(old.places.length, 2)
  const young = diffOrders([bidAt(0.4935, now - 10e3, 1, sz)], desired, opts())
  assert.deepEqual(young.cancels, [])
  const forced = diffOrders([bidAt(0.4935, now - 10e3, 1, sz)], desired, opts({ force: true }))
  assert.deepEqual(forced.cancels, [1])
  // The user's own requote patience holds an order longer, and never shorter than the policy floor.
  assert.deepEqual(diffOrders([bidAt(0.4935, now - 100e3, 1, sz)], desired, opts()).cancels, [1])
  assert.deepEqual(diffOrders([bidAt(0.4935, now - 100e3, 1, sz)], desired, opts({ minRequoteMs: 300e3 })).cancels, [])
  assert.deepEqual(diffOrders([bidAt(0.4935, now - 30e3, 1, sz)], desired, opts({ minRequoteMs: 1 })).cancels, [])
  assert.deepEqual(diffOrders([bidAt(0.497, now - 1, 1, sz)], [], opts()).cancels, [1])
})

test('an exit is never kept larger than what may be sold', () => {
  const exit = { legIdx: 0, b: false, px: 0.51, sz: 50, tif: 'Alo', role: 'exit', floor: 0.45 }
  const resting = { oid: 9, legIdx: 0, b: false, px: 0.51, sz: 80, placedAt: now - 1 }
  assert.deepEqual(diffOrders([resting], [exit], opts()).cancels, [9])
  assert.deepEqual(diffOrders([{ ...resting, sz: 50 }], [exit], opts()).keeps, [9])
  assert.deepEqual(diffOrders([{ ...resting, sz: 50, px: 0.52, placedAt: now - 120e3 }], [exit], opts()).cancels, [9])
  // A forced IOC never keeps a resting exit on its leg.
  const ioc = { ...exit, tif: 'Ioc', role: 'force' }
  assert.deepEqual(diffOrders([{ ...resting, sz: 50 }], [ioc], opts()).cancels, [9])
})

test('bookTop refuses stale, future and foreign books, and takes Infinity for a live feed', () => {
  const book = { coin: '#7010', time: now, levels: [[{ px: '0.49', sz: '10' }], [{ px: '0.51', sz: '5' }]] }
  assert.deepEqual(bookTop(book, '#7010', now), { bestBid: 0.49, bestAsk: 0.51, bestBidSz: 10, bestAskSz: 5, time: now })
  assert.throws(() => bookTop(book, '#7011', now))
  assert.throws(() => bookTop({ ...book, time: now - 7000 }, '#7010', now))
  assert.throws(() => bookTop({ ...book, time: now + 2000 }, '#7010', now))
  assert.ok(Number.isNaN(bookTop({ ...book, levels: [[], []] }, '#7010', now).bestBid))
  assert.equal(bookTop({ ...book, time: now - 3600e3 }, '#7010', now, Infinity).bestBid, 0.49)
  assert.throws(() => bookTop({ ...book, time: now + 2000 }, '#7010', now, Infinity))
  assert.deepEqual(bookLevels(book, '#7010', now), { bids: [{ px: 0.49, sz: 10 }], asks: [{ px: 0.51, sz: 5 }] })
})

test('the effective book of each leg includes the levels the other leg implies', () => {
  const books = [
    { bestBid: 0.4, bestAsk: 0.6, bestBidSz: 10, bestAskSz: 20 },
    { bestBid: 0.45, bestAsk: 0.47, bestBidSz: 30, bestAskSz: 40 },
  ]
  const [yes, no] = effectiveTops(books)
  assert.equal(yes.bestBid, 0.53)
  assert.equal(yes.bestBidSz, 40)
  assert.equal(yes.bestAsk, 0.55)
  assert.equal(yes.bestAskSz, 30)
  assert.equal(no.bestBid, 0.45)
  assert.equal(no.bestAsk, 0.47)
  assert.equal(yesMid(books), 0.54)
  const [one] = effectiveTops([{ bestBid: NaN, bestAsk: 0.6 }, { bestBid: NaN, bestAsk: NaN }])
  assert.ok(Number.isNaN(one.bestBid))
  const [tie] = effectiveTops([
    { bestBid: 0.499, bestAsk: 0.501, bestBidSz: 5, bestAskSz: 5 },
    { bestBid: 0.499, bestAsk: 0.501, bestBidSz: 7, bestAskSz: 7 },
  ])
  assert.equal(tie.bestBid, 0.499)
  assert.equal(tie.bestBidSz, 12)
  // The same for full books, level by level.
  const [yesL] = effectiveLevels([
    { bids: [{ px: 0.4, sz: 10 }], asks: [{ px: 0.6, sz: 20 }] },
    { bids: [{ px: 0.45, sz: 30 }], asks: [{ px: 0.47, sz: 40 }, { px: 0.6, sz: 5 }] },
  ])
  assert.deepEqual(yesL.bids, [{ px: 0.53, sz: 40 }, { px: 0.4, sz: 15 }])
  assert.deepEqual(yesL.asks, [{ px: 0.55, sz: 30 }, { px: 0.6, sz: 20 }])
})

test('bids and exits are priced against the effective book, not the leg alone', () => {
  const books = [
    { bestBid: 0.4, bestAsk: 0.6, bestBidSz: 1000, bestAskSz: 1000 },
    { bestBid: 0.45, bestAsk: 0.47, bestBidSz: 1000, bestAskSz: 1000 },
  ]
  const mid = yesMid(books)
  const plan = planMarket(base({ books, mid }))
  const yesBid = plan.desired.find((d) => d.b && d.legIdx === 0)
  if (yesBid) assert.ok(yesBid.px < 0.53, 'a YES bid stays behind the implied YES bid')
  const exit = planMarket(base({ books, mid, position0: { shares: 100, cost: 40 }, available: [100, 0] })).desired.find(
    (d) => d.role === 'exit'
  )
  assert.ok(exit.px > 0.53)
})

test('with both legs held the two exits always sum to more than 1, so they cannot match each other', () => {
  const pair = { position0: { shares: 300, cost: 300 * 0.497 * 1.00065 }, position1: { shares: 300, cost: 300 * 0.497 * 1.00065 } }
  for (const books of [tight(), [{ bestBid: 0.45, bestAsk: 0.55 }, { bestBid: 0.45, bestAsk: 0.55 }]]) {
    const plan = planMarket(base({ books, mid: yesMid(books), ...pair, available: [300, 300] }))
    const exits = plan.desired.filter((d) => d.role === 'exit')
    assert.equal(exits.length, 2)
    assert.ok(Math.round((exits[0].px + exits[1].px) * 1e5) > 1e5, `${exits[0].px} + ${exits[1].px}`)
    for (const e of exits) {
      assert.ok(e.px >= e.floor)
      assert.ok(e.px >= breakevenPx(pair.position0, feeRates.sellMaker))
    }
    const eff = effectiveTops(books)
    for (const e of exits) assert.ok(e.px > eff[e.legIdx].bestBid)
  }
  const apart = planMarket(
    base({ position0: { shares: 100, cost: 60 }, position1: { shares: 100, cost: 45 }, available: [100, 100] })
  ).desired.filter((d) => d.role === 'exit')
  assert.equal(apart.length, 2)
  assert.ok(apart[0].px + apart[1].px > 1)
})

test('a forced sell on one leg and a resting exit on the other never sum to 1 or less', () => {
  // YES has a trusted book and a forced sell; NO is held with its exit ask resting on a collapsed reference.
  const plan = planMarket(forceCase('force', { position1: { shares: 100, cost: 50 }, available: [100, 100] }))
  const ioc = plan.desired.find((d) => d.tif === 'Ioc')
  const rest = plan.desired.filter((d) => d.tif === 'Alo')
  assert.ok(ioc)
  for (const r of rest) assert.ok(Math.round((ioc.px + r.px) * 1e5) > 1e5)
})

test('a YES bid and a NO bid never sum to 1 or more', () => {
  for (const mid of [0.2, 0.35, 0.5, 0.65, 0.8]) {
    const books = [
      { bestBid: mid - 0.001, bestAsk: mid + 0.001, bestBidSz: 1000 },
      { bestBid: 1 - mid - 0.001, bestAsk: 1 - mid + 0.001, bestBidSz: 1000 },
    ]
    const bids = planMarket(base({ books, mid })).desired.filter((d) => d.b)
    if (bids.length === 2) assert.ok(bids[0].px + bids[1].px < 1)
  }
})
