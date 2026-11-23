import test from 'node:test'
import assert from 'node:assert/strict'
import { exitGroup, exitPhase, forceAtOf, forcedSell, laterPhase, recordSample, reference } from './exit-guard.mjs'
import { loadPolicy } from './policy/index.mjs'

const policy = loadPolicy()
const min = 60e3
const start = Date.UTC(2026, 10, 22, 18)
const phaseAt = (left, family = 'nfl') => exitPhase({ start, now: start - left, family, policy })
const tidy = (px) => Math.round(px * 1e5)

test('exit groups: soccer and esports are long, everything else default', () => {
  assert.equal(exitGroup('soccer'), 'long')
  assert.equal(exitGroup('esports'), 'long')
  for (const family of ['nba', 'nfl', 'other', 'futures', undefined, '__proto__']) assert.equal(exitGroup(family), 'default')
})

test('phase boundaries for the default group: T-20 close, T-6 force, T-2 sweep, T-60 s started', () => {
  assert.equal(phaseAt(20 * min + 1), 'open')
  assert.equal(phaseAt(20 * min), 'closed')
  assert.equal(phaseAt(6 * min + 1), 'closed')
  assert.equal(phaseAt(6 * min), 'force')
  assert.equal(phaseAt(2 * min + 1), 'force')
  assert.equal(phaseAt(2 * min), 'sweep')
  assert.equal(phaseAt(60e3 + 1), 'sweep')
  assert.equal(phaseAt(60e3), 'started')
  assert.equal(phaseAt(0), 'started')
  assert.equal(phaseAt(-5 * min), 'started')
})

test('phase boundaries for soccer and esports: T-60 close, T-15 force, T-5 sweep', () => {
  for (const family of ['soccer', 'esports']) {
    assert.equal(phaseAt(60 * min + 1, family), 'open')
    assert.equal(phaseAt(60 * min, family), 'closed')
    assert.equal(phaseAt(15 * min + 1, family), 'closed')
    assert.equal(phaseAt(15 * min, family), 'force')
    assert.equal(phaseAt(5 * min + 1, family), 'force')
    assert.equal(phaseAt(5 * min, family), 'sweep')
    assert.equal(phaseAt(60e3, family), 'started')
  }
  assert.equal(phaseAt(30 * min, 'nfl'), 'open')
})

test('an unknown start or clock is started, and laterPhase picks the stricter phase', () => {
  assert.equal(exitPhase({ start: NaN, now: start, family: 'nfl', policy }), 'started')
  assert.equal(exitPhase({ start, now: undefined, family: 'nfl', policy }), 'started')
  assert.equal(laterPhase('open', 'force'), 'force')
  assert.equal(laterPhase('sweep', 'closed'), 'sweep')
  assert.equal(laterPhase('open', 'nonsense'), 'started')
  assert.equal(forceAtOf({ start, family: 'soccer', policy }), start - 15 * min)
  assert.equal(forceAtOf({ start, family: 'nba', policy }), start - 6 * min)
})

test('a policy cannot make the exit later than the hard floors', () => {
  const late = { ...policy, guards: { ...policy.guards, exit: { ...policy.guards.exit, times: { default: { closeMs: 1e3, forceMs: 1e3, sweepMs: 1e3 }, long: {} } } } }
  assert.equal(exitPhase({ start, now: start - 6 * min, family: 'nfl', policy: late }), 'force')
  assert.equal(exitPhase({ start, now: start - 15 * min, family: 'soccer', policy: late }), 'force')
})

// Samples every 10 s over a span, with a fixed book.
const series = (from, to, bid, ask, every = 10e3) => {
  let list = []
  for (let at = from; at <= to; at += every) list = recordSample(list, { top: { bestBid: bid, bestAsk: ask }, now: at, policy })
  return list
}
const forceAt = start - 6 * min

