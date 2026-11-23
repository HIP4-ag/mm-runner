import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRewardProgram, normalizeSplit, marketReward, distributedFrom } from '../../lib/mm/reward-program.mjs'

const weights = { quote: '40', maker_fill: '50', taker_fill: '10' }
const sp = (spread) => ({ baseline_total_spread_cents: spread, component_weights: weights })
const feed = {
  as_of: '2026-11-21T18:00:00.000Z',
  markets: [
    {
      market_id: 'Q1', market_name: 'Grouped game', incentive_status: 'incentivized', scoring_params: sp('1.5'),
      total_reward_amount_usdc: '70.000000', reward_period_type: 'epoch',
      epochs: [{ incentive_start_time: '2026-11-20T19:45:00.000Z', incentive_end_time: '2026-11-21T19:45:00.000Z' }],
      outcomes: [{ reward_amount_usdc: '40.000000' }, { reward_amount_usdc: '30.000000' }],
    },
    {
      market_id: 'O9', market_name: 'Standalone', incentive_status: 'incentivized', scoring_params: sp('4'),
      reward_amount_usdc: '100.000000', reward_period_type: 'market',
      incentive_start_time: '2026-11-20T20:55:00.000Z', incentive_end_time: '2026-11-21T21:00:00.000Z',
    },
    { market_id: 'O10', market_name: 'Ended', incentive_status: 'incentivized', scoring_params: sp('4'), reward_amount_usdc: '50', incentive_end_time: '2026-11-21T17:00:00.000Z' },
    { market_id: null, market_name: 'Unlisted', incentive_status: 'incentivized', scoring_params: sp('2'), reward_amount_usdc: '25', incentive_end_time: '2026-11-21T20:00:00.000Z' },
    { market_id: 'O11', market_name: 'Scheduled', incentive_status: 'scheduled', scoring_params: sp('2'), reward_amount_usdc: '25' },
  ],
}

test('live rewards add grouped totals and standalone amounts, skipping ended and scheduled ones', () => {
  const p = buildRewardProgram(feed, { distributedUsd: 716761.77999 })
  assert.equal(p.liveCampaigns, 3)
  assert.equal(p.liveRewardsUsd, 195)
  assert.equal(p.distributedUsd, 716761.77999)
  assert.equal(p.asOf, Date.parse('2026-11-21T18:00:00.000Z'))
})

test('stats with no source stay null', () => {
  const p = buildRewardProgram(feed)
  assert.equal(p.monthlyRewardsUsd, null)
  assert.equal(p.activeMakers, null)
  assert.equal(p.distributedUsd, null)
})

test('campaigns are sorted by end time and carry spread and quotable flags', () => {
  const { campaigns } = buildRewardProgram(feed)
  assert.deepEqual(campaigns.map((c) => c.name), ['Grouped game', 'Unlisted', 'Standalone'])
  assert.equal(campaigns[0].endsAt, Date.parse('2026-11-21T19:45:00.000Z'))
  assert.equal(campaigns[0].spreadCents, 1.5)
  assert.equal(campaigns[0].quotable, true)
  assert.equal(campaigns[1].quotable, false)
})

test('split is read from the feed in either percent or fraction form', () => {
  assert.deepEqual(buildRewardProgram(feed).split, { quote: 40, makerFills: 50, takerFills: 10 })
  assert.deepEqual(normalizeSplit({ quote: '0.4', maker_fill: '0.5', taker_fill: '0.1' }), { quote: 40, makerFills: 50, takerFills: 10 })
  assert.equal(normalizeSplit({ quote: '40' }), null)
  assert.equal(buildRewardProgram({ as_of: feed.as_of, markets: [] }).split, null)
})

test('bad input gives null or zero, not a crash', () => {
  assert.equal(buildRewardProgram(null), null)
  assert.equal(buildRewardProgram({}), null)
  assert.equal(marketReward({}), 0)
  assert.equal(distributedFrom({}), null)
  assert.equal(distributedFrom({ total_distributed_rewards_usdc: '12.5' }), 12.5)
})
