import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { entryCloseMs, familyKeys, rankFactorKeys } from './guards.mjs'
import { loadPolicy } from './policy/index.mjs'

// The user's own strategy settings (schema v2). Only these keys are ever read from or written to the preferences
// file. Every range comes from the policy's hard limits; every default is the policy's neutral default. Nothing here
// is a recommendation.

export { familyKeys, rankFactorKeys }
export const schemaVersion = 2
/** The risk statement the user must acknowledge before a start. The page shows this version's text. */
export const riskStatementVersion = 'risk-1'

export const defaultStateDir = join(homedir(), '.hip4-ag', 'mm')
export const preferencesFileIn = (stateDir) => join(String(stateDir), 'preferences.json')
/** The preferences file in the default state dir, for callers that do not pass one. */
export const preferencesFile = preferencesFileIn(defaultStateDir)

const time = /^([01]\d|2[0-3]):[0-5]\d$/
const hour = 3600e3
const groups = ['sizing', 'depth', 'timing', 'markets', 'loss', 'pull']

const fail = (message) => {
  throw Error(message)
}
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)
const round2 = (value) => Math.round(value * 100) / 100
const clamp = (value, low, high) => Math.min(high, Math.max(low, value))
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const closeHours = (family, policy) => entryCloseMs(family, policy) / hour

/**
 * The settings a page renders, as rows { key, type, min, max, default, group } built from the policy. A dependent
 * bound names its source: maxFrom / defaultFrom { key, share } (for example the daily loss stop is at most 0.25 of
 * the budget). bidStopHours has a min per family. boundsFor resolves every bound to a number for one set of choices.
 */
export function schemaFor(policy) {
  const l = policy.limits
  const d = policy.defaults
  return Object.freeze(
    [
      { key: 'budgetUsd', type: 'number', min: l.budgetUsd[0], max: l.budgetUsd[1], default: d.budgetUsd, group: 'sizing' },
      { key: 'perSideUsd', type: 'number', min: l.perSideUsd[0], max: l.perSideUsd[1], default: d.perSideUsd, group: 'sizing' },
      {
        key: 'maxHeldPerLegUsd',
        type: 'number',
        min: l.maxHeldPerLegUsd[0],
        max: l.maxHeldPerLegUsd[1],
        maxFrom: { key: 'perSideUsd', share: 1 },
        default: d.perSideUsd,
        defaultFrom: { key: 'perSideUsd', share: 1 },
        group: 'sizing',
      },
      { key: 'markets', type: 'integer', min: l.markets[0], max: l.markets[1], default: d.markets, group: 'sizing' },
      { key: 'depthPct', type: 'number', min: l.depthPct[0], max: l.depthPct[1], default: d.depthPct, group: 'depth' },
      {
        key: 'bidStopHours',
        type: 'hoursByFamily',
        keys: [...familyKeys],
        min: Object.fromEntries(familyKeys.map((f) => [f, closeHours(f, policy)])),
        max: l.bidStopHoursMax,
        default: d.bidStopHours,
        group: 'timing',
      },
      {
        key: 'requoteSeconds',
        type: 'integer',
        min: l.requoteSeconds[0],
        max: l.requoteSeconds[1],
        default: d.requoteSeconds,
        group: 'timing',
      },
      { key: 'hours', type: 'window', min: null, max: null, default: null, group: 'timing' },
      { key: 'families', type: 'switches', keys: [...familyKeys], min: null, max: null, default: true, group: 'markets' },
      {
        key: 'familyWeights',
        type: 'weightsByFamily',
        keys: [...familyKeys],
        min: l.familyWeight[0],
        max: l.familyWeight[1],
        default: d.familyWeight,
        group: 'markets',
      },
      {
        key: 'rankWeights',
        type: 'rankWeights',
        keys: [...rankFactorKeys],
        min: l.rankWeight[0],
        max: l.rankWeight[1],
        default: d.rankWeight,
        group: 'markets',
      },
      { key: 'pick', type: 'enum', values: ['auto', 'manual'], min: null, max: null, default: d.pick, group: 'markets' },
      { key: 'manualMarkets', type: 'ids', min: 0, max: l.manualMarketsMax, default: [], group: 'markets' },
      { key: 'excludeMarkets', type: 'ids', min: 0, max: l.excludeMarketsMax, default: [], group: 'markets' },
      {
        key: 'dailyLossStopUsd',
        type: 'number',
        min: l.lossStopMinUsd,
        max: round2(l.budgetUsd[1] * l.dailyLossShareMax),
        maxFrom: { key: 'budgetUsd', share: l.dailyLossShareMax },
        default: round2(d.budgetUsd * d.dailyLossShare),
        defaultFrom: { key: 'budgetUsd', share: d.dailyLossShare },
        group: 'loss',
      },
      {
        key: 'hourlyLossStopUsd',
        type: 'number',
        min: l.lossStopMinUsd,
        max: round2(l.budgetUsd[1] * l.dailyLossShareMax),
        maxFrom: { key: 'dailyLossStopUsd', share: 1 },
        default: round2(d.budgetUsd * d.dailyLossShare * d.hourlyLossShare),
        defaultFrom: { key: 'dailyLossStopUsd', share: d.hourlyLossShare },
        group: 'loss',
      },
      { key: 'pullMovePct', type: 'number', min: l.pullMovePct[0], max: l.pullMovePct[1], default: d.pullMovePct, group: 'pull' },
      { key: 'calmSeconds', type: 'integer', min: l.calmSeconds[0], max: l.calmSeconds[1], default: d.calmSeconds, group: 'pull' },
    ].map((row) => {
      if (!groups.includes(row.group)) fail(`Unknown settings group ${row.group}.`)
      return Object.freeze(row)
    })
  )
}

