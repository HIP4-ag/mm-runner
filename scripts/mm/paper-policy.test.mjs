import assert from 'node:assert/strict'
import test from 'node:test'
import { budgets, frameAt, planQuotes } from './paper-policy.mjs'

test('every available budget covers both native sides inside the YES band', () => {
  for (const budget of budgets) {
    const book = frameAt(0)
    const [yes, no] = planQuotes(book, budget, 1000, 1000)
    assert.ok(yes.price >= book.low && 100 - no.price <= book.high)
    const costs = [yes, no].map((q) => q.price * q.shares)
    assert.ok(costs.every((cost) => cost >= 1000))
    assert.ok(costs[0] + costs[1] <= budget * 100)
  }
})

test('reject unsupported budgets and withdraw both quotes on stale or ineligible books', () => {
  const book = frameAt(0)
  assert.throws(() => planQuotes(book, 26, 1, 1))
  for (const invalid of [frameAt(3), { ...book, ask: 48 }, { ...book, low: NaN }, null]) {
    assert.deepEqual(planQuotes(invalid, 25, 1, 1), [])
  }
  assert.deepEqual(planQuotes(book, 25, 1, 6002), [])
  assert.deepEqual(planQuotes(book, 25, 100, 0), [])
})
