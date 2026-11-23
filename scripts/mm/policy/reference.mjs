// Reference policy behind loadPolicy(). Pure data and functions. It holds two things only:
//   1. hard limits: the ranges every user setting must stay inside, and the safety rails (exit timing, the empty-book
//      sell guard, request caps). guards.mjs assertPolicyEnvelope holds these to fixed bounds, stricter only;
//   2. neutral defaults: the middle of each allowed range and a small size. No family is preferred, no market is
//      ranked by a formula and no value here is tuned from any operator's own trading. The user sets their own.

const minute = 60e3
const hour = 3600e3

const families = ['nba', 'nfl', 'soccer', 'esports', 'other']
const rankFactors = ['pool', 'start', 'spread']

const limits = {
  budgetUsd: [50, 10000],
  // Monarch requires >= $50 combined raw in-band notional per block; $27/side clears $50 after whole-token rounding across 5c-95c mids.
  perSideUsd: [27, 250],
  maxHeldPerLegUsd: [10, 250],
  markets: [1, 6],
  depthPct: [15, 60],
  bidStopHoursMax: 168,
  requoteSeconds: [60, 3600],
  lossStopMinUsd: 1,
  dailyLossShareMax: 0.25,
  pullMovePct: [25, 100],
  calmSeconds: [60, 3600],
  manualMarketsMax: 6,
  excludeMarketsMax: 20,
  familyWeight: [0, 3],
  rankWeight: [0, 3],
}

const defaults = {
  budgetUsd: 200,
  perSideUsd: 30,
  markets: 2,
  depthPct: 30,
  bidStopHours: 3,
  requoteSeconds: 120,
  pick: 'manual',
  dailyLossShare: 0.1,
  hourlyLossShare: 0.4,
  pullMovePct: 50,
  calmSeconds: 60,
  familyWeight: 1,
  rankWeight: 1,
}

const exit = {
  times: {
    default: { closeMs: 20 * minute, forceMs: 6 * minute, sweepMs: 2 * minute },
    long: { closeMs: 60 * minute, forceMs: 15 * minute, sweepMs: 5 * minute },
  },
  // The resting exit ask slides from breakeven toward its floor between this time before the start and the force time.
  slideStartMs: 60 * minute,
  maxSpread: 0.1,
  refFloorFraction: 0.5,
  trustedSpread: 0.03,
  refWindowMs: 30 * minute,
  refMinSamples: 3,
  noRef: { maxSpread: 0.03, stableMs: minute, stableRange: 0.02, askDepthWithin: 0.03 },
  // Long enough to hold the whole reference window of the long group until its last forced sell.
  sampleKeepMs: 50 * minute,
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, value))
const num = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const closeMsOf = (family) => (family === 'soccer' || family === 'esports' ? exit.times.long : exit.times.default).closeMs

/**
 * The user's own values mapped straight through, each clamped to its hard range here. A missing value takes the
 * neutral default. guards.mjs sealPolicy clamps this output again against fixed caps.
 */
