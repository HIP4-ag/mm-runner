import test from 'node:test'
import assert from 'node:assert/strict'
import { bandFractionBids, bandWidth, ceilTick, floorTick, logistic, logit, slotFraction, testnetWidth, tick } from './band-price.mjs'

const book = (bid, ask) => [
  { bestBid: bid, bestAsk: ask },
  { bestBid: 1 - ask, bestAsk: 1 - bid },
]

test('logit and logistic invert each other, and ticks round to the grid', () => {
  assert.ok(Math.abs(logistic(logit(0.37)) - 0.37) < 1e-12)
  assert.equal(floorTick(0.123459), 0.12345)
  assert.equal(ceilTick(0.123451), 0.12346)
  assert.equal(floorTick(0.49), 0.49)
  assert.equal(ceilTick(0.49), 0.49)
})

test('the testnet width is at most one cent at a 50% mid', () => {
  assert.equal(testnetWidth, bandWidth({ spreadCents: 2 }))
  assert.ok(Math.abs(logistic(testnetWidth) - 0.51) < 1e-12)
  assert.ok(Math.abs(bandWidth({ spreadCents: 4, multiplier: 2 }) - 2 * logit(0.52)) < 1e-12)
})

test('at mid 0.5 and fraction 0.3 on testnet both legs sit near 0.497', () => {
  const result = bandFractionBids({ mid: 0.5, width: testnetWidth, fraction: 0.3, legs: book(0.499, 0.501) })
  assert.deepEqual(result.skipped, [])
  assert.ok(Math.abs(result.prices[0] - 0.497) < 1e-4)
  assert.ok(Math.abs(result.prices[1] - 0.497) < 1e-4)
  assert.ok(result.low < result.prices[0] && result.high > 1 - result.prices[1])
})

test('a target at or above the best bid moves one tick behind it, or the leg is skipped out of band', () => {
  const behind = bandFractionBids({ mid: 0.5, width: testnetWidth, fraction: 0.3, legs: book(0.495, 0.505) })
  assert.equal(behind.prices[0], 0.49499)
  assert.equal(behind.prices[1], 0.49499)

  const out = bandFractionBids({ mid: 0.5, width: testnetWidth, fraction: 0.3, legs: book(0.485, 0.515) })
  assert.deepEqual(out.prices, [null, null])
  assert.deepEqual(out.skipped.map((entry) => [entry.leg, entry.code]), [[0, 'touch'], [1, 'touch']])
})

test('a leg whose price would not rest below its ask is skipped as a cross', () => {
  const result = bandFractionBids({
    mid: 0.5,
    width: testnetWidth,
    fraction: 0.3,
    legs: [
      { bestBid: 0.499, bestAsk: 0.4965 },
      { bestBid: 0.499, bestAsk: 0.501 },
    ],
  })
  assert.equal(result.prices[0], null)
  assert.equal(result.skipped[0].code, 'cross')
  assert.ok(result.prices[1] !== null)
})

test('a fraction outside 0.15 to 0.6 throws', () => {
  for (const fraction of [0.1, 0.149, 0.61, 0, 1, NaN])
    assert.throws(() => bandFractionBids({ mid: 0.5, width: testnetWidth, fraction, legs: book(0.499, 0.501) }), /fraction/i)
  assert.doesNotThrow(() => bandFractionBids({ mid: 0.5, width: testnetWidth, fraction: 0.15, legs: book(0.499, 0.501) }))
  assert.doesNotThrow(() => bandFractionBids({ mid: 0.5, width: testnetWidth, fraction: 0.6, legs: book(0.499, 0.501) }))
})

test('no price is ever at or past the ask or at or outside the band edge', () => {
  let checked = 0
  for (let m = 0.06; m <= 0.94; m += 0.01) {
    for (const width of [testnetWidth, bandWidth({ spreadCents: 4 }), bandWidth({ spreadCents: 4, multiplier: 2 })]) {
      for (const fraction of [0.15, 0.2, 0.3, 0.4, 0.6]) {
        for (const half of [0.0005, 0.005, 0.015, 0.03]) {
          const mid = Number(m.toFixed(5))
          const legs = book(floorTick(mid - half), ceilTick(mid + half))
          const { prices, low, high } = bandFractionBids({ mid, width, fraction, legs })
          prices.forEach((price, leg) => {
            if (price === null) return
            checked++
            const yesSide = leg === 0 ? price : 1 - price
            assert.ok(yesSide > low && yesSide < high, `inside band: mid ${mid} leg ${leg} price ${price}`)
            assert.ok(price < legs[leg].bestAsk, `below ask: mid ${mid} leg ${leg} price ${price}`)
            assert.ok(Math.round(price / tick) < Math.round(legs[leg].bestBid / tick), 'strictly behind the best bid')
            assert.ok(slotFraction(price, leg, { mid, width }) >= fraction - 1e-9, 'never closer to the mid than the depth asked for')
          })
        }
      }
    }
  }
  assert.ok(checked > 1000)
})

test('slotFraction reports the logit distance as a share of the half-width', () => {
  const width = 0.08
  const mid = 0.5
  const yes = logistic(logit(mid) - 0.3 * width)
  const no = 1 - logistic(logit(mid) + 0.25 * width)
  assert.ok(Math.abs(slotFraction(yes, 0, { mid, width }) - 0.3) < 1e-9)
  assert.ok(Math.abs(slotFraction(no, 1, { mid, width }) - 0.25) < 1e-9)
})
