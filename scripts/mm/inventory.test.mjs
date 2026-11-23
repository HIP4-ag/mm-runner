import test from 'node:test'
import assert from 'node:assert/strict'
import {
  sellMakerFeeRate,
  sellTakerFeeRate,
  emptyLedger,
  applyFill,
  fillsFromView,
  reconcile,
  breakevenPx,
  floorPx,
  exitAsk,
  feeRatesFor,
  buyExchangeFeeRate,
  markedPnl,
  isLedger,
  pruneFilled,
} from './inventory.mjs'

const T0 = Date.UTC(2026, 10, 20, 12)
const buy = (ledger, o = {}) =>
  applyFill(ledger, { cloid: 'b1', legId: '7010', side: 'B', filledTotal: 10, px: 0.45, feeRate: 0.0005, now: T0, ...o })
const sell = (ledger, o = {}) =>
  applyFill(ledger, { cloid: 's1', legId: '7010', side: 'A', filledTotal: 4, px: 0.5, feeRate: sellMakerFeeRate, now: T0, ...o })

test('applying the same fill twice changes nothing', () => {
  const once = buy(emptyLedger(T0))
  const twice = buy(once)
  assert.deepEqual(twice, once)
  assert.equal(once.positions['7010'].shares, 10)
  const sold = sell(once)
  assert.deepEqual(sell(sold), sold)
})

test('a growing total applies only the delta', () => {
  let l = buy(emptyLedger(T0), { filledTotal: 3 })
  l = buy(l, { filledTotal: 10 })
  assert.equal(l.positions['7010'].shares, 10)
  assert.equal(l.positions['7010'].cost, Math.round(10 * 0.45 * 1.0005 * 1e8) / 1e8)
  assert.throws(() => buy(l, { filledTotal: 5 }), /went down/)
})

test('buy cost includes the fee and prices are held on the tick', () => {
  const l = buy(emptyLedger(T0), { px: 0.450004, filledTotal: 2, feeRate: 0 })
  assert.equal(l.positions['7010'].cost, 0.9)
})

test('oversell throws and leaves the ledger alone', () => {
  const l = buy(emptyLedger(T0))
  assert.throws(() => sell(l, { filledTotal: 10.000001 }), /Sold more than the ledger holds/)
  assert.throws(() => sell(emptyLedger(T0)), /Sold more than the ledger holds/)
  assert.equal(l.positions['7010'].shares, 10)
  const flat = sell(l, { filledTotal: 10 })
  assert.deepEqual(flat.positions, {})
})

test('a sale realizes against average cost and a full sale clears the position', () => {
  const l = buy(emptyLedger(T0), { feeRate: 0 })
  const s = sell(l, { feeRate: 0, filledTotal: 4, px: 0.5 })
  assert.equal(s.realizedUsd, 0.2)
  assert.equal(s.positions['7010'].shares, 6)
  assert.equal(s.positions['7010'].cost, 2.7)
})

test('rejects malformed fills', () => {
  const l = emptyLedger(T0)
  assert.throws(() => buy(l, { side: 'X' }), /side/)
  assert.throws(() => buy(l, { px: 1 }), /price/)
  assert.throws(() => buy(l, { px: 0 }), /price/)
  assert.throws(() => buy(l, { filledTotal: NaN }), /total/)
  assert.throws(() => buy(l, { legId: 'abc' }), /leg/)
  assert.throws(() => buy(l, { cloid: '__proto__' }), /client order id/)
})

test('the day boundary resets realized and nothing else', () => {
  let l = buy(emptyLedger(T0), { feeRate: 0 })
  l = sell(l, { feeRate: 0 })
  assert.ok(l.realizedUsd > 0)
  const nextDay = Date.UTC(2026, 10, 21, 0, 0, 1)
  const after = buy(l, { cloid: 'b2', filledTotal: 1, now: nextDay })
  assert.equal(after.day, '2026-11-21')
  assert.equal(after.realizedUsd, 0)
  assert.equal(after.positions['7010'].shares, 7)
})

