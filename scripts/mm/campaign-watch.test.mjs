import test from 'node:test'
import assert from 'node:assert/strict'
import { campaignTransition } from './campaign-watch.mjs'

// A window that ends at 00:00 UTC while the game is a day later.
const end = Date.UTC(2026, 10, 22, 0, 0)
const start = end + 20 * 3600e3
const policy = { rollover: { holdMs: 120e3, feedStaleMs: 600e3 } }
const entry = (id, over = {}) => ({ id, start, windowEnd: end, pool: 20, row: { market_id: 'O' + id }, ...over })
const feed = (entries, asOf) => ({ entries, asOf })
const state = (map, id) => map.get(id)?.state

// Steps the watcher the way the engine does: one call per refresh, each fed the last result.
function run(steps) {
  let prev = null
  const seen = []
  for (const [at, next, events] of steps) {
    prev = campaignTransition({ prev, next, now: at, policy, events })
    seen.push(prev)
  }
  return seen
}

test('a market that is in the feed stays active, with the same since', () => {
  const t = end - 600e3
  const [a, b] = run([
    [t, feed([entry(1)], t - 5e3)],
    [t + 15e3, feed([entry(1)], t + 10e3)],
  ])
  assert.equal(state(a, 1), 'active')
  assert.equal(b.get(1).since, t)
  assert.equal(b.get(1).replan, undefined)
  assert.equal(b.get(1).row.id, 1)
})

test('a window that ends with no successor is held for 120 s and then ended', () => {
  const [before, at1, at60, at120, at121, later] = run([
    [end - 5e3, feed([entry(1)], end - 10e3)],
    [end + 1e3, feed([], end - 10e3)],
    [end + 60e3, feed([], end + 40e3)],
    [end + 120e3, feed([], end + 100e3)],
    [end + 121e3, feed([], end + 100e3)],
    [end + 136e3, feed([], end + 130e3)],
  ])
  assert.equal(state(before, 1), 'active')
  assert.equal(state(at1, 1), 'hold')
  assert.equal(at1.get(1).since, end, 'a hold runs from the moment the window ended')
  assert.equal(state(at60, 1), 'hold')
  assert.equal(state(at120, 1), 'hold')
  assert.equal(state(at121, 1), 'ended')
  assert.equal(later.has(1), false, 'an ended market is reported once, then dropped')
})

test('a successor 30 s into the hold gives active and a re-plan', () => {
  const [, held, back, after] = run([
    [end - 5e3, feed([entry(1)], end - 10e3)],
    [end + 5e3, feed([], end - 10e3)],
    [end + 30e3, feed([entry(1, { windowEnd: end + 86400e3 })], end + 20e3)],
    [end + 45e3, feed([entry(1, { windowEnd: end + 86400e3 })], end + 40e3)],
  ])
  assert.equal(state(held, 1), 'hold')
  assert.equal(state(back, 1), 'active')
  assert.equal(back.get(1).replan, true)
  assert.equal(back.get(1).since, end + 30e3)
  assert.equal(state(after, 1), 'active')
  assert.equal(after.get(1).replan, undefined, 'only the first result after a hold asks for a re-plan')
})

test('a successor with no reward amount yet is a hold, and the amount arriving makes it active again', () => {
  const [, nopool, filled] = run([
    [end - 5e3, feed([entry(1)], end - 10e3)],
    [end + 2e3, feed([entry(1, { pool: null })], end + 1e3)],
    [end + 20e3, feed([entry(1, { pool: 20 })], end + 15e3)],
  ])
  assert.equal(state(nopool, 1), 'hold')
  assert.equal(nopool.get(1).since, end + 2e3)
  assert.equal(state(filled, 1), 'active')
  assert.equal(filled.get(1).replan, true)
  // A market that never had an amount is not listed at all.
  assert.equal(run([[end, feed([entry(2, { pool: null })], end)]])[0].has(2), false)
})

test('an unreadable feed holds, and the hold still runs out after 120 s', () => {
  const [, down, mid, still, over] = run([
    [end - 30e3, feed([entry(1)], end - 35e3)],
    [end - 20e3, null],
    [end + 90e3, null],
    [end + 105e3, null],
    [end + 125e3, null],
  ])
  // The window had not ended when the feed went away, so the hold starts there.
  assert.equal(state(down, 1), 'hold')
  assert.equal(down.get(1).since, end - 20e3)
  assert.equal(state(mid, 1), 'hold', 'exactly 110 s after the feed went away')
  assert.equal(state(still, 1), 'ended', 'more than 120 s after the feed went away')
  assert.equal(over.has(1), false)
  const [, short] = run([
    [end - 30e3, feed([entry(1)], end - 35e3)],
    [end - 10e3, null],
  ])
  assert.equal(state(short, 1), 'hold')
})

test('a fill, a kill or a loss stop ends a hold at once', () => {
  const steps = (events) => [
    [end - 5e3, feed([entry(1), entry(2)], end - 10e3)],
    [end + 5e3, feed([], end - 10e3)],
    [end + 10e3, feed([], end - 10e3), events],
  ]
  const fill = run(steps({ fills: [1] }))[2]
  assert.equal(state(fill, 1), 'ended')
  assert.equal(state(fill, 2), 'hold', 'a fill on one market does not end the other hold')
  assert.equal(state(run(steps({ kill: true }))[2], 2), 'ended')
  assert.equal(state(run(steps({ lossStop: true }))[2], 1), 'ended')
  assert.equal(state(run(steps({ fills: true }))[2], 2), 'ended')
  assert.equal(state(run(steps({}))[2], 1), 'hold')
})

test('a market whose game has started is ended, never held', () => {
  const soon = entry(1, { start: end + 30e3 })
  const [, seen] = run([
    [end, feed([soon], end - 5e3)],
    [end + 31e3, feed([], end + 25e3)],
  ])
  assert.equal(state(seen, 1), 'ended')
})

test('a feed older than 10 minutes makes every market ended', () => {
  const t = end - 3600e3
  const [, stale] = run([
    [t, feed([entry(1), entry(2)], t - 5e3)],
    [t + 700e3, feed([entry(1), entry(3)], t + 50e3)],
  ])
  assert.deepEqual([...stale].map(([id, v]) => [id, v.state]).sort(), [
    [1, 'ended'],
    [2, 'ended'],
    [3, 'ended'],
  ])
})

test('the hold never exceeds 120 s whatever the policy says, and defaults apply with no policy', () => {
  const long = { rollover: { holdMs: 900e3 } }
  let prev = campaignTransition({ prev: null, next: feed([entry(1)], end - 10e3), now: end - 5e3, policy: long })
  prev = campaignTransition({ prev, next: feed([], end - 10e3), now: end + 1e3, policy: long })
  assert.equal(state(prev, 1), 'hold')
  prev = campaignTransition({ prev, next: feed([], end - 10e3), now: end + 121e3, policy: long })
  assert.equal(state(prev, 1), 'ended')
  let bare = campaignTransition({ prev: null, next: [entry(1)], now: end - 5e3 })
  bare = campaignTransition({ prev: bare, next: [], now: end + 100e3 })
  assert.equal(state(bare, 1), 'hold')
  // A shorter hold is honoured.
  const short = { rollover: { holdMs: 30e3 } }
  let s = campaignTransition({ prev: null, next: [entry(1)], now: end - 5e3, policy: short })
  s = campaignTransition({ prev: s, next: [], now: end + 31e3, policy: short })
  assert.equal(state(s, 1), 'ended')
})