/** The schema rows of the loaded policy. */
export const schema = schemaFor(loadPolicy())

/** Every key a preferences file may hold: the schema rows plus version and the risk acknowledgement. */
export const fileKeys = Object.freeze([
  'version',
  'budgetUsd',
  'perSideUsd',
  'maxHeldPerLegUsd',
  'markets',
  'depthPct',
  'bidStopHours',
  'requoteSeconds',
  'hours',
  'families',
  'familyWeights',
  'rankWeights',
  'pick',
  'manualMarkets',
  'excludeMarkets',
  'dailyLossStopUsd',
  'hourlyLossStopUsd',
  'pullMovePct',
  'calmSeconds',
  'acknowledged',
])

export function defaultPreferences(policy) {
  return validatePreferences({}, { policy, strict: false }).prefs
}

/**
 * Check a preferences object against schema v2 and the policy's hard limits.
 * strict (an API write): throws on any unknown key, wrong type or value out of range, naming the setting.
 * lenient (a file load): drops unknown keys, clamps numbers, resets a bad choice to its default and says so. A v1
 * file keeps its budget and market count; every other setting takes its default, with a warning.
 * A missing key takes its default in both modes. Returns { prefs, warnings }.
 */
export function validatePreferences(input, { policy, strict = false } = {}) {
  const l = policy.limits
  const d = policy.defaults
  const warnings = []
  const show = (value) => (typeof value === 'object' ? JSON.stringify(value) : String(value))
  const bad = (key, message, fallback) => {
    if (strict) fail(`${key}: ${message}`)
    warnings.push(`${key}: ${message}; using ${show(fallback)}.`)
    return fallback
  }
  if (!plain(input)) {
    if (strict) fail('Preferences must be an object.')
    warnings.push('Preferences were not an object; using the defaults.')
    input = {}
  }
  if (input.version === 1 && !strict) {
    warnings.push('Your settings were saved by an older version. Budget and market count were kept; check every other setting.')
    input = { budgetUsd: input.budgetUsd, markets: input.markets }
  } else {
    for (const key of Object.keys(input)) {
      if (fileKeys.includes(key)) continue
      if (strict) fail(`${key}: unknown setting.`)
      warnings.push(`${key}: unknown setting ignored.`)
    }
    if (input.version !== undefined && input.version !== schemaVersion) bad('version', 'unsupported version', schemaVersion)
  }

  const number = (key, low, high, fallback, { whole = false, cents = true } = {}) => {
    const value = input[key]
    if (value === undefined) return fallback
    if (!isNumber(value)) return bad(key, 'must be a number', fallback)
    if (whole && !Number.isInteger(value)) {
      if (strict) fail(`${key}: must be a whole number.`)
      warnings.push(`${key}: rounded to a whole number.`)
    }
    const next = whole ? Math.round(value) : value
    const tidy = (x) => (whole || !cents ? x : clamp(round2(x), low, high))
    if (next >= low && next <= high) return tidy(next)
    if (strict) fail(`${key}: must be between ${low} and ${high}.`)
    warnings.push(`${key}: ${next} is outside ${low} to ${high}; clamped.`)
    return tidy(clamp(next, low, high))
  }

  // Budget first, then size: the other ceilings depend on them.
  const budgetUsd = number('budgetUsd', l.budgetUsd[0], l.budgetUsd[1], d.budgetUsd)
  const perSideUsd = number('perSideUsd', l.perSideUsd[0], l.perSideUsd[1], d.perSideUsd)
  const maxHeldPerLegUsd = number('maxHeldPerLegUsd', l.maxHeldPerLegUsd[0], Math.min(l.maxHeldPerLegUsd[1], perSideUsd), perSideUsd)
  const markets = number('markets', l.markets[0], l.markets[1], d.markets, { whole: true })
  const depthPct = number('depthPct', l.depthPct[0], l.depthPct[1], d.depthPct)
  const requoteSeconds = number('requoteSeconds', l.requoteSeconds[0], l.requoteSeconds[1], d.requoteSeconds, { whole: true })
  const dailyMax = round2(budgetUsd * l.dailyLossShareMax)
  const dailyLossStopUsd = number('dailyLossStopUsd', l.lossStopMinUsd, dailyMax, clamp(round2(budgetUsd * d.dailyLossShare), l.lossStopMinUsd, dailyMax))
  const hourlyLossStopUsd = number(
    'hourlyLossStopUsd',
    Math.min(l.lossStopMinUsd, dailyLossStopUsd),
    dailyLossStopUsd,
    clamp(round2(dailyLossStopUsd * d.hourlyLossShare), Math.min(l.lossStopMinUsd, dailyLossStopUsd), dailyLossStopUsd)
  )
  const pullMovePct = number('pullMovePct', l.pullMovePct[0], l.pullMovePct[1], d.pullMovePct)
  const calmSeconds = number('calmSeconds', l.calmSeconds[0], l.calmSeconds[1], d.calmSeconds, { whole: true })
  if (perSideUsd * 2 * markets > budgetUsd)
    warnings.push(
      `perSideUsd: ${perSideUsd} on both sides of ${markets} markets is more than the budget; each side is limited to ${round2(budgetUsd / (2 * markets))}.`
    )

  const bidStopHours = Object.fromEntries(familyKeys.map((f) => [f, Math.max(d.bidStopHours, closeHours(f, policy))]))
  if (input.bidStopHours !== undefined) {
    if (!plain(input.bidStopHours)) bad('bidStopHours', 'must be an object of hours per family', bidStopHours)
    else
      for (const [key, value] of Object.entries(input.bidStopHours)) {
        if (!familyKeys.includes(key)) {
          if (strict) fail(`bidStopHours.${key}: unknown family.`)
          warnings.push(`bidStopHours.${key}: unknown family ignored.`)
          continue
        }
        const low = closeHours(key, policy)
        if (!isNumber(value)) bidStopHours[key] = bad(`bidStopHours.${key}`, 'must be a number', bidStopHours[key])
        else if (value >= low && value <= l.bidStopHoursMax) bidStopHours[key] = value
        else {
          if (strict) fail(`bidStopHours.${key}: must be between ${low} and ${l.bidStopHoursMax}.`)
          warnings.push(`bidStopHours.${key}: ${value} is outside ${low} to ${l.bidStopHoursMax}; clamped.`)
          bidStopHours[key] = clamp(value, low, l.bidStopHoursMax)
        }
      }
  }

  const families = Object.fromEntries(familyKeys.map((f) => [f, true]))
  if (input.families !== undefined) {
    if (!plain(input.families)) bad('families', 'must be an object of on or off per family', families)
    else
      for (const [key, value] of Object.entries(input.families)) {
        if (!familyKeys.includes(key)) {
          if (strict) fail(`families.${key}: unknown family.`)
          warnings.push(`families.${key}: unknown family ignored.`)
        } else if (typeof value !== 'boolean') families[key] = bad(`families.${key}`, 'must be true or false', families[key])
        else families[key] = value
      }
  }

  const [fwMin, fwMax] = l.familyWeight ?? [0, 3]
  const fwDef = d.familyWeight ?? 1
  const familyWeights = Object.fromEntries(familyKeys.map((f) => [f, fwDef]))
  if (input.familyWeights !== undefined) {
    if (!plain(input.familyWeights)) bad('familyWeights', 'must be an object of weights per family', familyWeights)
    else
      for (const [key, value] of Object.entries(input.familyWeights)) {
        if (!familyKeys.includes(key)) {
          if (strict) fail(`familyWeights.${key}: unknown family.`)
          warnings.push(`familyWeights.${key}: unknown family ignored.`)
          continue
        }
        if (!isNumber(value)) familyWeights[key] = bad(`familyWeights.${key}`, 'must be a number', familyWeights[key])
        else if (value >= fwMin && value <= fwMax) familyWeights[key] = round2(value)
        else {
          if (strict) fail(`familyWeights.${key}: must be between ${fwMin} and ${fwMax}.`)
          warnings.push(`familyWeights.${key}: ${value} is outside ${fwMin} to ${fwMax}; clamped.`)
          familyWeights[key] = round2(clamp(value, fwMin, fwMax))
        }
      }
  }

  const [rwMin, rwMax] = l.rankWeight ?? [0, 3]
  const rwDef = d.rankWeight ?? 1
  const rankWeights = Object.fromEntries(rankFactorKeys.map((k) => [k, rwDef]))
  if (input.rankWeights !== undefined) {
    if (!plain(input.rankWeights)) bad('rankWeights', 'must be an object of selection weights', rankWeights)
    else
      for (const [key, value] of Object.entries(input.rankWeights)) {
        if (!rankFactorKeys.includes(key)) {
          if (strict) fail(`rankWeights.${key}: unknown selection factor.`)
          warnings.push(`rankWeights.${key}: unknown selection factor ignored.`)
          continue
        }
        if (!isNumber(value)) rankWeights[key] = bad(`rankWeights.${key}`, 'must be a number', rankWeights[key])
        else if (value >= rwMin && value <= rwMax) rankWeights[key] = round2(value)
        else {
          if (strict) fail(`rankWeights.${key}: must be between ${rwMin} and ${rwMax}.`)
          warnings.push(`rankWeights.${key}: ${value} is outside ${rwMin} to ${rwMax}; clamped.`)
          rankWeights[key] = round2(clamp(value, rwMin, rwMax))
        }
      }
  }

  let pick = d.pick
  if (input.pick !== undefined) pick = input.pick === 'auto' || input.pick === 'manual' ? input.pick : bad('pick', 'must be auto or manual', pick)

  const idList = (key, max) => {
    const list = input[key]
    if (list === undefined) return []
    if (!Array.isArray(list)) return bad(key, 'must be a list of market ids', [])
    const ok = list.filter((id) => Number.isSafeInteger(id) && id >= 0)
    if (ok.length !== list.length) {
      if (strict) fail(`${key}: every entry must be a market id (a whole number).`)
      warnings.push(`${key}: entries that are not market ids were dropped.`)
    }
    const unique = [...new Set(ok)]
    if (unique.length > max) {
      if (strict) fail(`${key}: at most ${max} markets.`)
      warnings.push(`${key}: only the first ${max} were kept.`)
    }
    return unique.slice(0, max)
  }
  const manualMarkets = idList('manualMarkets', l.manualMarketsMax)
  const excludeMarkets = idList('excludeMarkets', l.excludeMarketsMax ?? 20)

  let hours = null
  const value = input.hours
  if (value !== undefined && value !== null) {
    const keys = plain(value) ? Object.keys(value) : []
    if (
      !plain(value) ||
      keys.length !== 2 ||
      typeof value.from !== 'string' ||
      typeof value.to !== 'string' ||
      !time.test(value.from) ||
      !time.test(value.to) ||
      value.from === value.to
    )
      hours = bad('hours', 'needs two different 24 hour US Eastern times as HH:MM', null)
    else hours = { from: value.from, to: value.to }
  }

  let acknowledged = null
  const ack = input.acknowledged
  if (ack !== undefined && ack !== null) {
    const at = plain(ack) && (typeof ack.at === 'string' || isNumber(ack.at)) ? new Date(ack.at) : null
    if (
      !plain(ack) ||
      Object.keys(ack).length !== 2 ||
      typeof ack.version !== 'string' ||
      !/^[a-z0-9.-]{1,40}$/i.test(ack.version) ||
      !at ||
      !Number.isFinite(at.getTime())
    )
      acknowledged = bad('acknowledged', 'needs a statement version and a time', null)
    else acknowledged = { version: ack.version, at: at.toISOString() }
  }

  return {
    prefs: {
      version: schemaVersion,
      budgetUsd,
      perSideUsd,
      maxHeldPerLegUsd,
      markets,
      depthPct,
      bidStopHours,
      requoteSeconds,
      hours,
      families,
      familyWeights,
      rankWeights,
      pick,
      manualMarkets,
      excludeMarkets,
      dailyLossStopUsd,
      hourlyLossStopUsd,
      pullMovePct,
      calmSeconds,
      acknowledged,
    },
    warnings,
  }
}

