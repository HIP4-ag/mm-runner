// Guard rails: readable mechanism that takes its numbers from a policy object. Pure functions, no network.
import { sellTakerFeeRate } from './inventory.mjs'

/** Hard rule, not a policy number: nothing rests on a market from one minute before its start. */
export const startBlockMs = 60e3

export const startBlocked = (start, now) =>
  !Number.isFinite(start) || !Number.isFinite(now) || now >= start - startBlockMs

/** The families a user sets values for. Anything else (futures, an unlisted family) is treated as the strictest. */
export const familyKeys = Object.freeze(['nba', 'nfl', 'soccer', 'esports', 'other'])
export const rankFactorKeys = Object.freeze(['pool', 'start', 'spread'])
const knownFamilies = [...familyKeys, 'futures']
const timeOfDay = /^([01]\d|2[0-3]):[0-5]\d$/
const minute = 60e3
const hour = 3600e3

/**
 * Forced pre-game exit timing floors, the same for everyone. A policy may only move each time earlier (longer before
 * the start). The long group (soccer and esports) closes entries 60 min before the start, forces at 15, sweeps at 5.
 */
export const exitFloors = Object.freeze({
  default: Object.freeze({ closeMs: 20 * minute, forceMs: 6 * minute, sweepMs: 2 * minute }),
  long: Object.freeze({ closeMs: 60 * minute, forceMs: 15 * minute, sweepMs: 5 * minute }),
})

/** 'long' for soccer and esports, else 'default'. */
export const exitGroup = (family) => (family === 'soccer' || family === 'esports' ? 'long' : 'default')

/**
 * The exit times of one family: { closeMs, forceMs, sweepMs } before the start. Each is the policy value, never
 * later than the hard floor, so even an unsealed policy cannot loosen it.
 */
export function exitTimes(family, policy) {
  const group = exitGroup(family)
  const floor = exitFloors[group]
  const own = policy?.guards?.exit?.times?.[group] ?? {}
  const at = (key) => (isNum(own[key]) ? Math.max(own[key], floor[key]) : floor[key])
  return { closeMs: at('closeMs'), forceMs: at('forceMs'), sweepMs: at('sweepMs') }
}

/** Entries close this long before the start: the earliest a bid stop may be. */
export const entryCloseMs = (family, policy) => exitTimes(family, policy).closeMs

// Fixed caps applied in mechanism code, whatever a policy file says.
export const hardCaps = Object.freeze({
  maxMarkets: 6,
  maxBudgetUsd: 10000,
  maxPerSideUsd: 250,
  maxLossFractionOfBudget: 0.25,
  fraction: Object.freeze([0.15, 0.6]),
  minRequoteMs: 60e3,
  minCalmMs: 60e3,
  maxCalmMs: 3600e3,
  pullMove: Object.freeze([0.25, 1]),
  maxBidStopMs: 168 * hour,
  maxManualMarkets: 6,
  maxExcludeMarkets: 20,
  weight: Object.freeze([0, 3]),
})

const isNum = (value) => typeof value === 'number' && Number.isFinite(value)
const within = (value, low, high) => isNum(value) && value >= low && value <= high
const clamp = (value, low, high) => Math.min(high, Math.max(low, value))
const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isRange = (value) => Array.isArray(value) && value.length === 2 && isNum(value[0]) && isNum(value[1]) && value[0] <= value[1]

/**
 * The absolute envelope every policy must stay inside, whatever file it came from. Every numeric field is checked
 * against a hard range that only allows a stricter value on the safety rails, and a missing or NaN field fails.
 * Throws an Error naming the first field outside it.
 */
