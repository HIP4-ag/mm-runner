import test from 'node:test'
import assert from 'node:assert/strict'
import { dailyRows, earningDayFor, dayOf } from './daily-pnl.mjs'
import { readOwnScores } from './rewards-read.mjs'

const at = (day, hour = 12) => Date.parse(`${day}T${String(hour).padStart(2, '0')}:00:00Z`)
const fill = (day, side, px, sz, extra = {}) => ({ time: at(day), coin: '#30', side, px, sz, fee: 0, builderFee: 0, ...extra })

test('a reward dated D is booked to the earning day D-1, including across a month end', () => {
  assert.equal(earningDayFor('2026-11-21'), '2026-11-20')
  assert.equal(earningDayFor('2026-12-01'), '2026-11-30')
  const rows = dailyRows({
    fills: [fill('2026-11-20', 'B', 0.4, 10), fill('2026-11-20', 'A', 0.5, 10)],
    rewards: [{ dated: '2026-11-21', usd: 3, status: 'estimated' }],
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].day, '2026-11-20')
  assert.equal(rows[0].rewardUsd, 3)
  assert.equal(rows[0].rewardStatus, 'estimated')
})

test('a reward already given by earning day is not shifted again', () => {
  const [row] = dailyRows({ rewards: [{ earningDay: '2026-11-20', usd: 2, status: 'paid' }] })
  assert.equal(row.day, '2026-11-20')
  assert.equal(row.rewardStatus, 'paid')
})

test('net = reward + trading result - fees, and the running total adds the days up', () => {
  const rows = dailyRows({
    fills: [
      fill('2026-11-19', 'B', 0.4, 10, { fee: 0.01, builderFee: 0.004 }),
      fill('2026-11-19', 'A', 0.45, 10, { fee: 0.02 }),
      fill('2026-11-20', 'B', 0.6, 10),
    ],
    dayMarks: { '2026-11-19': { positions: {}, marks: {} }, '2026-11-20': { positions: { '#30': 10 }, marks: { '#30': 0.5 } } },
    rewards: [
      { dated: '2026-11-20', usd: 1.5, status: 'paid' },
      { dated: '2026-11-21', usd: 0.25, status: 'estimated' },
    ],
  })
  const [a, b] = rows
  assert.equal(a.day, '2026-11-19')
  assert.equal(a.tradingUsd, 0.5) // 4.5 in, 4.0 out, flat at day end
  assert.equal(a.feesUsd, 0.034)
  assert.ok(Math.abs(a.netUsd - (1.5 + 0.5 - 0.034)) < 1e-9)
  // Day 2: bought 10 at 0.60, marked at 0.50: a loss of 1 before fees; reward 0.25 estimated.
  assert.equal(b.tradingUsd, -1)
  assert.equal(b.netUsd, -0.75)
  assert.equal(b.runningNetUsd, Math.round((a.netUsd + b.netUsd) * 1e8) / 1e8)
})

test('a mark that moves shows up as trading result even with no fills that day', () => {
  const rows = dailyRows({
    fills: [fill('2026-11-18', 'B', 0.5, 10)],
    dayMarks: {
      '2026-11-18': { positions: { '#30': 10 }, marks: { '#30': 0.5 } },
      '2026-11-19': { positions: { '#30': 10 }, marks: { '#30': 0.3 } },
    },
  })
  assert.equal(rows[0].tradingUsd, 0)
  assert.equal(rows[1].tradingUsd, -2)
})

test('settlement cash cancels the marked value that disappears', () => {
  const rows = dailyRows({
    fills: [fill('2026-11-18', 'B', 0.5, 10)],
    dayMarks: {
      '2026-11-18': { positions: { '#30': 10 }, marks: { '#30': 0.5 } },
      '2026-11-19': { positions: {}, marks: {} },
    },
    settlements: [{ time: at('2026-11-19'), usd: 10 }],
  })
  assert.equal(rows[1].tradingUsd, 5)
})

test('a day with fills but no saved marks is marked at the last fill price', () => {
  const [row] = dailyRows({ fills: [fill('2026-11-18', 'B', 0.5, 10)] })
  assert.equal(row.tradingUsd, 0)
  assert.equal(row.marked, 'fills')
})

test('a paid reward is not replaced by an estimate, and an estimate is replaced by a paid one', () => {
  const [row] = dailyRows({
    rewards: [
      { earningDay: '2026-11-20', usd: 5, status: 'estimated' },
      { earningDay: '2026-11-20', usd: 4, status: 'paid' },
      { earningDay: '2026-11-20', usd: 9, status: 'estimated' },
    ],
  })
  assert.deepEqual([row.rewardUsd, row.rewardStatus], [4, 'paid'])
})

test('a day without a reward says none, never zero', () => {
  const [row] = dailyRows({ fills: [fill('2026-11-18', 'B', 0.5, 10)] })
  assert.equal(row.rewardUsd, null)
  assert.equal(row.rewardStatus, 'none')
  assert.equal(dayOf(at('2026-11-18')), '2026-11-18')
})

test('own scores: an estimate from a share and a pool, skipping rows it cannot read, never zero when unknown', async () => {
  const wallet = '0x' + 'a'.repeat(40)
  let asked
  const fetch = async (url) => {
    asked = String(url)
    return {
      ok: true,
      json: async () => ({
        scores: [
          { market_id: 'O12', wallet_score: 1, total_score: 4, pool_usd: 100 },
          { market_id: 'O13', share: 0.1 },
          { market_id: 'O99', share: 0.5, pool_usd: 10 },
        ],
      }),
    }
  }
  const result = await readOwnScores({ marketIds: [12, 13], wallet, fetch })
  assert.match(asked, /wallet=0xaaaa/)
  assert.equal(result.status, 'estimated')
  assert.equal(result.usd, 25)
  assert.equal(result.skipped, 2)
  const none = await readOwnScores({ marketIds: [13], wallet, fetch })
  assert.equal(none.usd, null)
  await assert.rejects(() => readOwnScores({ marketIds: [1], wallet: 'nope', fetch }))
})