/**
 * Every bound resolved to a number for one set of choices (a prefs object, or a budget alone), for a settings panel:
 * { [key]: { min, max } }, with bidStopHours as { min: { [family]: hours }, max }.
 */
export function boundsFor(policy, prefsOrBudget) {
  const input = plain(prefsOrBudget) ? prefsOrBudget : { budgetUsd: prefsOrBudget }
  const { prefs } = validatePreferences(
    Object.fromEntries(Object.entries(input).filter(([key]) => fileKeys.includes(key) && key !== 'version')),
    { policy, strict: false }
  )
  const l = policy.limits
  const range = (pair) => ({ min: pair[0], max: pair[1] })
  return {
    budgetUsd: range(l.budgetUsd),
    perSideUsd: range(l.perSideUsd),
    maxHeldPerLegUsd: { min: l.maxHeldPerLegUsd[0], max: Math.min(l.maxHeldPerLegUsd[1], prefs.perSideUsd) },
    markets: range(l.markets),
    depthPct: range(l.depthPct),
    bidStopHours: { min: Object.fromEntries(familyKeys.map((f) => [f, closeHours(f, policy)])), max: l.bidStopHoursMax },
    requoteSeconds: range(l.requoteSeconds),
    familyWeights: range(l.familyWeight ?? [0, 3]),
    rankWeights: range(l.rankWeight ?? [0, 3]),
    manualMarkets: { min: 0, max: l.manualMarketsMax },
    excludeMarkets: { min: 0, max: l.excludeMarketsMax ?? 20 },
    dailyLossStopUsd: { min: l.lossStopMinUsd, max: round2(prefs.budgetUsd * l.dailyLossShareMax) },
    hourlyLossStopUsd: { min: Math.min(l.lossStopMinUsd, prefs.dailyLossStopUsd), max: prefs.dailyLossStopUsd },
    pullMovePct: range(l.pullMovePct),
    calmSeconds: range(l.calmSeconds),
  }
}