export function assertPolicyEnvelope(p) {
  const fail = (message) => {
    throw Error(`Policy outside its allowed envelope: ${message}`)
  }
  const need = (value, low, high, label) => {
    if (!within(value, low, high)) fail(`${label} must be a number from ${low} to ${high}`)
  }
  const whole = (value, low, high, label) => {
    if (!(Number.isInteger(value) && value >= low && value <= high)) fail(`${label} must be a whole number from ${low} to ${high}`)
  }
  const span = (value, low, high, label, integer = false) => {
    if (!isRange(value) || value[0] < low || value[1] > high || (integer && !value.every(Number.isInteger)))
      fail(`${label} must be a range inside ${low} to ${high}`)
  }

  if (typeof p?.version !== 'string' || !p.version) fail('version is missing')

  // Hard ranges of the user's own settings.
  const l = p.limits
  if (!isPlain(l)) fail('limits are missing')
  span(l.budgetUsd, 1, hardCaps.maxBudgetUsd, 'budget range')
  span(l.perSideUsd, 1, hardCaps.maxPerSideUsd, 'size per side range')
  span(l.maxHeldPerLegUsd, 1, hardCaps.maxPerSideUsd, 'held per leg range')
  span(l.markets, 1, hardCaps.maxMarkets, 'market count range', true)
  span(l.depthPct, hardCaps.fraction[0] * 100, hardCaps.fraction[1] * 100, 'depth range')
  need(l.bidStopHoursMax, 1, hardCaps.maxBidStopMs / hour, 'longest bid stop')
  span(l.requoteSeconds, hardCaps.minRequoteMs / 1000, 86400, 'requote range')
  need(l.lossStopMinUsd, 0.01, 100, 'smallest loss stop')
  need(l.dailyLossShareMax, 0.001, hardCaps.maxLossFractionOfBudget, 'daily loss stop share of budget')
  span(l.pullMovePct, hardCaps.pullMove[0] * 100, hardCaps.pullMove[1] * 100, 'pull move range')
  span(l.calmSeconds, hardCaps.minCalmMs / 1000, hardCaps.maxCalmMs / 1000, 'calm time range')
  whole(l.manualMarketsMax, 1, hardCaps.maxManualMarkets, 'hand-picked market count')
  if (l.excludeMarketsMax !== undefined) whole(l.excludeMarketsMax, 1, hardCaps.maxExcludeMarkets, 'excluded market count')
  if (l.familyWeight !== undefined) span(l.familyWeight, hardCaps.weight[0], hardCaps.weight[1], 'family weight range')
  if (l.rankWeight !== undefined) span(l.rankWeight, hardCaps.weight[0], hardCaps.weight[1], 'market selection weight range')

  // Neutral defaults, each inside its range.
  const d = p.defaults
  if (!isPlain(d)) fail('defaults are missing')
  need(d.budgetUsd, l.budgetUsd[0], l.budgetUsd[1], 'default budget')
  need(d.perSideUsd, l.perSideUsd[0], l.perSideUsd[1], 'default size per side')
  whole(d.markets, l.markets[0], l.markets[1], 'default market count')
  need(d.depthPct, l.depthPct[0], l.depthPct[1], 'default depth')
  need(d.bidStopHours, exitFloors.long.closeMs / hour, l.bidStopHoursMax, 'default bid stop')
  whole(d.requoteSeconds, l.requoteSeconds[0], l.requoteSeconds[1], 'default requote time')
  if (d.pick !== 'auto' && d.pick !== 'manual') fail('default pick must be auto or manual')
  need(d.dailyLossShare, 0.001, l.dailyLossShareMax, 'default daily loss stop share')
  need(d.hourlyLossShare, 0.01, 1, 'default hourly loss stop share')
  need(d.pullMovePct, l.pullMovePct[0], l.pullMovePct[1], 'default pull move')
  whole(d.calmSeconds, l.calmSeconds[0], l.calmSeconds[1], 'default calm time')
  if (d.familyWeight !== undefined) need(d.familyWeight, ...(l.familyWeight ?? hardCaps.weight), 'default family weight')
  if (d.rankWeight !== undefined) need(d.rankWeight, ...(l.rankWeight ?? hardCaps.weight), 'default selection weight')

  const range = p.pricing?.range
  if (!isRange(range) || range[0] < hardCaps.fraction[0] || range[1] > hardCaps.fraction[1])
    fail(`band fraction range must sit inside [${hardCaps.fraction[0]}, ${hardCaps.fraction[1]}]`)
  need(p.pricing.hysteresis, 0, 0.45, 'keep hysteresis')

  const deadline = p?.dms?.deadlineMs
  if (!(deadline >= 60e3 && deadline <= 300e3)) fail('dead man switch deadline must be 60 s to 300 s')
  const rearm = p?.dms?.rearmEveryMs
  if (!(rearm > 0 && rearm <= deadline / 2)) fail('re-arm interval must be at most half the deadline')

  const g = p?.guards
  if (!isPlain(g)) fail('guards are missing')
  need(g.minLegPrice, 0.1, 0.5, 'minimum leg price')
  need(g.maxEntrySpread, 0.001, 0.03, 'maximum entry spread')
  need(g.midMin, 0.05, 0.3, 'lowest quoting midpoint')
  need(g.midMax, 0.7, 0.95, 'highest quoting midpoint')
  if (!(g.midMin < g.midMax)) fail('midpoint range is empty')
  need(g.pullMoveFraction, hardCaps.pullMove[0], hardCaps.pullMove[1], 'pull move fraction')
  need(g.calmMs, hardCaps.minCalmMs, hardCaps.maxCalmMs, 'calm period')
  need(g.maxExitLossFraction, 0, 0.25, 'exit loss fraction')

  const ex = g.exit
  if (!isPlain(ex) || !isPlain(ex.times)) fail('exit times are missing')
  for (const group of ['default', 'long']) {
    const t = ex.times[group]
    const floor = exitFloors[group]
    need(t?.closeMs, floor.closeMs, 24 * hour, `${group} entry close`)
    need(t.forceMs, floor.forceMs, 24 * hour, `${group} forced sell time`)
    need(t.sweepMs, floor.sweepMs, 24 * hour, `${group} sweep time`)
    if (!(t.closeMs > t.forceMs && t.forceMs > t.sweepMs && t.sweepMs > startBlockMs))
      fail(`${group} exit times must run close, then force, then sweep, then the one-minute start block`)
  }
  need(ex.slideStartMs, Math.max(ex.times.default.forceMs, ex.times.long.forceMs) + minute, 24 * hour, 'exit slide start')
  need(ex.maxSpread, 0.001, 0.1, 'forced sell spread limit')
  need(ex.refFloorFraction, 0.5, 0.95, 'forced sell floor fraction')
  need(ex.trustedSpread, 0.001, 0.03, 'trusted reference spread')
  need(ex.refWindowMs, 10 * minute, 2 * hour, 'reference window')
  whole(ex.refMinSamples, 3, 1000, 'reference samples')
  const nr = ex.noRef
  if (!isPlain(nr)) fail('no-reference checks are missing')
  need(nr.maxSpread, 0.001, 0.03, 'no-reference spread limit')
  need(nr.stableMs, 60e3, 600e3, 'no-reference stable time')
  need(nr.stableRange, 0.001, 0.02, 'no-reference stable range')
  need(nr.askDepthWithin, 0.001, 0.03, 'no-reference ask depth range')
  const keepFloor = ex.refWindowMs + Math.max(ex.times.default.forceMs, ex.times.long.forceMs)
  need(ex.sampleKeepMs, keepFloor, 6 * hour, 'sample keep time (at least the reference window plus the force time)')

  // Bid stops: never later than the family's entry close, and the user may not go past the longest.
  if (typeof g.bidStopMs !== 'function') fail('bid stop is missing')
  for (const family of [...knownFamilies, 'unlisted-family', undefined, null]) {
    let stop
    try {
      stop = g.bidStopMs(family)
    } catch {
      stop = NaN
    }
    const close = entryCloseMs(family, p)
    if (!(isNum(stop) && stop >= close && stop <= l.bidStopHoursMax * hour))
      fail('bid stop must be from the entry close to the longest bid stop for every family')
  }

  if (!isPlain(p.selection)) fail('selection is missing')
  need(p.selection.reselectMs, 30e3, 3600e3, 'reselect time')

  const r = p?.requests
  if (!isPlain(r)) fail('request limits are missing')
  whole(r.maxMarkets, 1, Math.min(hardCaps.maxMarkets, l.markets[1]), 'market count')
  need(r.infoWeightPerMin, 1, 900, 'info weight per minute')
  need(r.cancelReservePerMin, 1, 1200, 'cancel reserve per minute')
  need(r.ipWeightPerMin, 1, 1200, 'IP weight per minute')
  whole(r.maxOrderActionsPerHour, 1, 600, 'order actions per hour')
  whole(r.actionsPerMarketPerHour, 1, 600, 'order actions per market per hour')
  need(r.exitActionReserve, 0.05, 0.5, 'exit action reserve')
  need(r.addressReserve, 100, 100000, 'address request reserve')
  whole(r.cancelBatchMax, 1, 200, 'cancel batch size')
  need(r.minRequoteMs, hardCaps.minRequoteMs, 600e3, 'minimum requote time')
  need(r.refusalBackoffMaxMs, r.minRequoteMs, 3600e3, 'longest refusal backoff')
  if (!Array.isArray(r.backoffMs) || !r.backoffMs.length || r.backoffMs.length > 10) fail('backoff steps are missing')
  r.backoffMs.forEach((step, i) => {
    need(step, 1e3, 600e3, 'backoff step')
    if (i && step < r.backoffMs[i - 1]) fail('backoff steps must not shrink')
  })
  need(r.jitter, 0, 0.5, 'jitter')

  need(p.feeds?.livenessMs, 5e3, 30e3, 'feed liveness')
  need(p.feeds.restSpotCheckMs, 30e3, 600e3, 'REST spot check interval')
  need(p.rollover?.holdMs, 0, 120e3, 'rollover hold')
  need(p.rollover.refreshMs, 5e3, 120e3, 'rollover refresh')
  need(p.rollover.feedStaleMs, 60e3, 600e3, 'reward feed stale time')

  if (typeof p.settingsFor !== 'function') fail('settings function is missing')
  return p
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

const refuse = (message) => {
  throw Error(`Policy output refused: ${message}`)
}

/** A quoting-hours window as { from, to } or null; throws through refuse when malformed. */
function cleanHours(h) {
  if (h === null || h === undefined) return null
  if (
    !isPlain(h) ||
    Object.keys(h).length !== 2 ||
    typeof h.from !== 'string' ||
    typeof h.to !== 'string' ||
    !timeOfDay.test(h.from) ||
    !timeOfDay.test(h.to) ||
    h.from === h.to
  )
    refuse('quoting hours are malformed')
  return { from: h.from, to: h.to }
}

/**
 * Turn a loaded policy into deep-frozen plain data plus pure functions this module wraps itself.
 * Every number is read once. bidStopMs is evaluated once per known family into a table (the longest stop for any
 * other family). settingsFor is wrapped so its output is clamped against fixed caps here, in mechanism code.
 * Throws if the result is outside the envelope.
 */
export function sealPolicy(source) {
  const read = (fn, fallback) => {
    try {
      return fn()
    } catch {
      return fallback
    }
  }
  const num = (value) => (typeof value === 'number' ? value : NaN)
  const fn = (value) => (typeof value === 'function' ? value : null)
  const pair = (value) => (Array.isArray(value) ? [num(value[0]), num(value[1])] : [NaN, NaN])
  const nums = (obj, keys) => Object.fromEntries(keys.map((key) => [key, num(obj?.[key])]))

  const src = source ?? {}
  const li = src.limits ?? {}
  const de = src.defaults ?? {}
  const g = src.guards ?? {}
  const ex = g.exit ?? {}
  const rq = src.requests ?? {}
  const pr = src.pricing ?? {}

  const limits = {
    budgetUsd: pair(li.budgetUsd),
    perSideUsd: pair(li.perSideUsd),
    maxHeldPerLegUsd: pair(li.maxHeldPerLegUsd),
    markets: pair(li.markets),
    depthPct: pair(li.depthPct),
    bidStopHoursMax: num(li.bidStopHoursMax),
    requoteSeconds: pair(li.requoteSeconds),
    lossStopMinUsd: num(li.lossStopMinUsd),
    dailyLossShareMax: num(li.dailyLossShareMax),
    pullMovePct: pair(li.pullMovePct),
    calmSeconds: pair(li.calmSeconds),
    manualMarketsMax: num(li.manualMarketsMax),
    excludeMarketsMax: li.excludeMarketsMax === undefined ? hardCaps.maxExcludeMarkets : num(li.excludeMarketsMax),
    familyWeight: li.familyWeight === undefined ? [...hardCaps.weight] : pair(li.familyWeight),
    rankWeight: li.rankWeight === undefined ? [...hardCaps.weight] : pair(li.rankWeight),
  }
  const defaults = {
    ...nums(de, ['budgetUsd', 'perSideUsd', 'markets', 'depthPct', 'bidStopHours', 'requoteSeconds']),
    pick: typeof de.pick === 'string' ? de.pick : '',
    ...nums(de, ['dailyLossShare', 'hourlyLossShare', 'pullMovePct', 'calmSeconds']),
    familyWeight: de.familyWeight === undefined ? 1 : num(de.familyWeight),
    rankWeight: de.rankWeight === undefined ? 1 : num(de.rankWeight),
  }
  const exit = {
    times: {
      default: nums(ex.times?.default, ['closeMs', 'forceMs', 'sweepMs']),
      long: nums(ex.times?.long, ['closeMs', 'forceMs', 'sweepMs']),
    },
    ...nums(ex, ['slideStartMs', 'maxSpread', 'refFloorFraction', 'trustedSpread', 'refWindowMs', 'refMinSamples']),
    noRef: nums(ex.noRef, ['maxSpread', 'stableMs', 'stableRange', 'askDepthWithin']),
    sampleKeepMs: num(ex.sampleKeepMs),
  }

  // The bid stop table is read before the exit times are known to the envelope, so it is checked there.
  const bidStop = fn(g.bidStopMs)
  const table = {}
  for (const family of knownFamilies) table[family] = bidStop ? num(read(() => bidStop(family), NaN)) : NaN
  const stops = Object.values(table)
  const longest = stops.length && stops.every(isNum) ? Math.max(...stops) : NaN
  const bidStopMs = (family) => (typeof family === 'string' && Object.hasOwn(table, family) ? table[family] : longest)

  const requests = {
    ...nums(rq, [
      'maxMarkets',
      'infoWeightPerMin',
      'cancelReservePerMin',
      'ipWeightPerMin',
      'maxOrderActionsPerHour',
      'actionsPerMarketPerHour',
      'exitActionReserve',
      'addressReserve',
      'cancelBatchMax',
      'minRequoteMs',
      'refusalBackoffMaxMs',
    ]),
    backoffMs: Array.isArray(rq.backoffMs) ? rq.backoffMs.map(num) : null,
    jitter: num(rq.jitter),
  }
  const range = pair(pr.range)

  const settingsSrc = fn(src.settingsFor)
  const maxMarkets = Math.min(hardCaps.maxMarkets, isNum(requests.maxMarkets) ? requests.maxMarkets : hardCaps.maxMarkets)
  const wholeIn = (value, low, high, label) => {
    if (!isNum(value)) refuse(`${label} is not a number`)
    return clamp(Math.floor(value), low, high)
  }
  const positive = (value, label) => {
    if (!(isNum(value) && value > 0)) refuse(`${label} is not a positive number`)
    return value
  }
  const sealedFor = { guards: { exit } }

  const settingsFor = settingsSrc
    ? (prefs, options) => {
        const s = settingsSrc(prefs, options)
        if (!isPlain(s)) refuse('settings are missing')
        const budgetUsd = Math.min(positive(s.budgetUsd, 'budget'), hardCaps.maxBudgetUsd, limits.budgetUsd[1])
        const marketCount = wholeIn(s.marketCount, 1, maxMarkets, 'market count')
        const perSideUsd = Math.min(
          positive(s.perSideUsd, 'size per side'),
          hardCaps.maxPerSideUsd,
          limits.perSideUsd[1],
          budgetUsd / (2 * marketCount)
        )
        const maxHeldPerLegUsd = Math.min(positive(s.maxHeldPerLegUsd, 'held per leg'), perSideUsd)
        if (!isNum(s.depthFraction)) refuse('depth is not a number')
        const depthFraction = clamp(s.depthFraction, Math.max(range[0], hardCaps.fraction[0]), Math.min(range[1], hardCaps.fraction[1]))
        if (!isPlain(s.bidStopMs)) refuse('bid stops are missing')
        const stopsOut = {}
        for (const family of familyKeys) {
          if (!isNum(s.bidStopMs[family])) refuse(`bid stop for ${family} is not a number`)
          stopsOut[family] = clamp(
            s.bidStopMs[family],
            entryCloseMs(family, sealedFor),
            Math.min(hardCaps.maxBidStopMs, limits.bidStopHoursMax * hour)
          )
        }
        if (!isNum(s.requoteMs)) refuse('requote time is not a number')
        const requoteMs = clamp(s.requoteMs, Math.max(hardCaps.minRequoteMs, requests.minRequoteMs), 86400e3)
        if (!isPlain(s.families)) refuse('families are missing')
        const families = {}
        const familyWeights = {}
        const fwBounds = limits.familyWeight ?? hardCaps.weight
        for (const family of familyKeys) {
          if (typeof s.families[family] !== 'boolean') refuse(`family ${family} is not on or off`)
          const rawW = s.familyWeights ? s.familyWeights[family] : s.families[family] ? 1 : 0
          if (!isNum(rawW)) refuse(`family weight for ${family} is not a number`)
          const w = clamp(rawW, Math.max(hardCaps.weight[0], fwBounds[0]), Math.min(hardCaps.weight[1], fwBounds[1]))
          families[family] = s.families[family] && w > 0
          familyWeights[family] = families[family] ? w : 0
        }
        const rankWeights = {}
        const rwBounds = limits.rankWeight ?? hardCaps.weight
        for (const factor of rankFactorKeys) {
          const rawW = s.rankWeights ? s.rankWeights[factor] : 1
          if (!isNum(rawW)) refuse(`selection weight for ${factor} is not a number`)
          rankWeights[factor] = clamp(rawW, Math.max(hardCaps.weight[0], rwBounds[0]), Math.min(hardCaps.weight[1], rwBounds[1]))
        }
        if (s.pick !== 'auto' && s.pick !== 'manual') refuse('pick must be auto or manual')
        if (!Array.isArray(s.manualMarkets)) refuse('hand-picked markets are missing')
        const manualMarkets = s.manualMarkets.slice(0, Math.min(hardCaps.maxManualMarkets, limits.manualMarketsMax))
        if (!manualMarkets.every((id) => Number.isSafeInteger(id) && id >= 0)) refuse('a hand-picked market id is not valid')
        const rawExclude = s.excludeMarkets ?? []
        if (!Array.isArray(rawExclude)) refuse('excluded markets must be a list')
        const excludeMarkets = rawExclude.slice(0, Math.min(hardCaps.maxExcludeMarkets, limits.excludeMarketsMax))
        if (!excludeMarkets.every((id) => Number.isSafeInteger(id) && id >= 0)) refuse('an excluded market id is not valid')
        const lossCap = Math.min(budgetUsd * hardCaps.maxLossFractionOfBudget, budgetUsd * limits.dailyLossShareMax)
        const dailyLossStopUsd = Math.min(positive(s.dailyLossStopUsd, 'daily loss stop'), lossCap)
        const hourlyLossStopUsd = Math.min(positive(s.hourlyLossStopUsd, 'hourly loss stop'), dailyLossStopUsd)
        if (!isNum(s.pullMoveFraction)) refuse('pull move is not a number')
        const pullMoveFraction = clamp(s.pullMoveFraction, hardCaps.pullMove[0], hardCaps.pullMove[1])
        if (!isNum(s.calmMs)) refuse('calm time is not a number')
        const calmMs = clamp(s.calmMs, hardCaps.minCalmMs, hardCaps.maxCalmMs)
        const hours = cleanHours(s.hours)
        return {
          budgetUsd,
          marketCount,
          perSideUsd,
          maxHeldPerLegUsd,
          depthFraction,
          bidStopMs: stopsOut,
          requoteMs,
          families,
          familyWeights,
          rankWeights,
          pick: s.pick,
          manualMarkets,
          excludeMarkets,
          dailyLossStopUsd,
          hourlyLossStopUsd,
          pullMoveFraction,
          calmMs,
          hours,
          // Kept for callers that still ask per market: every market gets the user's one depth.
          fractionFor: () => depthFraction,
          // Kept for callers that still read weights: user's 0..3 family weight (0 when family is off; futures stay off).
          familyWeight: { ...familyWeights, futures: 0 },
        }
      }
    : null

  const sealed = {
    version: typeof src.version === 'string' ? src.version : '',
    limits,
    defaults,
    pricing: { range, hysteresis: num(pr.hysteresis) },
    guards: {
      minLegPrice: num(g.minLegPrice),
      maxEntrySpread: num(g.maxEntrySpread),
      midMin: num(g.midMin),
      midMax: num(g.midMax),
      bidStopMs,
      pullMoveFraction: num(g.pullMoveFraction),
      calmMs: num(g.calmMs),
      maxExitLossFraction: num(g.maxExitLossFraction),
      exit,
    },
    dms: nums(src.dms, ['rearmEveryMs', 'deadlineMs']),
    selection: nums(src.selection, ['reselectMs']),
    requests,
    feeds: nums(src.feeds, ['livenessMs', 'restSpotCheckMs']),
    rollover: nums(src.rollover, ['holdMs', 'refreshMs', 'feedStaleMs']),
    settingsFor,
  }
  assertPolicyEnvelope(sealed)
  return deepFreeze(sealed)
}

const legMid = (leg) => (leg.bestBid + leg.bestAsk) / 2

/**
 * The bid stop of one family in ms before the start: the user's own value (settings.bidStopMs from settingsFor) or,
 * without settings, the policy's neutral default. Never shorter than the family's entry close and never longer than
 * the hard cap. A family the user has no value for (futures, an unlisted one) gets the longest of the user's stops.
 * NaN when nothing readable is there, which shuts the market.
 */
export function bidStopFor({ family, settings, policy }) {
  const own = settings?.bidStopMs
  let stop
  if (isPlain(own)) {
    const values = familyKeys.map((f) => own[f]).filter(isNum)
    stop = typeof family === 'string' && familyKeys.includes(family) ? own[family] : values.length ? Math.max(...values) : NaN
  } else {
    stop = typeof policy?.guards?.bidStopMs === 'function' ? policy.guards.bidStopMs(family) : NaN
  }
  if (!isNum(stop)) return NaN
  return clamp(stop, entryCloseMs(family, policy), hardCaps.maxBidStopMs)
}

/**
 * The market-wide checks of entryGate: returns { code, message } for the first one that shuts the market, or null.
 * bidStopMs (optional): the user's stop for this family (bidStopFor); it is never allowed past the entry close.
 * Fails closed on an unknown clock, start, midpoint or bid stop.
 */
export function marketGate({ mid, start, now, family, policy, bidStopMs }) {
  const g = policy?.guards
  if (!Number.isFinite(now)) return { code: 'start', message: 'The clock is unknown.' }
  if (startBlocked(start, now)) return { code: 'start', message: 'Within one minute of the start, or the start is unknown.' }
  const given = bidStopMs === undefined ? (typeof g?.bidStopMs === 'function' ? g.bidStopMs(family) : NaN) : bidStopMs
  const stop = isNum(given) ? Math.max(given, entryCloseMs(family, policy)) : NaN
  if (!Number.isFinite(stop)) return { code: 'bid_stop', message: 'The bid stop is unknown.' }
  if (now >= start - stop) return { code: 'bid_stop', message: 'Too close to the start for new bids.' }
  if (!(Number.isFinite(g.midMin) && Number.isFinite(g.midMax) && mid >= g.midMin && mid <= g.midMax))
    return { code: 'mid', message: 'The midpoint is outside the quoting range.' }
  return null
}

/**
 * Which legs may take a new bid right now.
 * legs: [{ bestBid, bestAsk }, { bestBid, bestAsk }] in each leg's own price. Both entries are required: a missing or
 * short list shuts the missing leg.
 * hasResting: boolean, or [boolean, boolean] per leg. bidStopMs: as in marketGate. Returns { legs: [bool, bool],
 * reasons: [{ leg, code, message }] }. leg is null when a reason covers the whole market. start and now are epoch ms.
 */
export function entryGate({ mid, legs, start, now, family, hasResting = false, policy, bidStopMs }) {
  const g = policy.guards
  const reasons = []
  const shut = (code, message) => {
    reasons.push({ leg: null, code, message })
    return { legs: [false, false], reasons }
  }

  const market = marketGate({ mid, start, now, family, policy, bidStopMs })
  if (market) return shut(market.code, market.message)
  if (!(Number.isFinite(g.minLegPrice) && Number.isFinite(g.maxEntrySpread)))
    return shut('policy', 'The policy has no leg price or spread limit.')

  const allowed = [true, true]
  for (const i of [0, 1]) {
    const leg = Array.isArray(legs) ? legs[i] : undefined
    const bid = leg?.bestBid
    const ask = leg?.bestAsk
    const resting = Array.isArray(hasResting) ? Boolean(hasResting[i]) : Boolean(hasResting)
    const skip = (code, message) => {
      allowed[i] = false
      reasons.push({ leg: i, code, message })
    }
    if (!(Number.isFinite(bid) && Number.isFinite(ask) && bid < ask)) {
      skip('book', 'No two-sided book on this leg.')
      continue
    }
    if (legMid(leg) < g.minLegPrice) {
      skip('min_price', 'The leg price is too low to quote.')
      continue
    }
    if (!resting && ask - bid > g.maxEntrySpread) skip('spread', 'The spread is too wide to open a bid.')
  }

  return { legs: allowed, reasons }
}

/**
 * Pull resting bids when the mid moves more than a fraction of the distance to the nearest bid.
 * state: { refMid, lastMoveAt } (both null at the start). restingBids: [{ leg, px }], YES bids and NO bids.
 * filled: true when one of our bids just filled, which counts as a trade through it.
 * moveFraction and calmMs (optional): the user's own pull settings; they replace the policy defaults and are held to
 * the hard ranges (a move of 25% to 100% of the distance, at least 60 s of calm).
 * Returns { pull, calm, state }. calm is true once calmMs have passed since the last pull, so new bids may rest.
 * Anything it cannot read (a missing mid, clock, bid price or policy number) pulls and reports not calm.
 */
export function pullCheck({ state, mid, restingBids = [], now, filled = false, policy, moveFraction, calmMs }) {
  const g = policy.guards
  const move = isNum(moveFraction) ? clamp(moveFraction, hardCaps.pullMove[0], hardCaps.pullMove[1]) : g.pullMoveFraction
  const calmFor = isNum(calmMs) ? clamp(calmMs, hardCaps.minCalmMs, hardCaps.maxCalmMs) : g.calmMs
  const keep = {
    refMid: Number.isFinite(state?.refMid) ? state.refMid : null,
    lastMoveAt: Number.isFinite(state?.lastMoveAt) ? state.lastMoveAt : null,
  }
  const unreadable =
    !Number.isFinite(mid) ||
    !Number.isFinite(now) ||
    !Number.isFinite(move) ||
    !Number.isFinite(calmFor) ||
    (restingBids ?? []).some((bid) => !Number.isFinite(bid?.px))
  if (unreadable) return { pull: true, calm: false, state: { refMid: keep.refMid, lastMoveAt: Number.isFinite(now) ? now : keep.lastMoveAt } }

  let refMid = keep.refMid ?? mid
  let lastMoveAt = keep.lastMoveAt
  const calmNow = () => lastMoveAt === null || now - lastMoveAt >= calmFor

  let pull = Boolean(filled)
  if (!pull && restingBids.length) {
    // Distance in YES-price terms: a YES bid at px sits px below the mid, a NO bid at px sits (1 - px) above it.
    const distance = Math.min(...restingBids.map((bid) => (bid.leg === 0 ? refMid - bid.px : 1 - bid.px - refMid)))
    pull = !(Math.abs(mid - refMid) <= move * distance)
  }

  if (pull) {
    lastMoveAt = now
    refMid = mid
  } else if (!restingBids.length && calmNow()) {
    // Nothing to protect and the market is calm: anchor to the current mid for the next set of bids.
    refMid = mid
  }

  return { pull, calm: calmNow(), state: { refMid, lastMoveAt } }
}

const minutes = (text) => {
  const match = timeOfDay.exec(String(text))
  return typeof text === 'string' && match ? Number(text.slice(0, 2)) * 60 + Number(text.slice(3)) : NaN
}

const clocks = new Map()
// Minutes past midnight of an instant in a time zone, read with Intl so the server's own zone never matters.
function minuteOfDay(ms, timeZone) {
  let format = clocks.get(timeZone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' })
    clocks.set(timeZone, format)
  }
  const parts = format.formatToParts(new Date(ms))
  const hourPart = Number(parts.find((p) => p.type === 'hour')?.value)
  const minutePart = Number(parts.find((p) => p.type === 'minute')?.value)
  return hourPart * 60 + minutePart
}

/**
 * hours: null (always open) or { from: 'HH:MM', to: 'HH:MM' } on the clock of timeZone (US Eastern by default,
 * daylight saving included); a window may wrap past midnight. now: epoch ms or a Date. An unknown time zone, clock or
 * malformed window reads as closed.
 */
export function quotingHoursOpen(hours, now, timeZone = 'America/New_York') {
  if (hours == null) return true
  if (!isPlain(hours)) return false
  const from = minutes(hours.from)
  const to = minutes(hours.to)
  if (!(from >= 0 && to >= 0) || from === to) return false
  const ms = now instanceof Date ? now.getTime() : now
  if (!isNum(ms)) return false
  let at
  try {
    at = minuteOfDay(ms, timeZone)
  } catch {
    return false
  }
  if (!Number.isFinite(at)) return false
  return from < to ? at >= from && at < to : at >= from || at < to
}

/**
 * Loss over the trailing hour: the drop from the highest marked total in [now - 1 h, now] to the latest one.
 * history: [{ at, totalUsd }] (marked P&L totals, any order). stopUsd (optional) adds breached.
 * Returns { lossUsd, breached }. An unreadable row, clock or stop fails closed: an infinite loss, breached.
 */
export function hourlyLoss({ history = [], now, stopUsd } = {}) {
  const closed = { lossUsd: Infinity, breached: true }
  if (!isNum(now) || !Array.isArray(history)) return closed
  if (stopUsd !== undefined && !(isNum(stopUsd) && stopUsd > 0)) return closed
  const rows = []
  for (const row of history) {
    if (!(isNum(row?.at) && isNum(row?.totalUsd))) return closed
    if (row.at >= now - hour && row.at <= now) rows.push(row)
  }
  if (!rows.length) return { lossUsd: 0, breached: false }
  rows.sort((a, b) => a.at - b.at)
  const peak = Math.max(...rows.map((row) => row.totalUsd))
  const lossUsd = Math.max(0, peak - rows.at(-1).totalUsd)
  return { lossUsd, breached: stopUsd !== undefined && lossUsd >= stopUsd }
}

/**
 * Marked loss for the day: realized plus open positions marked at the leg's best bid, after the taker fee (the same
 * valuation as inventory.markedPnl). positions: { [legId]: { shares, cost } } (the ledger shape).
 * marks: { [legId]: bestBid } (a missing mark counts as 0).
 * markedLossUsd is zero or positive. breached is true at or past stopUsd. Anything unreadable (a bad stop, realized,
 * shares, cost or fee) fails closed: breached with an infinite loss.
 */
export function lossCheck({ realizedTodayUsd = 0, positions = {}, marks = {}, stopUsd, feeRate = sellTakerFeeRate }) {
  const closed = { markedLossUsd: Infinity, breached: true }
  if (!(isNum(stopUsd) && stopUsd > 0)) return closed
  if (!isNum(realizedTodayUsd)) return closed
  if (!(isNum(feeRate) && feeRate >= 0 && feeRate <= 0.05)) return closed
  let net = realizedTodayUsd
  for (const [id, pos] of Object.entries(positions ?? {})) {
    if (!(isNum(pos?.shares) && pos.shares >= 0 && isNum(pos?.cost) && pos.cost >= 0)) return closed
    const mark = typeof marks?.[id] === 'object' ? marks[id]?.bestBid : marks?.[id]
    net += pos.shares * (Number.isFinite(mark) ? mark : 0) * (1 - feeRate) - pos.cost
  }
  const markedLossUsd = Math.max(0, -net)
  return { markedLossUsd, breached: markedLossUsd >= stopUsd }
}
