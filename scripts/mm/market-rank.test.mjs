import test from 'node:test'
import assert from 'node:assert/strict'
import { autoPick, candidate, familyOf, rankMarkets } from './market-rank.mjs'

const t = Date.parse('2026-11-21T12:00:00Z')
const hour = 3600e3
const all = { nba: true, nfl: true, soccer: true, esports: true, other: true }
const settings = (over = {}) => ({ markets: 3, families: all, bidStopHours: {}, ...over })
const make = (id, over = {}) => ({ id, family: 'nfl', start: t + 24 * hour, pool: 20, ...over })
const ids = (result) => result.chosen.map((c) => c.id)
const why = (result) => Object.fromEntries(result.excluded.map((e) => [e.id, e.reason]))

test('familyOf reads live question text and falls back to other', () => {
  const cases = [
    ['NBA Regular Season: Utah Jazz v Dallas Mavericks', 'nba'],
    ['NFL Regular Season: Buffalo Bills v Miami Dolphins', 'nfl'],
    ['English Premier League Matchday 11: Liverpool v Manchester United', 'soccer'],
    ['Bundesliga Matchday 10: FC Bayern Munich v FC Köln', 'soccer'],
    ['CS2: PGL Major Singapore Stage 1: Heroic v Imperial', 'esports'],
    ['BTC touches 90000 by 2026-12-01 00:00 UTC', 'futures'],
    ['xyz:NVDA above 146.02 at 2026-11-20 21:00 UTC?', 'futures'],
    ['2026/2027 NBA winner', 'futures'],
    ['NFL 2027 Champion', 'futures'],
    ['Something nobody has heard of', 'other'],
    // Sports patterns come before futures words, and a matchup is never futures.
    ['NBA: Lakers vs Celtics, match winner', 'nba'],
    ['NFL: Chiefs @ Bills, game winner', 'nfl'],
    ['Premier League Matchday 12: Arsenal v Chelsea, winner', 'soccer'],
    ['Chiefs vs Bills', 'nfl'],
    ['Lakers v Celtics', 'nba'],
    ['LAL-BOS total above 220.5 at 2026-11-21', 'other'],
    ['Mahomes above 2.5 TDs at 2026-11-23 18:00', 'other'],
  ]
  for (const [questionName, family] of cases) assert.equal(familyOf({ questionName }), family, questionName)
  assert.equal(familyOf({ description: 'NBA game', campaignName: '' }), 'nba')
  assert.equal(familyOf({}), 'other')
  assert.equal(familyOf(), 'other')
})

test('the pick is the largest quote pool first, then the soonest start, first N', () => {
  const list = [
    make('small', { pool: 10, start: t + 10 * hour }),
    make('big-late', { pool: 40, start: t + 30 * hour }),
    make('big-soon', { pool: 40, start: t + 20 * hour }),
    make('mid', { pool: 25, start: t + 5 * hour }),
    make('tail', { pool: 1, start: t + 6 * hour }),
  ]
  const result = autoPick(list, settings(), { now: t })
  assert.deepEqual(ids(result), ['big-soon', 'big-late', 'mid'])
  assert.deepEqual(why(result), { small: 'count', tail: 'count' })
  // Equal pools and starts fall back to the id, so the order never depends on input order.
  const tie = [make('b'), make('a'), make('c')]
  assert.deepEqual(ids(autoPick(tie, settings(), { now: t })), ['a', 'b', 'c'])
  assert.deepEqual(ids(autoPick([...tie].reverse(), settings(), { now: t })), ['a', 'b', 'c'])
})

test('only ticked families are taken, and futures are never taken', () => {
  const list = [make('a', { family: 'nba' }), make('b', { family: 'nfl' }), make('c', { family: 'soccer' }), make('f', { family: 'futures' })]
  const result = autoPick(list, settings({ families: { ...all, nfl: false, soccer: false } }), { now: t })
  assert.deepEqual(ids(result), ['a'])
  assert.deepEqual(why(result), { b: 'family', c: 'family', f: 'futures' })
  // A family missing from the map counts as ticked; the older familyWeight map still works.
  assert.deepEqual(ids(autoPick(list.slice(0, 2), settings({ families: {} }), { now: t })).sort(), ['a', 'b'])
  assert.deepEqual(
    ids(autoPick(list.slice(0, 2), { markets: 2, familyWeight: { nba: 0, nfl: 1, other: 1 } }, { now: t })),
    ['b']
  )
})

