import test from 'node:test'
import assert from 'node:assert/strict'
import {
  bandSnapshot,
  expandMarketRows,
  futuresModes,
  futuresName,
  isRollingShortMarket,
  mainnetCatalog,
  mainnetCatalogReport,
  poolOf,
  pregameCampaigns,
  rewardCampaigns,
} from './campaign-bands.mjs'

const now = Date.UTC(2026, 10, 18, 15, 47)
const iso = (offset) => new Date(now + offset).toISOString()
const row = {
  market_id: 'O4',
  hyperliquid_outcome_id: 4,
  incentive_status: 'incentivized',
  incentive_start_time: iso(-600000),
  incentive_end_time: iso(3600000),
  current_multiplier: '1',
  scoring_params: {
    event_time_multiplier_mode: 'scheduled_match',
    scheduled_event_start: iso(900000),
    distance_model: 'logit',
    baseline_total_spread_cents: '4',
    settlement_band_multiplier: '1',
    settlement_band_maximum_multiplier: '2',
    midpoint_min: '0.02',
    midpoint_max: '0.98',
  },
}
const book = (bid, ask) => ({ coin: '#40', time: now, levels: [[{ px: bid }], [{ px: ask }]] })

test('inspect only unique, active, exact-outcome campaigns in the current scoring bucket', () => {
  const select = (markets) => pregameCampaigns({ as_of: iso(-5000), markets }, now)
  assert.deepEqual(select([row]), [row])
  assert.deepEqual(select([row, row]), [])
  for (const change of [
    { market_id: 'Q4' },
    { incentive_end_time: iso(-1) },
    { incentive_status: 'closed' },
    { scoring_params: { ...row.scoring_params, scheduled_event_start: iso(-10) } },
  ]) {
    assert.deepEqual(select([{ ...row, ...change }]), [])
  }
  // Crossing a 5-minute clock boundary stays valid within the 15-minute rolling window.
  const crossBoundaryNow = Date.UTC(2026, 10, 18, 15, 50, 10)
  const crossBoundaryAsOf = new Date(Date.UTC(2026, 10, 18, 15, 49, 50)).toISOString()
  assert.deepEqual(pregameCampaigns({ as_of: crossBoundaryAsOf, markets: [row] }, crossBoundaryNow), [row])
  assert.deepEqual(pregameCampaigns({ as_of: iso(-14 * 60000), markets: [row] }, now), [row])
  // Beyond 15 minutes stale or >30s in the future still throws.
  assert.throws(() => pregameCampaigns({ as_of: iso(-16 * 60000), markets: [row] }, now))
  assert.throws(() => pregameCampaigns({ as_of: iso(35000), markets: [row] }, now))
})
test('band uses the published logit distance and excludes the exact boundary and stale books', () => {
  const run = (b) => bandSnapshot(row, b, iso(0), now)
  const center = run(book('0.48', '0.52'))
  assert.ok(Math.abs(center.low - 0.48) < 1e-10 && Math.abs(center.high - 0.52) < 1e-10)
  assert.equal(center.bidInside, false)
  assert.equal(center.askInside, false)
  assert.ok(run(book('0.49', '0.51')).bidInside)
  const edge = run(book('0.949', '0.951'))
  assert.ok(edge.high - edge.low < 0.01)
  for (const b of [
    { ...book(0.49, 0.51), coin: '#41' },
    { ...book(0.49, 0.51), time: now - 7000 },
    book(0.99, 0.999),
  ]) {
    assert.throws(() => run(b))
  }
})