test('recordSample keeps the sample shape and prunes to sampleKeepMs', () => {
  const one = recordSample([], { top: { bestBid: 0.4, bestAsk: 0.42 }, levels: { bids: [{ px: 0.4, sz: 5 }, { px: 0.39, sz: 5 }], asks: [{ px: 0.42, sz: 1 }] }, now: 1000, policy })
  assert.deepEqual(one, [{ at: 1000, bid: 0.4, ask: 0.42, bidLevels: 2, askLevels: 1 }])
  const gone = recordSample([], { top: { bestBid: NaN, bestAsk: 0.42 }, now: 1000, policy })
  assert.deepEqual(gone[0], { at: 1000, bid: null, ask: 0.42, bidLevels: 0, askLevels: 1 })
  const keep = policy.guards.exit.sampleKeepMs
  const list = series(0, keep + 60e3, 0.4, 0.42)
  assert.ok(list[0].at >= list.at(-1).at - keep)
  assert.ok(list.length <= keep / 10e3 + 1)
  // The input is never changed, and an unknown clock adds nothing.
  const before = JSON.stringify(list)
  recordSample(list, { top: { bestBid: 0.1, bestAsk: 0.2 }, now: keep + 70e3, policy })
  assert.equal(JSON.stringify(list), before)
  assert.equal(recordSample(list, { top: { bestBid: 0.1, bestAsk: 0.2 }, now: NaN, policy }).length, list.length)
})

test('the median reference uses trusted samples before forceAt and ignores the force stage', () => {
  const before = series(forceAt - 20 * min, forceAt, 0.79, 0.81)
  // A collapse inside the force stage must not move the reference.
  const during = series(forceAt + 10e3, forceAt + 3 * min, 0.01, 0.03)
  const all = [...before, ...during]
  const ref = reference(all, { forceAt, entryPx: 0.5, policy })
  assert.equal(ref.kind, 'median')
  assert.ok(Math.abs(ref.px - 0.8) < 1e-9)
  // Wide samples do not count: with only those, the entry price is used.
  const wide = series(forceAt - 20 * min, forceAt, 0.7, 0.9)
  assert.deepEqual(reference(wide, { forceAt, entryPx: 0.5, policy }), { px: 0.5, kind: 'entry' })
  // Too few trusted samples: the entry price; no entry price either: nothing.
  assert.equal(reference(before.slice(-2), { forceAt, entryPx: 0.5, policy }).kind, 'entry')
  assert.deepEqual(reference([], { forceAt, entryPx: NaN, policy }), { px: null, kind: null })
  // Samples older than the window do not count.
  const old = series(forceAt - 60 * min, forceAt - 31 * min, 0.79, 0.81)
  assert.equal(reference(old, { forceAt, entryPx: 0.5, policy }).kind, 'entry')
})

const pos = { shares: 100, cost: 80 }
const sell = (over = {}) =>
  forcedSell({
    phase: 'force',
    pos,
    top: { bestBid: 0.8, bestAsk: 0.81, bestBidSz: 500, bestAskSz: 500 },
    samples: series(forceAt - 20 * min, forceAt, 0.79, 0.81),
    now: forceAt + 30e3,
    forceAt,
    policy,
    availableShares: 100,
    minOrderUsd: 10,
    ...over,
  })
const ends = (result) => assert.match(result.hold.message, /Sell by hand before the start\.$/)

test('a healthy book in the force stage sells at the best bid, never below the floor', () => {
  const { order, hold } = sell()
  assert.equal(hold, null)
  assert.deepEqual(order, { px: 0.8, sz: 100, tif: 'Ioc', role: 'force', floor: 0.4 })
})

test('the 1c-for-82c case: bid 0.01 against a reference of 0.80 holds, never an order', () => {
  // The real failure: a game about to start, the bids pulled, one stray bid at 1c, shares worth about 82c.
  const result = sell({ top: { bestBid: 0.01, bestAsk: 0.03, bestBidSz: 10000, bestAskSz: 100 } })
  assert.equal(result.order, null)
  assert.equal(result.hold.code, 'below-reference')
  ends(result)
  for (const phase of ['force', 'sweep']) {
    for (const ask of [0.02, 0.05, 0.11]) {
      const r = sell({ phase, top: { bestBid: 0.01, bestAsk: ask, bestBidSz: 1e6, bestAskSz: 1e6 } })
      assert.equal(r.order, null, `${phase} ask ${ask}`)
      ends(r)
    }
  }
})