test('breakeven covers fees exactly', () => {
  for (const [shares, cost] of [
    [10, 4.50225],
    [7, 3.1],
    [333, 149.9],
    [1, 0.99999],
  ]) {
    const pos = { shares, cost }
    for (const fee of [sellMakerFeeRate, sellTakerFeeRate]) {
      const px = breakevenPx(pos, fee)
      assert.ok(px * shares * (1 - fee) >= cost - 1e-9, `${shares} ${cost} ${fee}`)
      assert.ok((px - 1e-5) * shares * (1 - fee) < cost + 1e-9)
      assert.equal(Math.round(px * 1e5) / 1e5, px)
    }
  }
  assert.throws(() => breakevenPx({ shares: 0, cost: 0 }, 0), /No shares/)
})

test('floor is the tighter of the fraction and the loss budget, and never below tick', () => {
  const pos = { shares: 100, cost: 45 }
  const taker = sellTakerFeeRate
  const f = floorPx(pos, { maxExitLossFraction: 0.1, lossBudgetLeftUsd: 100, takerFeeRate: taker })
  assert.equal(f, Math.ceil(((0.45 * 0.9) / (1 - taker)) * 1e5 - 1e-6) / 1e5)
  const tight = floorPx(pos, { maxExitLossFraction: 0.1, lossBudgetLeftUsd: 1, takerFeeRate: taker })
  assert.ok(tight > f)
  assert.ok(tight * 100 * (1 - taker) >= 44 - 1e-6)
  assert.ok(floorPx({ shares: 1, cost: 0.00001 }, { maxExitLossFraction: 0.25, lossBudgetLeftUsd: 0, takerFeeRate: taker }) >= 1e-5)
})

test('the floor equals breakeven when the loss budget is used up', () => {
  const pos = { shares: 100, cost: 45.02 }
  for (const left of [0, -5, undefined, NaN]) {
    const f = floorPx(pos, { maxExitLossFraction: 0.1, lossBudgetLeftUsd: left, takerFeeRate: sellTakerFeeRate })
    assert.equal(f, breakevenPx(pos, sellTakerFeeRate))
    assert.ok(f >= breakevenPx(pos, sellMakerFeeRate))
  }
})

const pos = { shares: 20, cost: 9.1 }
const be = breakevenPx(pos, sellMakerFeeRate)
const base = (o = {}) => ({
  pos,
  leg: { bestBid: 0.4, bestAsk: 0.5 },
  now: 0,
  flattenStartAt: 1000,
  flattenEndAt: 2000,
  floor: floorPx(pos, { maxExitLossFraction: 0.1, lossBudgetLeftUsd: 5, takerFeeRate: sellTakerFeeRate }),
  breakeven: be,
  availableShares: 20,
  ...o,
})

test('the exit ask rests at breakeven before the window and slides to the floor', () => {
  const b = base()
  assert.deepEqual(exitAsk(b), { px: be, sz: 20, tif: 'Alo' })
  const mid = exitAsk({ ...b, now: 1500 })
  assert.ok(mid.px < be && mid.px > b.floor)
  assert.equal(exitAsk({ ...b, now: 2000 }).px, b.floor)
  assert.equal(exitAsk({ ...b, now: 99999 }).px, b.floor)
})

test('the exit ask respects the floor, the tick ceiling, the best bid and the size caps', () => {
  const b = base()
  for (let now = 0; now <= 2500; now += 125) {
    for (const bestBid of [0.1, 0.3, 0.4, 0.44, 0.45, 0.5, 0.9, 0.99998, null]) {
      const r = exitAsk({ ...b, now, leg: { bestBid } })
      if (!r) continue
      assert.ok(r.px >= b.floor, 'floor')
      assert.ok(r.px <= 1 - 1e-5 + 1e-12, 'ceiling')
      assert.ok(r.px > (bestBid ?? 0), 'above the bid')
      assert.ok(r.sz >= 1 && r.sz <= pos.shares && Number.isInteger(r.sz))
      assert.equal(r.tif, 'Alo')
      assert.equal(Math.round(r.px * 1e5) / 1e5, r.px)
    }
  }
  assert.equal(exitAsk({ ...b, availableShares: 7.9 }).sz, 7)
  assert.equal(exitAsk({ ...b, availableShares: 0.9 }), null)
  assert.equal(exitAsk({ ...b, availableShares: undefined }), null)
  assert.equal(exitAsk({ ...b, pos: { shares: 0, cost: 0 } }), null)
  assert.equal(exitAsk({ ...b, leg: { bestBid: 0.99999 } }), null)
  assert.equal(exitAsk({ ...b, floor: 0.999995 }), null)
})