test('the bid stop is the user own, per family, and never earlier than the entry close', () => {
  const list = [
    make('nfl-2h', { family: 'nfl', start: t + 2 * hour }),
    make('nba-2h', { family: 'nba', start: t + 2 * hour }),
    make('soccer-2h', { family: 'soccer', start: t + 2 * hour }),
    make('nfl-5h', { family: 'nfl', start: t + 5 * hour }),
  ]
  // Default 3 hours for everyone: nothing within 3 hours of its start is taken, no family is singled out.
  assert.deepEqual(why(autoPick(list, settings({ markets: 6 }), { now: t })), {
    'nfl-2h': 'bid_stop',
    'nba-2h': 'bid_stop',
    'soccer-2h': 'bid_stop',
  })
  // A user may choose 1 hour for NBA and 72 hours for soccer.
  const own = settings({ markets: 6, bidStopHours: { nba: 1, soccer: 72, nfl: 3, other: 3, esports: 3 } })
  assert.deepEqual(ids(autoPick(list, own, { now: t })).sort(), ['nba-2h', 'nfl-5h'])
  // Under the entry close it is raised to it: soccer 30 minutes becomes 60.
  const tight = [
    make('soccer-45m', { family: 'soccer', start: t + 45 * 60e3 }),
    make('soccer-90m', { family: 'soccer', start: t + 90 * 60e3 }),
    make('nfl-25m', { family: 'nfl', start: t + 25 * 60e3 }),
    make('nfl-15m', { family: 'nfl', start: t + 15 * 60e3 }),
  ]
  const result = autoPick(tight, settings({ markets: 6, bidStopHours: { soccer: 0.5, nfl: 0.1, other: 3 } }), { now: t })
  assert.deepEqual(ids(result).sort(), ['nfl-25m', 'soccer-90m'])
  assert.deepEqual(why(result), { 'soccer-45m': 'start', 'nfl-15m': 'start' })
  // The entry close comes from policy.guards.exit.times when given.
  const policy = { guards: { exit: { times: { default: { closeMs: 30 * 60e3 }, long: { closeMs: 90 * 60e3 } } } } }
  assert.deepEqual(why(autoPick(tight, settings({ markets: 6, bidStopHours: { soccer: 0.5, nfl: 0.1, other: 3 } }), { now: t, policy })), {
    'soccer-45m': 'start',
    'soccer-90m': 'start',
    'nfl-25m': 'start',
    'nfl-15m': 'start',
  })
})

test('a market with no start, no pool or a clock that is not a number is left out with a reason', () => {
  const list = [make('ok'), make('nostart', { start: null }), make('nopool', { pool: null }), make('zero', { pool: 0 }), make('past', { start: t - 1 })]
  const result = autoPick(list, settings({ markets: 6 }), { now: t })
  assert.deepEqual(ids(result), ['ok'])
  assert.deepEqual(why(result), { nostart: 'start', nopool: 'pool', zero: 'pool', past: 'start' })
  assert.equal(autoPick(list, settings({ markets: 6 }), { now: NaN }).chosen.length, 0)
  // With no clock the time rules are the caller's.
  assert.deepEqual(ids(autoPick([make('x', { start: null })], settings(), {})), ['x'])
})

test('testnet has no pools: markets sort by start time alone', () => {
  const list = [make('late', { pool: 1, start: t + 30 * hour }), make('soon', { pool: undefined, start: t + 10 * hour }), make('mid', { pool: 99, start: t + 20 * hour })]
  assert.deepEqual(ids(autoPick(list, settings(), { now: t, network: 'testnet' })), ['soon', 'mid', 'late'])
  assert.deepEqual(ids(autoPick(list, settings(), { now: t })), ['mid', 'late'])
})

test('the count is the user setting, between 1 and 6', () => {
  const list = Array.from({ length: 9 }, (_, i) => make('m' + i, { pool: 50 - i }))
  assert.equal(autoPick(list, settings({ markets: 1 }), { now: t }).chosen.length, 1)
  assert.equal(autoPick(list, settings({ markets: 99 }), { now: t }).chosen.length, 6)
  assert.equal(autoPick(list, { families: all }, { now: t }).chosen.length, 2)
  assert.equal(autoPick(list, settings({ markets: 0 }), { now: t }).chosen.length, 1)
  assert.deepEqual(autoPick([], settings(), { now: t }), { chosen: [], excluded: [] })
})

test('the settings shape policy.settingsFor returns works: bidStopMs per family in ms, marketCount, a hand-picked list', () => {
  const real = {
    marketCount: 2,
    families: all,
    bidStopMs: { nba: 1 * hour, nfl: 3 * hour, soccer: 72 * hour, esports: 3 * hour, other: 3 * hour },
  }
  const list = [
    make('nba', { family: 'nba', start: t + 2 * hour, pool: 5 }),
    make('nfl', { family: 'nfl', start: t + 4 * hour, pool: 6 }),
    make('soccer', { family: 'soccer', start: t + 50 * hour, pool: 9 }),
    make('other', { family: 'other', start: t + 8 * hour, pool: 4 }),
  ]
  const result = autoPick(list, real, { now: t })
  assert.deepEqual(ids(result), ['nfl', 'nba'])
  assert.deepEqual(why(result), { soccer: 'bid_stop', other: 'count' })
  const manual = autoPick(list, real, { now: t, only: ['nba', 'soccer', 'ghost'] })
  assert.deepEqual(ids(manual), ['nba'])
  assert.deepEqual(why(manual), { nfl: 'not_picked', soccer: 'bid_stop', other: 'not_picked' })
})