function settingsFor(prefs = {}) {
  const p = plain(prefs) ? prefs : {}
  const budgetUsd = clamp(num(p.budgetUsd, defaults.budgetUsd), ...limits.budgetUsd)
  const marketCount = clamp(Math.floor(num(p.markets, defaults.markets)), ...limits.markets)
  const perSideUsd = clamp(num(p.perSideUsd, defaults.perSideUsd), ...limits.perSideUsd)
  const maxHeldPerLegUsd = clamp(num(p.maxHeldPerLegUsd, perSideUsd), limits.maxHeldPerLegUsd[0], perSideUsd)
  const depthFraction = clamp(num(p.depthPct, defaults.depthPct), ...limits.depthPct) / 100
  const bidStopMs = {}
  for (const family of families) {
    const hours = num(p.bidStopHours?.[family], defaults.bidStopHours)
    bidStopMs[family] = clamp(hours * hour, closeMsOf(family), limits.bidStopHoursMax * hour)
  }
  const requoteMs = clamp(Math.round(num(p.requoteSeconds, defaults.requoteSeconds)), ...limits.requoteSeconds) * 1000
  const on = {}
  const familyWeights = {}
  for (const family of families) {
    const w = clamp(num(p.familyWeights?.[family], defaults.familyWeight), ...limits.familyWeight)
    const enabled = p.families?.[family] !== false && w > 0
    on[family] = enabled
    familyWeights[family] = enabled ? w : 0
  }
  const rankWeights = {}
  for (const factor of rankFactors) {
    rankWeights[factor] = clamp(num(p.rankWeights?.[factor], defaults.rankWeight), ...limits.rankWeight)
  }
  const dailyMax = budgetUsd * limits.dailyLossShareMax
  const dailyLossStopUsd = clamp(num(p.dailyLossStopUsd, budgetUsd * defaults.dailyLossShare), limits.lossStopMinUsd, dailyMax)
  const hourlyLossStopUsd = clamp(
    num(p.hourlyLossStopUsd, dailyLossStopUsd * defaults.hourlyLossShare),
    Math.min(limits.lossStopMinUsd, dailyLossStopUsd),
    dailyLossStopUsd
  )
  const pullMoveFraction = clamp(num(p.pullMovePct, defaults.pullMovePct), ...limits.pullMovePct) / 100
  const calmMs = clamp(Math.round(num(p.calmSeconds, defaults.calmSeconds)), ...limits.calmSeconds) * 1000
  const pick = p.pick === 'auto' ? 'auto' : 'manual'
  const manualMarkets = Array.isArray(p.manualMarkets)
    ? p.manualMarkets.filter((id) => Number.isSafeInteger(id) && id >= 0).slice(0, limits.manualMarketsMax)
    : []
  const excludeMarkets = Array.isArray(p.excludeMarkets)
    ? p.excludeMarkets.filter((id) => Number.isSafeInteger(id) && id >= 0).slice(0, limits.excludeMarketsMax)
    : []
  return {
    budgetUsd,
    marketCount,
    perSideUsd,
    maxHeldPerLegUsd,
    depthFraction,
    bidStopMs,
    requoteMs,
    families: on,
    familyWeights,
    rankWeights,
    pick,
    manualMarkets,
    excludeMarkets,
    dailyLossStopUsd,
    hourlyLossStopUsd,
    pullMoveFraction,
    calmMs,
    hours: p.hours ?? null,
  }
}

export const Policy = Object.freeze({
  version: 'reference-2',
  limits,
  defaults,
  pricing: Object.freeze({
    // Where a bid may rest, as a fraction of the band half-width from the mid: the depthPct range over 100.
    range: [limits.depthPct[0] / 100, limits.depthPct[1] / 100],
    // A resting bid is kept while it sits within this fraction of the user's own depth.
    hysteresis: 0.1,
  }),
  guards: Object.freeze({
    minLegPrice: 0.1,
    maxEntrySpread: 0.03,
    midMin: 0.05,
    midMax: 0.95,
    // Neutral default bid stop, the same for every family. The user's own bidStopHours replace it.
    bidStopMs: () => defaults.bidStopHours * hour,
    // Neutral defaults for the pull check. The user's own pullMovePct and calmSeconds replace them.
    pullMoveFraction: defaults.pullMovePct / 100,
    calmMs: defaults.calmSeconds * 1000,
    // The resting exit ask never offers below this loss on its cost (after the taker fee).
    maxExitLossFraction: 0.1,
    exit,
  }),
  dms: Object.freeze({ rearmEveryMs: 120e3, deadlineMs: 300e3 }),
  selection: Object.freeze({ reselectMs: 300e3 }),
  requests: Object.freeze({
    maxMarkets: limits.markets[1],
    infoWeightPerMin: 900,
    cancelReservePerMin: 1080,
    ipWeightPerMin: 1200,
    maxOrderActionsPerHour: 240,
    actionsPerMarketPerHour: 160,
    // Share of the hourly action allowance kept for exits, cancels and the disconnect timer (a fraction).
    exitActionReserve: 0.2,
    addressReserve: 500,
    cancelBatchMax: 200,
    minRequoteMs: 60e3,
    refusalBackoffMaxMs: 15 * minute,
    backoffMs: [7e3, 14e3, 28e3, 60e3],
    jitter: 0.3,
  }),
  feeds: Object.freeze({ livenessMs: 30e3, restSpotCheckMs: 60e3 }),
  rollover: Object.freeze({ holdMs: 120e3, refreshMs: 15e3, feedStaleMs: 600e3 }),
  settingsFor,
})

export default Policy