test('a bid above the target lifts the ask one tick over the bid but never below the floor', () => {
  const b = base({ leg: { bestBid: 0.6 } })
  assert.equal(exitAsk(b).px, 0.60001)
})

test('buys are charged the builder fee only; sells the exchange fee plus the builder fee', () => {
  assert.equal(buyExchangeFeeRate, 0)
  const rates = feeRatesFor(0.0001)
  assert.equal(rates.buy, 0.0001)
  assert.ok(Math.abs(rates.sellMaker - (sellMakerFeeRate + 0.0001)) < 1e-15)
  assert.ok(Math.abs(rates.sellTaker - (sellTakerFeeRate + 0.0001)) < 1e-15)
  assert.deepEqual(feeRatesFor(0), { buy: 0, sellMaker: sellMakerFeeRate, sellTaker: sellTakerFeeRate })
  for (const bad of [-0.0001, 0.06, NaN, undefined, '0.0001x']) assert.throws(() => feeRatesFor(bad), /fee/i, String(bad))
  // A buy at the builder rate costs less than one charged the sell fee too, so breakeven is lower.
  const ledger = emptyLedger(T0)
  const fair = applyFill(ledger, { cloid: 'b', legId: '7010', side: 'B', filledTotal: 100, px: 0.5, feeRate: rates.buy, now: T0 })
  assert.equal(fair.positions['7010'].cost, 50.005)
})

test('reconcile flags shares the ledger does not know about, and the other way round', () => {
  const l = buy(emptyLedger(T0), { filledTotal: 10 })
  assert.deepEqual(reconcile(l, [{ coin: '+7010', total: '10.0' }, { coin: 'USDC', total: '50' }]), { ok: true, mismatches: [] })
  assert.deepEqual(reconcile(emptyLedger(T0), []), { ok: true, mismatches: [] })
  const extra = reconcile(l, [{ coin: '+7010', total: '10' }, { coin: '+7011', total: '3' }])
  assert.equal(extra.ok, false)
  assert.deepEqual(extra.mismatches, [{ legId: '7011', ledger: 0, venue: 3 }])
  const less = reconcile(l, [{ coin: '+7010', total: '9.999999' }])
  assert.equal(less.ok, false)
  const gone = reconcile(l, [])
  assert.deepEqual(gone.mismatches, [{ legId: '7010', ledger: 10, venue: 0 }])
  assert.equal(reconcile(l, [{ coin: '+7010', total: 'abc' }]).ok, false)
})

test('fills come from open rows first, then from order status', () => {
  const expected = [
    { c: 'a', legId: '7010', side: 'B', px: 0.4 },
    { c: 'b', legId: '7011', side: 'B', px: 0.41 },
    { c: 'c', legId: '7010', side: 'A', px: 0.6 },
    { c: 'd', legId: '7011', side: 'A', px: 0.7 },
  ]
  const open = [{ cloid: 'a', coin: '#7010', side: 'B', origSz: '10', sz: '6' }]
  const status = {
    b: { status: 'order', order: { status: 'filled', order: { cloid: 'b', coin: '#7011', origSz: '8', sz: '0' } } },
    c: { status: 'canceled', order: { cloid: 'c', coin: '#7010', origSz: '5', sz: '5' } },
    d: { status: 'canceled', order: { cloid: 'd', coin: '#7011', origSz: '5', sz: '2' } },
  }
  assert.deepEqual(fillsFromView(expected, open, (c) => status[c]), [
    { cloid: 'a', filledTotal: 4, px: 0.4 },
    { cloid: 'b', filledTotal: 8, px: 0.41 },
    { cloid: 'c', filledTotal: 0, px: 0.6 },
    { cloid: 'd', filledTotal: 3, px: 0.7 },
  ])
})

