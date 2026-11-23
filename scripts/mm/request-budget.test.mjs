import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createActionBudget,
  budgetReached,
  actionAllowance,
  fileActionStore,
  memoryActionStore,
  addressHeadroom,
  cancelBatches,
  nextBackoff,
} from './request-budget.mjs'

const t0 = Date.UTC(2026, 10, 20, 12)

test('orders and cancels cost one each, a scheduled cancel costs one', () => {
  const budget = createActionBudget({ perHour: 100, now: t0 })
  budget.spend('order', 4, t0)
  budget.spend('cancel', 3, t0 + 1000)
  const s = budget.spend('scheduleCancel', 99, t0 + 2000)
  assert.equal(s.actionsLastHour, 8)
  assert.equal(s.left, 92)
  assert.equal(budget.spend('order', 0, t0 + 3000).actionsLastHour, 8)
  assert.throws(() => budget.spend('modify', 1, t0))
  assert.throws(() => budget.spend('order', -1, t0))
  assert.throws(() => budget.spend('order', 1.5, t0))
})

test('the action over the hourly allowance throws and is not counted', () => {
  const requests = { maxOrderActionsPerHour: 240 }
  const budget = createActionBudget({ perHour: requests.maxOrderActionsPerHour, now: t0 })
  budget.spend('order', requests.maxOrderActionsPerHour - 1, t0)
  assert.throws(() => budget.spend('order', 2, t0 + 1), new RegExp(budgetReached))
  assert.equal(budget.snapshot(t0 + 1).actionsLastHour, requests.maxOrderActionsPerHour - 1)
  budget.spend('scheduleCancel', 1, t0 + 2)
  assert.throws(() => budget.spend('cancel', 1, t0 + 3), new RegExp(budgetReached))
  // An hour later the allowance is back.
  assert.equal(budget.spend('order', 2, t0 + 3600e3 + 3).actionsLastHour, 2)
})

test('the projection scales the trailing hour to a day', () => {
  const budget = createActionBudget({ perHour: 1000, now: t0 })
  budget.spend('order', 10, t0)
  // Ten minutes in: 10 actions in 10 minutes is 1,440 a day.
  assert.equal(budget.snapshot(t0 + 600e3).projectedPerDay, 1440)
  // Under a minute in, the projection uses one minute so it does not explode.
  assert.equal(budget.snapshot(t0 + 1000).projectedPerDay, 14400)
  // After two hours only the trailing hour counts.
  budget.spend('order', 5, t0 + 7000e3)
  assert.equal(budget.snapshot(t0 + 7200e3).projectedPerDay, 120)
})

test('entries cannot reach into the reserve; exits, cancels and the timer can', () => {
  const budget = createActionBudget({ perHour: 100, now: t0, reserve: 0.2 })
  assert.equal(budget.snapshot(t0).reserved, 20)
  budget.spend('order', 80, t0, { entry: true })
  assert.equal(budget.can('order', 1, t0, { entry: true }), false)
  assert.throws(() => budget.spend('order', 1, t0, { entry: true }), new RegExp(budgetReached))
  // The reserve is still there for what lowers risk.
  assert.equal(budget.can('cancel', 20, t0), true)
  budget.spend('cancel', 19, t0)
  budget.spend('scheduleCancel', 1, t0)
  assert.throws(() => budget.spend('order', 1, t0), new RegExp(budgetReached))
  assert.equal(budget.snapshot(t0).entriesLeft, 0)
  assert.throws(() => createActionBudget({ perHour: 100, reserve: 1 }))
})

test('the allowance follows the markets in play under a hard ceiling, and so does the market cap', () => {
  assert.deepEqual(actionAllowance({ ceiling: 240, perMarket: 160, markets: 0 }), { perHour: 160, maxMarkets: 1 })
  assert.deepEqual(actionAllowance({ ceiling: 240, perMarket: 160, markets: 3 }), { perHour: 240, maxMarkets: 1 })
  assert.deepEqual(actionAllowance({ ceiling: 1000, perMarket: 160, markets: 3 }), { perHour: 480, maxMarkets: 6 })
  const budget = createActionBudget({ perHour: 240, now: t0 })
  budget.spend('order', 150, t0)
  budget.setPerHour(160)
  assert.throws(() => budget.spend('order', 11, t0), new RegExp(budgetReached))
  budget.setPerHour(240)
  budget.spend('order', 11, t0)
  assert.throws(() => budget.setPerHour(0))
})

test('spends carry over a restart inside the hour and drop out after it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mm-actions-'))
  const file = join(dir, 'actions.json')
  const store = fileActionStore(file)
  assert.deepEqual(store.load(t0), [])
  const first = createActionBudget({ perHour: 100, now: t0, onSpend: (events) => store.save(events, t0) })
  first.spend('order', 60, t0)
  first.spend('cancel', 30, t0 + 600e3)
  // A new process 20 minutes later starts where the old one stopped.
  const second = createActionBudget({ perHour: 100, now: t0 + 1200e3, events: store.load(t0 + 1200e3) })
  assert.equal(second.snapshot(t0 + 1200e3).actionsLastHour, 90)
  assert.throws(() => second.spend('order', 11, t0 + 1200e3), new RegExp(budgetReached))
  // After the hour only the later spend counts.
  assert.equal(createActionBudget({ perHour: 100, now: t0 + 3700e3, events: store.load(t0 + 3700e3) }).snapshot(t0 + 3700e3).actionsLastHour, 30)
  // A time in the future (the clock went back) counts as now, never as already expired.
  const ahead = createActionBudget({ perHour: 100, now: t0, events: [{ at: t0 + 7200e3, n: 50 }] })
  assert.equal(ahead.snapshot(t0 + 3599e3).actionsLastHour, 50)
  // A file that cannot be trusted loads as null, so the caller can fail closed.
  for (const body of ['not json', '{"events":[]}', '{"savedAt":1,"events":[[1,-3]]}']) {
    writeFileSync(file, body)
    assert.equal(store.load(t0), null)
  }
  const memory = memoryActionStore()
  memory.save([{ at: t0, n: 2 }])
  assert.deepEqual(memory.load(), [{ at: t0, n: 2 }])
})