test('a campaign whose window is published on its reward epochs is found, and only inside an open epoch', () => {
  const select = (markets) => pregameCampaigns({ as_of: iso(-5000), markets }, now)
  const { incentive_start_time, incentive_end_time, ...bare } = row
  const epoch = (start, end, status = 'incentivized') => ({
    incentive_start_time: iso(start),
    incentive_end_time: iso(end),
    incentive_status: status,
  })
  const open = { ...bare, epochs: [epoch(-90000000, -3600000), epoch(-3600000, 3600000)] }
  assert.ok(incentive_start_time && incentive_end_time)
  assert.deepEqual(select([open]), [open])
  assert.deepEqual(select([{ ...bare, epochs: [epoch(-90000000, -3600000)] }]), [])
  assert.deepEqual(select([{ ...bare, epochs: [epoch(-3600000, 3600000, 'ended')] }]), [])
  assert.deepEqual(select([{ ...bare, epochs: [] }]), [])
  assert.deepEqual(select([bare]), [])
})

const futures = {
  ...row,
  market_id: 'O9',
  hyperliquid_outcome_id: 9,
  market_name: 'BTC touches 90000 by 2026-12-01 00:00 UTC',
  reward_amount_usdc: '50.000000',
  live_event_multiplier: null,
  scoring_params: {
    ...row.scoring_params,
    event_time_multiplier_mode: 'none',
    scheduled_event_start: null,
    component_weights: { quote: '40', maker_fill: '50', taker_fill: '10' },
  },
}
const reward = (markets) => rewardCampaigns({ as_of: iso(-5000), markets }, now)

// Futures are off until the feed has a dedicated marker, so these tests switch the mode on for their own duration.
const withFutures = (fn) => {
  futuresModes.add('none')
  try {
    return fn()
  } finally {
    futuresModes.delete('none')
  }
}

test('futures are off by default: no mode is allowlisted and a price-style row is not a campaign', () => {
  assert.equal(futuresModes.size, 0)
  assert.deepEqual(reward([row, futures]), [row])
})

test('with a futures mode allowlisted, sports rows that share the mode are still refused', () => {
  const named = (market_name) => ({ ...futures, market_name })
  withFutures(() => {
    for (const name of [
      'LAL-BOS total above 220.5 at 2026-11-21',
      'Mahomes above 2.5 TDs at 2026-11-23 18:00',
      'Ticket price above $500 for Super Bowl',
      'NBA: Lakers vs Celtics, match winner above 5 at 2026-11-21',
      'Chiefs @ Bills above 40 at 2026-11-23',
      'Josh Allen above 250 at 2026-11-23',
      'BTC above 90000 and below 91000 at 2026-12-01',
    ]) {
      assert.equal(futuresName(name), false, name)
      assert.deepEqual(reward([named(name)]), [], name)
    }
    for (const name of [
      'BTC touches 90000 by 2026-12-01 00:00 UTC',
      'xyz:NVDA above 146.02 at 2026-11-20 21:00 UTC?',
      'ETH market cap above $500B by 2026-12-31',
    ])
      assert.equal(futuresName(name), true, name)
    assert.equal(futuresName(undefined), false)
  })
})

test('futures are accepted only with a known mode, a price-style name and no game clock', () => withFutures(() => {
  assert.ok(futuresModes.has('none'))
  assert.deepEqual(reward([row, futures]), [row, futures])
  assert.deepEqual(pregameCampaigns({ as_of: iso(-5000), markets: [futures] }, now), [])
  const mode = (event_time_multiplier_mode) => ({
    ...futures,
    scoring_params: { ...futures.scoring_params, event_time_multiplier_mode },
  })
  for (const bad of [
    mode('live'),
    mode('mystery'),
    mode(undefined),
    { ...futures, market_name: 'NBA Regular Season: Utah Jazz v Dallas Mavericks' },
    { ...futures, live_event_multiplier: '2' },
    { ...futures, scoring_params: { ...futures.scoring_params, scheduled_event_start: iso(900000) } },
    { ...futures, incentive_end_time: iso(-1) },
    { ...futures, current_multiplier: '0' },
  ])
    assert.deepEqual(reward([bad]), [])
  assert.throws(() => rewardCampaigns({ as_of: iso(-16 * 60000), markets: [futures] }, now))
}))