test('fills from a view throw on unknown, missing or mismatched status', () => {
  const e = [{ c: 'a', legId: '7010', side: 'B', px: 0.4 }]
  assert.throws(() => fillsFromView(e, [], () => undefined), /Unknown order status/)
  assert.throws(() => fillsFromView(e, [], () => ({ status: 'unknownOid' })), /Unknown order status/)
  assert.throws(
    () => fillsFromView(e, [], () => ({ status: 'weird', order: { cloid: 'a', origSz: '1', sz: '1' } })),
    /Unexpected order status/
  )
  assert.throws(
    () => fillsFromView(e, [], () => ({ status: 'filled', order: { cloid: 'zz', origSz: '1', sz: '0' } })),
    /does not match/
  )
  assert.throws(
    () => fillsFromView(e, [{ cloid: 'a', coin: '#7011', side: 'B', origSz: '1', sz: '1' }], () => undefined),
    /does not match/
  )
  assert.throws(
    () => fillsFromView(e, [{ cloid: 'a', coin: '#7010', side: 'B', origSz: '1', sz: '2' }], () => undefined),
    /Inconsistent/
  )
})

test('marked pnl values positions at the best bid after the taker fee', () => {
  const l = buy(emptyLedger(T0), { feeRate: 0 })
  const m = markedPnl(l, { 7010: 0.4 }, { feeRate: 0 })
  assert.equal(m.unrealizedUsd, -0.5)
  assert.equal(m.markedLossUsd, 0.5)
  assert.equal(markedPnl(l, { 7010: null }, { feeRate: 0 }).unrealizedUsd, -4.5)
  assert.equal(markedPnl(l, { 7010: 0.9 }).markedLossUsd, 0)
})

test('isLedger accepts what the functions produce and rejects bad shapes', () => {
  assert.ok(isLedger(emptyLedger(T0)))
  assert.ok(isLedger(buy(emptyLedger(T0))))
  assert.ok(!isLedger(null))
  assert.ok(!isLedger({ ...emptyLedger(T0), day: 'today' }))
  assert.ok(!isLedger({ ...emptyLedger(T0), filled: { a: -1 } }))
  assert.ok(!isLedger({ ...emptyLedger(T0), positions: { '7010': { shares: NaN, cost: 1 } } }))
})

test('a floor under one tick, zero or negative gives no exit order', () => {
  const pos = { shares: 10, cost: 4.5 }
  const leg = { bestBid: 0.4, bestAsk: 0.42 }
  const base = { pos, leg, now: T0, flattenStartAt: T0, flattenEndAt: T0 + 1, breakeven: 0.46, availableShares: 10 }
  for (const floor of [0, -0.5, 1e-6, NaN, undefined, null]) {
    assert.equal(exitAsk({ ...base, floor }), null, `ask ${floor}`)
  }
})

test('fee rates outside 0 to 0.05 are refused everywhere a fee is read', () => {
  const pos = { shares: 10, cost: 4.5 }
  for (const rate of [2, 0.06, -0.5, NaN, null]) {
    assert.throws(() => floorPx(pos, { maxExitLossFraction: 0.1, lossBudgetLeftUsd: 5, takerFeeRate: rate }), /fee rate/, `floor ${rate}`)
    assert.throws(() => breakevenPx(pos, rate), /fee rate/, `breakeven ${rate}`)
    assert.throws(() => markedPnl(emptyLedger(T0), {}, { feeRate: rate }), /fee rate/, `marked ${rate}`)
    assert.throws(() => buy(emptyLedger(T0), { feeRate: rate }), /fee rate/, `fill ${rate}`)
  }
  assert.doesNotThrow(() => floorPx(pos, { maxExitLossFraction: 0.1, lossBudgetLeftUsd: 5, takerFeeRate: 0.05 }))
  assert.doesNotThrow(() => buy(emptyLedger(T0), { feeRate: 0 }))
  assert.throws(() => buy(emptyLedger(T0), { feeRate: 0.051 }), /fee rate/)
  // A floor under a fee of 2 can no longer be 1e-5.
  assert.ok(floorPx(pos, { maxExitLossFraction: 0.1, lossBudgetLeftUsd: 5 }) >= 1e-5)
})