/** What GET /preferences returns: { prefs, bounds, schema, warnings }. */
export const preferencesView = ({ prefs, warnings }, policy) => ({
  prefs,
  bounds: boundsFor(policy, prefs),
  schema: schemaFor(policy),
  warnings,
})

/**
 * Whether a run may start with these settings: the current risk statement must be acknowledged.
 * Returns { ok: true } or { ok: false, code: 'acknowledgement', message }.
 */
export function startCheck(prefs, { version = riskStatementVersion } = {}) {
  if (prefs?.acknowledged?.version === version) return { ok: true }
  return {
    ok: false,
    code: 'acknowledgement',
    message: 'Read the risk statement and tick the acknowledgement before starting.',
  }
}

/** The saved choices, or the defaults when there is no file. A damaged file loads as the defaults with a warning. */
export function loadPreferences(file = preferencesFile, policy) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return validatePreferences({}, { policy, strict: false })
    throw error
  }
  let data
  try {
    data = JSON.parse(text)
  } catch {
    const result = validatePreferences({}, { policy, strict: false })
    result.warnings.unshift('The preferences file could not be read; using the defaults.')
    return result
  }
  return validatePreferences(data, { policy, strict: false })
}

/** Validate strictly, then write only schema keys, atomically, readable by this user alone. */
export function savePreferences(file = preferencesFile, prefs, policy) {
  const result = validatePreferences(prefs, { policy, strict: true })
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  try {
    // Written and flushed to disk before the rename, so a crash leaves the old file or the new one, never half.
    const fd = openSync(temp, 'w', 0o600)
    try {
      writeSync(fd, JSON.stringify(result.prefs, null, 2) + '\n')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    // Another program holding the file open can make the rename fail briefly on Windows: retry, then give up.
    for (let attempt = 1; ; attempt++) {
      try {
        renameSync(temp, file)
        break
      } catch (error) {
        if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) throw error
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * attempt)
      }
    }
  } catch (error) {
    // Never leave the temp file behind.
    try {
      unlinkSync(temp)
    } catch {}
    throw error
  }
  return result
}