test('candidate keeps the old call shape and needs a midpoint and a width', () => {
  const c = candidate({ id: 'x', family: 'nba', mid: 0.5, width: 0.08, pool: 5, book: {} }, { anything: true })
  assert.deepEqual(c, { id: 'x', family: 'nba', mid: 0.5, width: 0.08, pool: 5, eventWeight: 1, start: null })
  assert.throws(() => candidate({ id: 'x', mid: 0.5, width: 0 }))
  assert.throws(() => candidate({ id: 'x', width: 0.08 }))
})

test('rankMarkets keeps its old return shape and sizes each market from the user limits', () => {
  const list = ['a', 'b', 'c', 'd'].map((id, i) => make(id, { pool: 30 - i }))
  const run = (over, opts) => rankMarkets(list, { budgetUsd: 1000, perSideUsd: 100, markets: 6, families: all, ...over }, {}, { now: t, ...opts })
  const wide = run({})
  assert.deepEqual(wide.chosen, [
    { id: 'a', perSideUsd: 100 },
    { id: 'b', perSideUsd: 100 },
    { id: 'c', perSideUsd: 100 },
    { id: 'd', perSideUsd: 100 },
  ])
  assert.deepEqual(wide.excluded, [])
  // The budget left decides the size; a market that cannot get the minimum is excluded as budget.
  const tight = run({ budgetUsd: 450 }, { minOwnUsd: 25 })
  assert.deepEqual(tight.chosen.map((c) => c.perSideUsd), [100, 100, 25])
  assert.deepEqual(tight.excluded, [{ id: 'd', reason: 'budget' }])
  // A per-side limit under the minimum can never work.
  const small = run({ perSideUsd: 20 }, { minOwnUsd: 25 })
  assert.deepEqual(small.chosen, [])
  assert.ok(small.excluded.every((e) => e.reason === 'minimum') && small.excluded.length === 4)
  // The engine passes no clock, a policy and a seed: still fine.
  assert.equal(rankMarkets(list, { budgetUsd: 1000, perSideUsd: 100, markets: 2, families: all }, {}, { seed: 's', minOwnUsd: 10 }).chosen.length, 2)
  assert.equal(rankMarkets(list.slice(0, 2), { budgetUsd: 1000, perSideUsd: 100, markets: 2, families: all }, {}, {}).chosen.length, 2)
})

test('user familyWeights, rankWeights, and excludeMarkets differentiate automatic picks transparently', () => {
  const list = [
    make('nba-small-soon', { family: 'nba', pool: 20, start: t + 5 * hour, width: 0.04 }),
    make('nfl-big-late', { family: 'nfl', pool: 60, start: t + 48 * hour, width: 0.04 }),
    make('soccer-mid-wide', { family: 'soccer', pool: 30, start: t + 24 * hour, width: 0.12 }),
  ]
  // Default uniform weights sort by pool desc.
  assert.deepEqual(ids(autoPick(list, settings({ markets: 2 }), { now: t })), ['nfl-big-late', 'soccer-mid-wide'])
  // User emphasizing NBA (weight 3) and disabling soccer (weight 0) gets a completely different pick.
  const nbaFocused = autoPick(
    list,
    settings({ markets: 2, familyWeights: { nba: 3, nfl: 1, soccer: 0, esports: 1, other: 1 } }),
    { now: t }
  )
  assert.deepEqual(ids(nbaFocused), ['nba-small-soon', 'nfl-big-late'])
  assert.deepEqual(why(nbaFocused), { 'soccer-mid-wide': 'family' })
  // User weighting time-to-start (3) over pool (0) picks the soonest market first.
  const soonFocused = autoPick(
    list,
    settings({ markets: 1, rankWeights: { pool: 0, start: 3, spread: 0 } }),
    { now: t }
  )
  assert.deepEqual(ids(soonFocused), ['nba-small-soon'])
  // User weighting band width/spread (3) picks the widest band first.
  const spreadFocused = autoPick(
    list,
    settings({ markets: 1, rankWeights: { pool: 0, start: 0, spread: 3 } }),
    { now: t }
  )
  assert.deepEqual(ids(spreadFocused), ['soccer-mid-wide'])
  // Exclude list skips specific markets in auto mode.
  const skipped = autoPick(list, settings({ markets: 2, excludeMarkets: ['nfl-big-late'] }), { now: t })
  assert.deepEqual(ids(skipped), ['soccer-mid-wide', 'nba-small-soon'])
  assert.equal(why(skipped)['nfl-big-late'], 'excluded')
})

test('whole-token rounding check: $27/side min and $30/side default clear Monarch $50 combined floor across 5c-95c mids', () => {
  for (const perSideUsd of [27, 30]) {
    for (let cents = 5; cents <= 95; cents += 1) {
      const yesPx = cents / 100
      const noPx = (100 - cents) / 100
      const yesNotional = Math.floor(perSideUsd / yesPx) * yesPx
      const noNotional = Math.floor(perSideUsd / noPx) * noPx
      assert.ok(
        yesNotional + noNotional >= 50,
        `perSideUsd=${perSideUsd} at mid=${yesPx}: combined=${(yesNotional + noNotional).toFixed(2)} < $50`
      )
    }
  }
})