test('in-game and scheduled rows that have started are not reward campaigns', () => {
  const started = { ...row, scoring_params: { ...row.scoring_params, scheduled_event_start: iso(-10) } }
  const live = { ...row, scoring_params: { ...row.scoring_params, event_time_multiplier_mode: 'in_game' } }
  assert.deepEqual(reward([started, live]), [])
})

test('poolOf is the quote share of the reward amount, and null when the field is absent', () => {
  assert.equal(poolOf(futures), 20)
  assert.equal(poolOf(row), null)
  assert.equal(poolOf({ ...futures, reward_amount_usdc: undefined }), null)
  assert.equal(poolOf({ ...futures, reward_amount_usdc: '0' }), null)
  assert.equal(poolOf({ ...futures, reward_amount_usdc: 'abc' }), null)
  assert.equal(poolOf({ ...futures, scoring_params: { ...futures.scoring_params, component_weights: {} } }), null)
  assert.equal(poolOf(null), null)
})

// The mainnet catalog: rows as the live feed publishes them (read 2026-11-21), and outcomeMeta with scheduledStart.
const metaTimeText = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13)
const sportsRow = (id, over = {}) => ({
  ...row,
  market_id: 'O' + id,
  hyperliquid_outcome_id: id,
  market_name: 'NBA Regular Season: Philadelphia 76ers v Milwaukee Bucks',
  reward_amount_usdc: '100.000000',
  live_event_multiplier: null,
  scoring_params: {
    ...row.scoring_params,
    scheduled_event_start: iso(7200000),
    component_weights: { quote: '40', maker_fill: '50', taker_fill: '10' },
    ...over,
  },
})
const metaFor = (id, startMs) => ({
  outcomes: [{ outcome: id, name: 'template:sportsContestWinner', description: `competition:NBA|scheduledStart:${metaTimeText(startMs)}|sport:Basketball` }],
  questions: [],
})
const catalog = (rows, meta = null) => mainnetCatalogReport({ feed: { as_of: iso(-5000), markets: rows }, meta, now })

test('catalog: a sports row becomes an entry with the pool, weight, width and numeric id', () => {
  const { entries, excluded } = catalog([sportsRow(4)])
  assert.deepEqual(excluded, [])
  assert.equal(entries.length, 1)
  const e = entries[0]
  assert.equal(e.id, 4)
  assert.equal(e.marketId, 'O4')
  assert.equal(e.family, 'nba')
  assert.equal(e.start, now + 7200000)
  assert.equal(e.windowEnd, now + 3600000)
  assert.equal(e.pool, 40)
  assert.equal(e.eventWeight, 1)
  assert.ok(Math.abs(e.width - Math.log(0.52 / 0.48)) < 1e-9)
  assert.deepEqual([e.midMin, e.midMax], [0.02, 0.98])
  assert.equal(e.label, 'NBA Regular Season: Philadelphia 76ers v Milwaukee Bucks')
  assert.equal(e.row.market_id, 'O4')
  assert.deepEqual(mainnetCatalog({ feed: { markets: [sportsRow(4)] }, now }).map((x) => x.id), [4])
})

test('catalog: the earlier of the feed start and the outcomeMeta start wins', () => {
  const feedEarlier = catalog([sportsRow(4)], metaFor(4, now + 10800000)).entries[0]
  assert.equal(feedEarlier.start, now + 7200000)
  const metaEarlier = catalog([sportsRow(4)], metaFor(4, now + 5400000)).entries[0]
  assert.equal(metaEarlier.start, now + 5400000)
  // The meta start can come from the question that lists the outcome.
  const viaQuestion = catalog([sportsRow(4)], {
    outcomes: [],
    questions: [{ question: 1, fallbackOutcome: 3, namedOutcomes: [4], description: `scheduledStart:${metaTimeText(now + 3600000)}` }],
  }).entries[0]
  assert.equal(viaQuestion.start, now + 3600000)
  // No meta, or meta without a start: the feed start stands. No feed start: the meta start.
  assert.equal(catalog([sportsRow(4)], { outcomes: [{ outcome: 4, description: 'x:y' }], questions: [] }).entries[0].start, now + 7200000)
  const noFeedStart = catalog([sportsRow(4, { scheduled_event_start: null })], metaFor(4, now + 5400000)).entries[0]
  assert.equal(noFeedStart.start, now + 5400000)
  // A start that has passed, in either source, is a started market.
  assert.deepEqual(catalog([sportsRow(4)], metaFor(4, now - 60000)).excluded, [{ id: 4, reason: 'started' }])
  assert.deepEqual(catalog([sportsRow(4, { scheduled_event_start: null })]).excluded, [{ id: 4, reason: 'no-start' }])
})