test('a one-sided book and a spread of 0.11 both hold', () => {
  for (const top of [
    { bestBid: NaN, bestAsk: 0.81 },
    { bestBid: 0.8, bestAsk: NaN },
    { bestBid: 0.8, bestAsk: 0.8 },
    {},
    undefined,
  ]) {
    const r = sell({ top })
    assert.equal(r.order, null)
    assert.equal(r.hold.code, 'book')
    ends(r)
  }
  const wide = sell({ top: { bestBid: 0.7, bestAsk: 0.81, bestBidSz: 500, bestAskSz: 500 } })
  assert.equal(wide.order, null)
  assert.equal(wide.hold.code, 'book')
  ends(wide)
  // Exactly 10c is still allowed.
  assert.ok(sell({ top: { bestBid: 0.71, bestAsk: 0.81, bestBidSz: 500, bestAskSz: 500 } }).order)
})

test('no reference at all holds', () => {
  const r = sell({ samples: [], pos: { shares: 100, cost: NaN } })
  assert.equal(r.order, null)
  assert.equal(r.hold.code, 'no-reference')
  ends(r)
})

// A steady, tight, deep book for the last two minutes: what the entry-price path needs.
const steadyLevels = { bids: [{ px: 0.8, sz: 500 }], asks: [{ px: 0.81, sz: 500 }] }
const entryCase = (over = {}) => {
  const now = forceAt + 3 * min
  return sell({
    pos: { shares: 100, cost: 80 },
    samples: series(now - 2 * min, now - 5e3, 0.8, 0.81, 5e3),
    now,
    levels: steadyLevels,
    ...over,
  })
}

test('with only the entry price as reference, all four health checks must pass', () => {
  const ok = entryCase()
  assert.equal(ok.hold, null)
  assert.equal(ok.order.px, 0.8)
  const fails = {
    'spread over 3c': { top: { bestBid: 0.8, bestAsk: 0.84, bestBidSz: 500, bestAskSz: 500 }, levels: { bids: [{ px: 0.8, sz: 500 }], asks: [{ px: 0.84, sz: 500 }] } },
    'bid depth under the lot': { levels: { bids: [{ px: 0.8, sz: 50 }], asks: [{ px: 0.81, sz: 500 }] } },
    'ask depth under the lot': { levels: { bids: [{ px: 0.8, sz: 500 }], asks: [{ px: 0.81, sz: 10 }, { px: 0.9, sz: 1000 }] } },
    'no samples': { samples: [] },
    'samples too short': { samples: series(forceAt + 3 * min - 30e3, forceAt + 3 * min - 5e3, 0.8, 0.81, 5e3) },
    'a one-sided sample': {
      samples: [
        ...series(forceAt + min, forceAt + 2 * min, 0.8, 0.81, 5e3),
        { at: forceAt + 2 * min + 30e3, bid: null, ask: 0.81, bidLevels: 0, askLevels: 1 },
        ...series(forceAt + 2 * min + 35e3, forceAt + 3 * min - 5e3, 0.8, 0.81, 5e3),
      ],
    },
    'mids moving more than 2c': {
      samples: [...series(forceAt + min, forceAt + 2 * min, 0.76, 0.77, 5e3), ...series(forceAt + 2 * min + 5e3, forceAt + 3 * min - 5e3, 0.8, 0.81, 5e3)],
    },
  }
  for (const [label, over] of Object.entries(fails)) {
    const r = entryCase(over)
    assert.equal(r.order, null, label)
    assert.equal(r.hold.code, 'unhealthy', label)
    ends(r)
  }
})

test('the sweep limit equals the floor and counts all bids at or above it', () => {
  const levels = { bids: [{ px: 0.8, sz: 30 }, { px: 0.6, sz: 30 }, { px: 0.45, sz: 30 }, { px: 0.3, sz: 1000 }], asks: [{ px: 0.81, sz: 10 }] }
  const r = sell({ phase: 'sweep', levels })
  assert.equal(r.order.px, r.order.floor)
  assert.equal(r.order.px, 0.4)
  assert.equal(r.order.role, 'sweep')
  assert.equal(r.order.sz, 90)
  // The force stage only counts what rests at or above its limit, the best bid.
  assert.equal(sell({ levels }).order.sz, 30)
})