test('pruneFilled drops finished client ids and leaves positions and realized alone', () => {
  let ledger = buy(emptyLedger(T0), { cloid: 'old', filledTotal: 10 })
  ledger = buy(ledger, { cloid: 'live', filledTotal: 5 })
  ledger = sell(ledger, { cloid: 'sold', filledTotal: 3 })
  assert.deepEqual(Object.keys(ledger.filled).sort(), ['live', 'old', 'sold'])
  const keepSet = pruneFilled(ledger, new Set(['live']))
  assert.deepEqual(Object.keys(keepSet.filled), ['live'])
  assert.deepEqual(keepSet.positions, ledger.positions)
  assert.equal(keepSet.realizedUsd, ledger.realizedUsd)
  assert.equal(keepSet.day, ledger.day)
  assert.ok(isLedger(keepSet))
  assert.deepEqual(Object.keys(pruneFilled(ledger, ['live', 'sold']).filled).sort(), ['live', 'sold'])
  assert.deepEqual(pruneFilled(ledger, []).filled, {})
  assert.deepEqual(pruneFilled(ledger, undefined).filled, {})
  // Returns a new ledger: the input and its positions are not shared.
  assert.notEqual(keepSet, ledger)
  assert.notEqual(keepSet.positions, ledger.positions)
  assert.ok(Object.keys(ledger.filled).length === 3)
  keepSet.positions['7010'].shares = 999
  assert.notEqual(ledger.positions['7010'].shares, 999)
  assert.throws(() => pruneFilled({ positions: 1 }, []), /Invalid ledger/)
  // A kept id still deduplicates its own replay; a pruned one that is still pending would book twice, so keep pending ids.
  assert.deepEqual(buy(keepSet, { cloid: 'live', filledTotal: 5 }).positions['7010'], keepSet.positions['7010'])
})

test('the fill map stays small when finished ids are pruned', () => {
  let ledger = emptyLedger(T0)
  for (let i = 0; i < 2000; i++) {
    ledger = buy(ledger, { cloid: `c${i}`, filledTotal: 1, legId: '7010' })
    if (i % 100 === 99) ledger = pruneFilled(ledger, [`c${i}`])
  }
  assert.ok(Object.keys(ledger.filled).length <= 100)
  assert.ok(Math.abs(ledger.positions['7010'].shares - 2000) < 1e-9)
})

test('the same client order id replayed on another leg or side is refused, not booked', () => {
  const once = buy(emptyLedger(T0), { cloid: 'x1', legId: '7010', filledTotal: 4 })
  assert.deepEqual(once.filledOn, { x1: '7010:B' })
  assert.throws(() => buy(once, { cloid: 'x1', legId: '7011', filledTotal: 4 }), /another leg/)
  assert.throws(() => buy(once, { cloid: 'x1', legId: '7011', filledTotal: 9 }), /another leg/)
  assert.throws(() => sell(once, { cloid: 'x1', legId: '7010', filledTotal: 4 }), /another leg or side/)
  // The same leg and side still dedupes and still grows.
  assert.deepEqual(buy(once, { cloid: 'x1', legId: '7010', filledTotal: 4 }), once)
  assert.equal(buy(once, { cloid: 'x1', legId: '7010', filledTotal: 6 }).positions['7010'].shares, 6)
  // A replay with the same total on the other leg is refused too, not silently ignored.
  assert.throws(() => buy(once, { cloid: 'x1', legId: '7011', filledTotal: 4 }), /another leg/)
})