test('catalog: futures stay off, and a futures-style row with no usable window is not a campaign', () => {
  const priced = {
    ...futures,
    reward_amount_usdc: '100.000000',
  }
  // Off by default: the allowlist of futures modes is empty.
  assert.deepEqual(catalog([priced]).excluded, [{ id: priced.hyperliquid_outcome_id, reason: 'futures-off' }])
  futuresModes.add('futures_marker')
  try {
    const marked = (r) => ({ ...r, scoring_params: { ...r.scoring_params, event_time_multiplier_mode: 'futures_marker' } })
    const ok = catalog([marked(priced)]).entries
    assert.equal(ok.length, 1)
    assert.equal(ok[0].family, 'futures')
    assert.equal(ok[0].start, Date.parse(priced.incentive_end_time))
    const noEnd = catalog([marked({ ...priced, incentive_start_time: undefined, incentive_end_time: undefined, epochs: [] })])
    assert.deepEqual(noEnd.excluded, [{ id: priced.hyperliquid_outcome_id, reason: 'window' }])
    const noEndOpen = catalog([marked({ ...priced, incentive_end_time: 'soon' })])
    assert.equal(noEndOpen.entries.length, 0)
  } finally {
    futuresModes.delete('futures_marker')
  }
})

test('catalog: in-game, unknown mode, closed windows and bad rows are excluded with a reason', () => {
  const bad = [
    [sportsRow(10, { event_time_multiplier_mode: 'none' }), 'mode'],
    [{ ...sportsRow(11), live_event_multiplier: '1.5' }, 'in-play'],
    [{ ...sportsRow(12), incentive_status: 'closed' }, 'status'],
    [{ ...sportsRow(13), incentive_end_time: iso(-1) }, 'window'],
    [{ ...sportsRow(14), market_id: 'Q14' }, 'id'],
    [sportsRow(15, { distance_model: 'linear' }), 'model'],
    [{ ...sportsRow(16), current_multiplier: '0' }, 'multiplier'],
    [sportsRow(17, { baseline_total_spread_cents: null }), 'params'],
  ]
  const { entries, excluded } = catalog([sportsRow(4), ...bad.map(([r]) => r)])
  assert.deepEqual(entries.map((e) => e.id), [4])
  assert.deepEqual(excluded.map((e) => e.reason), bad.map(([, reason]) => reason))
  // A repeated id drops both rows.
  const dup = catalog([sportsRow(4), sportsRow(4)])
  assert.deepEqual(dup.entries, [])
  assert.deepEqual(dup.excluded.map((e) => e.reason), ['duplicate', 'duplicate'])
  // A row with no published reward amount is kept (pool null) so the rollover watcher can see it.
  const noAmount = catalog([{ ...sportsRow(4), reward_amount_usdc: null }]).entries[0]
  assert.equal(noAmount.pool, null)
  assert.throws(() => catalog(null))
  assert.throws(() => mainnetCatalog({ feed: {}, now }))
})