test('size never exceeds the shares held, the shares available or the bid depth; dust holds', () => {
  assert.equal(sell({ availableShares: 40.7 }).order.sz, 40)
  assert.equal(sell({ pos: { shares: 33.9, cost: 27 } }).order.sz, 33)
  assert.equal(sell({ top: { bestBid: 0.8, bestAsk: 0.81, bestBidSz: 20, bestAskSz: 1 } }).order.sz, 20)
  const dust = sell({ availableShares: 10 })
  assert.equal(dust.order, null)
  assert.equal(dust.hold.code, 'dust')
  ends(dust)
  for (const availableShares of [0, 0.5, NaN, undefined]) assert.equal(sell({ availableShares }).order, null)
  assert.equal(sell({ minOrderUsd: undefined }).order, null)
})

test('outside the force and sweep stages, or with nothing held, there is neither an order nor a hold', () => {
  for (const phase of ['open', 'closed', 'started', undefined]) assert.deepEqual(sell({ phase }), { order: null, hold: null })
  assert.deepEqual(sell({ pos: { shares: 0, cost: 0 } }), { order: null, hold: null })
  assert.deepEqual(sell({ pos: undefined }), { order: null, hold: null })
})

test('property: no order is ever above the shares held or available, or below the floor', () => {
  let seed = 12345
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
  const tick = (x) => Math.round(x * 1e5) / 1e5
  let orders = 0
  let holds = 0
  for (let i = 0; i < 4000; i++) {
    const refMid = 0.05 + rand() * 0.9
    const bid = tick(rand() < 0.15 ? 0.01 : Math.max(1e-5, refMid - rand() * 0.3))
    const ask = tick(rand() < 0.1 ? bid : Math.min(0.99999, bid + rand() * 0.15))
    const shares = rand() * 400
    const available = rand() < 0.2 ? rand() * shares : shares
    const half = rand() * 0.02
    const samples = rand() < 0.3 ? [] : series(forceAt - 20 * min, forceAt, tick(refMid - half), tick(refMid + half), 60e3)
    const levels = {
      bids: [{ px: bid, sz: rand() * 300 }, { px: tick(bid - 0.05), sz: rand() * 300 }],
      asks: [{ px: ask, sz: rand() * 300 }],
    }
    const phase = rand() < 0.5 ? 'force' : 'sweep'
    const p = { shares, cost: shares * (0.02 + rand() * 0.9) }
    const r = forcedSell({ phase, pos: p, top: { bestBid: bid, bestAsk: ask, bestBidSz: levels.bids[0].sz }, levels, samples, now: forceAt + 30e3, forceAt, policy, availableShares: available, minOrderUsd: 10 })
    assert.ok((r.order === null) !== (r.hold === null), 'exactly one of order or hold')
    if (r.hold) {
      holds++
      assert.match(r.hold.message, /Sell by hand before the start\.$/)
      continue
    }
    orders++
    const o = r.order
    const ref = reference(samples, { forceAt, entryPx: p.cost / shares, policy }).px
    assert.ok(o.sz >= 1 && Number.isInteger(o.sz))
    assert.ok(o.sz <= shares + 1e-9 && o.sz <= available + 1e-9, 'never more than held or available')
    assert.ok(tidy(o.px) >= tidy(o.floor), 'never below the floor')
    assert.ok(o.floor >= 0.5 * ref - 1e-9, 'the floor is at least half the reference')
    assert.ok(tidy(o.px) <= tidy(bid) || phase === 'sweep', 'the force limit is the best bid')
    assert.ok(ask - bid <= 0.1 + 1e-9, 'never on a wide book')
    assert.ok(o.sz * o.px >= 10)
    assert.equal(o.tif, 'Ioc')
  }
  assert.ok(orders > 200 && holds > 200, `${orders} orders, ${holds} holds`)
})