test('priority bid stops at the reserve while exits and cancels keep using it', () => {
  const budget = createActionBudget({ perHour: 100, now: t0, reserveActions: 40 })
  assert.equal(budget.snapshot(t0).reserved, 40)
  budget.spend('order', 60, t0, { priority: 'bid' })
  assert.equal(budget.can('order', 1, t0, { priority: 'bid' }), false)
  assert.throws(() => budget.spend('order', 1, t0, { priority: 'bid' }), new RegExp(budgetReached))
  // Exits (the default) and cancels still fit in the reserve.
  budget.spend('order', 10, t0, { priority: 'exit' })
  budget.spend('cancel', 30, t0)
  assert.throws(() => budget.spend('cancel', 1, t0), new RegExp(budgetReached))
  // The older entry flag means the same as priority bid.
  const old = createActionBudget({ perHour: 100, now: t0, reserve: 0.4 })
  old.spend('order', 60, t0, { entry: true })
  assert.throws(() => old.spend('order', 1, t0, { entry: true }), new RegExp(budgetReached))
  assert.throws(() => old.spend('order', 1, t0, { priority: 'urgent' }))
  // The larger of the share and the count applies, and a count over the allowance reserves all of it.
  assert.equal(createActionBudget({ perHour: 100, reserve: 0.5, reserveActions: 20 }).snapshot().reserved, 50)
  assert.equal(createActionBudget({ perHour: 30, reserveActions: 40 }).snapshot().reserved, 30)
  assert.throws(() => createActionBudget({ perHour: 100, reserveActions: -1 }))
})

test('address headroom is cap minus used, never negative, and null when the answer is unusable', () => {
  assert.deepEqual(addressHeadroom({ cumVlm: '17058.07', nRequestsUsed: 44, nRequestsCap: 27058, nRequestsSurplus: 0 }), {
    used: 44,
    cap: 27058,
    left: 27014,
  })
  assert.equal(addressHeadroom({ nRequestsUsed: 30000, nRequestsCap: 27058 }).left, 0)
  for (const bad of [null, {}, { nRequestsUsed: 'x', nRequestsCap: 5 }, { nRequestsUsed: -1, nRequestsCap: 5 }, { nRequestsUsed: 1 }])
    assert.equal(addressHeadroom(bad), null)
})

test('cancels split into batches of at most 200, in order', () => {
  const rows = Array.from({ length: 201 }, (_, i) => ({ a: 1, o: i }))
  const batches = cancelBatches(rows)
  assert.deepEqual(batches.map((b) => b.length), [200, 1])
  assert.deepEqual(batches.flat(), rows)
  assert.deepEqual(cancelBatches(Array.from({ length: 250 }, (_, i) => ({ a: 1, o: i })), 500).map((b) => b.length), [200, 50])
  assert.deepEqual(cancelBatches(rows.slice(0, 5), 2).map((b) => b.length), [2, 2, 1])
  assert.deepEqual(cancelBatches([]), [])
  assert.throws(() => cancelBatches(rows, 0))
  assert.throws(() => cancelBatches('no'))
})

test('backoff steps up, honours Retry-After and is never terminal', () => {
  const policy = { requests: { backoffMs: [7e3, 14e3, 28e3, 60e3] } }
  let state = null
  const waits = []
  for (let i = 0; i < 40; i++) {
    const next = nextBackoff(state, { now: t0 + i * 1e6, policy })
    waits.push(next.until - (t0 + i * 1e6))
    state = next.state
  }
  assert.deepEqual(waits.slice(0, 5), [7e3, 14e3, 28e3, 60e3, 60e3])
  assert.ok(waits.every((ms) => ms > 0 && ms <= 60e3))
  // A clean tick resets the ladder by passing null again.
  assert.equal(nextBackoff(null, { now: t0, policy }).until, t0 + 7e3)
  // Retry-After longer than the step wins, up to five minutes; a shorter one does not shorten the step.
  assert.equal(nextBackoff(null, { now: t0, retryAfterMs: 20e3, policy }).until, t0 + 20e3)
  assert.equal(nextBackoff(state, { now: t0, retryAfterMs: 1e3, policy }).until, t0 + 60e3)
  assert.equal(nextBackoff(null, { now: t0, retryAfterMs: 1e9, policy }).until, t0 + 300e3)
  // Without a policy the same ladder applies.
  assert.equal(nextBackoff(null, { now: t0 }).until, t0 + 7e3)
  assert.equal(nextBackoff({ step: 'x' }, { now: t0, policy: { requests: { backoffMs: [] } } }).until, t0 + 7e3)
})