test('catalog & selectCampaigns: multi-outcome question rows expand with child or evenly split rewards', () => {
  const questionWithChildRewards = {
    market_id: 'Q670',
    hyperliquid_question_id: 670,
    hyperliquid_outcome_id: null,
    market_name: 'Italian Serie A Matchday 12: Atalanta v Inter Milan',
    incentive_status: 'incentivized',
    incentive_start_time: iso(-600000),
    incentive_end_time: iso(3600000),
    total_reward_amount_usdc: '40.000000',
    scoring_params: {
      ...row.scoring_params,
      scheduled_event_start: iso(7200000),
      component_weights: { quote: '40', maker_fill: '50', taker_fill: '10' },
    },
    outcomes: [
      { market_id: 'O38337', hyperliquid_outcome_id: 38337, market_name: 'Atalanta', reward_amount_usdc: '15.000000', current_multiplier: '1', live_event_multiplier: null },
      { market_id: 'O38338', hyperliquid_outcome_id: 38338, market_name: 'Draw', reward_amount_usdc: '10.000000', current_multiplier: '1', live_event_multiplier: null },
      { market_id: 'O38339', hyperliquid_outcome_id: 38339, market_name: 'Inter Milan', reward_amount_usdc: '15.000000', current_multiplier: '1', live_event_multiplier: null },
    ],
  }
  const { entries, excluded } = catalog([questionWithChildRewards])
  assert.deepEqual(excluded, [])
  assert.deepEqual(entries.map((e) => e.id), [38337, 38338, 38339])
  assert.equal(entries[0].family, 'soccer')
  assert.equal(entries[0].label, 'Italian Serie A Matchday 12: Atalanta v Inter Milan - Atalanta')
  assert.equal(entries[0].pool, 6) // 15 * 40%
  assert.equal(entries[1].pool, 4) // 10 * 40%
  assert.equal(pregameCampaigns({ as_of: iso(-5000), markets: [questionWithChildRewards] }, now).length, 3)

  // When children omit reward_amount_usdc, parent reward is split evenly across child outcomes.
  const questionEvenSplit = {
    ...questionWithChildRewards,
    total_reward_amount_usdc: undefined,
    reward_amount_usdc: '90.000000',
    outcomes: [
      { market_id: 'O40001', hyperliquid_outcome_id: 40001, market_name: 'Team A', current_multiplier: '1', live_event_multiplier: null },
      { market_id: 'O40002', hyperliquid_outcome_id: 40002, market_name: 'Draw', current_multiplier: '1', live_event_multiplier: null },
      { market_id: 'O40003', hyperliquid_outcome_id: 40003, market_name: 'Team B', current_multiplier: '1', live_event_multiplier: null },
    ],
  }
  const splitEntries = catalog([questionEvenSplit]).entries
  assert.equal(splitEntries.length, 3)
  for (const e of splitEntries) assert.equal(e.pool, 12) // (90 / 3) * 40%
  assert.equal(expandMarketRows([questionEvenSplit]).length, 3)
})

test('catalog & selectCampaigns: rolling 15m and hourly markets are excluded', () => {
  const rolling15m = {
    ...sportsRow(500),
    market_name: 'BTC 15m up or down',
  }
  const rollingHourly = {
    ...sportsRow(501),
    market_name: 'ETH hourly price target',
  }
  const intradayStamp = {
    ...futures,
    market_id: 'O502',
    hyperliquid_outcome_id: 502,
    market_name: 'ETH above 1719.6 at 2026-11-18 16:15 UTC?',
  }
  assert.equal(isRollingShortMarket(rolling15m, now), true)
  assert.equal(isRollingShortMarket(rollingHourly, now), true)
  assert.equal(isRollingShortMarket(intradayStamp, now), true)
  assert.equal(isRollingShortMarket(sportsRow(4), now), false)

  const report = catalog([sportsRow(4), rolling15m, rollingHourly, intradayStamp])
  assert.deepEqual(report.entries.map((e) => e.id), [4])
  assert.deepEqual(report.excluded, [
    { id: 500, reason: 'rolling' },
    { id: 501, reason: 'rolling' },
    { id: 502, reason: 'rolling' },
  ])
  assert.deepEqual(
    pregameCampaigns({ as_of: iso(-5000), markets: [sportsRow(4), rolling15m, rollingHourly] }, now).map((r) => r.market_id),
    ['O4']
  )
})
