// Which markets to quote. Plain rules, no scoring: the user ticks the kinds of market they want and either picks
// markets by hand or lets the runner take the first N eligible ones. Nothing here looks at other participants.

// Futures: a champion or winner market, a touch or rate decision, or a one-ticker price market. Sports patterns are
// tried first and a matchup (vs, v, @, matchday) is never a futures market.
const futuresWords = /\b(touches|champion|winner|rate decision|market cap)\b/i
const priceMarket = /^(?:[a-z0-9]+:)?[A-Z0-9]{2,10} (?:above|below) [$]?[0-9][0-9,]*(?:\.[0-9]+)?[kKmMbBtT]? (?:at|by) \d{4}-\d{2}-\d{2}/
const matchup = /(\bvs?\.?(?=\s)|\s@\s|\bmatchday\b)/i
// Team nicknames that name one league only (checked only on a matchup, so 'Chiefs vs Bills' still places).
const teams = [
  [
    'nba',
    /\b(hawks|celtics|nets|hornets|bulls|cavaliers|cavs|mavericks|nuggets|pistons|warriors|rockets|pacers|clippers|lakers|grizzlies|heat|bucks|timberwolves|pelicans|knicks|thunder|magic|76ers|sixers|suns|trail blazers|blazers|spurs|raptors|jazz|wizards)\b/i,
  ],
  [
    'nfl',
    /\b(ravens|bills|bengals|browns|cowboys|broncos|lions|packers|texans|colts|jaguars|chiefs|raiders|chargers|dolphins|vikings|patriots|saints|eagles|steelers|49ers|seahawks|buccaneers|titans|commanders|falcons|bears)\b/i,
  ],
]
const patterns = [
  ['nba', /\bNBA\b/i],
  ['nfl', /\bNFL\b/i],
  [
    'soccer',
    /\b(premier league|la liga|bundesliga|serie a|ligue 1|champions league|europa league|eredivisie|mls|world cup|matchday|soccer)\b|\bFC\b/i,
  ],
  ['esports', /\b(cs2|counter-strike|league of legends|lol|dota|valorant|pgl|esl|overwatch|rocket league)\b/i],
]

/**
 * The sport a campaign belongs to, from its question name, description and campaign name. Confirmed against the
 * live feed text on 2026-11-19 (NBA and NFL games, CS2 majors, club football matchdays, price and champion
 * markets). Anything it cannot place is 'other'.
 */
export function familyOf({ questionName, description, campaignName } = {}) {
  const parts = [questionName, description, campaignName].filter((part) => typeof part === 'string')
  const text = parts.join(' | ')
  const sport = patterns.find(([, pattern]) => pattern.test(text))?.[0]
  if (matchup.test(text)) return sport ?? teams.find(([, pattern]) => pattern.test(text))?.[0] ?? 'other'
  if (futuresWords.test(text) || parts.some((part) => priceMarket.test(part))) return 'futures'
  return sport ?? 'other'
}

const hourMs = 3600e3
const longFamilies = new Set(['soccer', 'esports'])
const maxPicked = 6 // launch cap, the same as preferences `markets`
const neutralBidStopMs = 3 * hourMs

// The earliest bids may stop: the entry-close time for the family (20 min, or 60 min for soccer and esports). A user's
// bid stop can be later than this, never earlier. Read from policy.guards.exit.times when it is there.
function entryCloseMs(family, policy) {
  const times = policy?.guards?.exit?.times
  const own = longFamilies.has(family) ? times?.long?.closeMs : times?.default?.closeMs
  const floor = longFamilies.has(family) ? 60 * 60e3 : 20 * 60e3
  return Number.isFinite(own) ? Math.max(own, floor) : floor
}
// The user's bid stop for a family, in ms before the start, never under the entry close. settings.bidStopMs is the
// per-family map policy.settingsFor returns (or a function of the family); settings.bidStopHours (the preferences
// value) is accepted too. Anything unusable falls back to 3 hours.
function bidStopMs(family, settings, policy) {
  const map = settings?.bidStopMs
  const hours = settings?.bidStopHours?.[family] ?? settings?.bidStopHours?.other
  const asked =
    typeof map === 'function'
      ? map(family)
      : map && typeof map === 'object'
        ? (map[family] ?? map.other)
        : Number.isFinite(hours)
          ? hours * hourMs
          : neutralBidStopMs
  return Math.max(Number.isFinite(asked) ? asked : neutralBidStopMs, entryCloseMs(family, policy))
}
// The user's weight for a family (0 to 3; 0 or unticked means off). Futures are never taken.
function familyWeightOf(family, settings) {
  if (family === 'futures') return 0
  if (settings?.families && typeof settings.families === 'object' && settings.families[family] === false) return 0
  const map =
    settings?.familyWeights && typeof settings.familyWeights === 'object'
      ? settings.familyWeights
      : settings?.familyWeight && typeof settings.familyWeight === 'object'
        ? settings.familyWeight
        : null
  if (map) {
    const w = map[family] ?? map.other ?? 1
    return Number.isFinite(w) && w > 0 ? w : 0
  }
  return 1
}

const numeric = (value) => (value === null || value === undefined || value === '' ? NaN : Number(value))
const compareId = (a, b) => (a === b ? 0 : String(a).localeCompare(String(b), 'en', { numeric: true }))

function normalizedRank(eligible, settings, network) {
  const rw = settings?.rankWeights
  const poolW = Number.isFinite(rw?.pool) ? Math.max(0, rw.pool) : 1
  const startW = Number.isFinite(rw?.start) ? Math.max(0, rw.start) : 1
  const spreadW = Number.isFinite(rw?.spread) ? Math.max(0, rw.spread) : 1
  const customRank = Boolean(rw && (poolW !== 1 || startW !== 1 || spreadW !== 1))
  const weights = new Set(eligible.map((e) => e.fw))
  const customFamily = weights.size > 1
  if (!customRank && !customFamily) return null

  const pools = eligible.map((e) => e.pool).filter(Number.isFinite)
  const minPool = pools.length ? Math.min(...pools) : 0
  const maxPool = pools.length ? Math.max(...pools) : 0
  const starts = eligible.map((e) => e.start).filter(Number.isFinite)
  const minStart = starts.length ? Math.min(...starts) : 0
  const maxStart = starts.length ? Math.max(...starts) : 0
  const widths = eligible.map((e) => e.spreadMetric).filter(Number.isFinite)
  const minWidth = widths.length ? Math.min(...widths) : 0
  const maxWidth = widths.length ? Math.max(...widths) : 0

  const effectivePoolW = network === 'mainnet' ? poolW : 0
  const denom = effectivePoolW + startW + spreadW || 1
  const scores = new Map()
  for (const e of eligible) {
    const poolNorm =
      network !== 'mainnet' || !Number.isFinite(e.pool)
        ? 0
        : maxPool > minPool
          ? (e.pool - minPool) / (maxPool - minPool)
          : 1
    const startNorm = !Number.isFinite(e.start) ? 0.5 : maxStart > minStart ? (maxStart - e.start) / (maxStart - minStart) : 1
    const spreadNorm = !Number.isFinite(e.spreadMetric)
      ? 0.5
      : maxWidth > minWidth
        ? (e.spreadMetric - minWidth) / (maxWidth - minWidth)
        : 0.5
    const base = (effectivePoolW * poolNorm + startW * startNorm + spreadW * spreadNorm) / denom
    scores.set(e.c.id, e.fw * (0.0001 + base))
  }
  return scores
}

/**
 * Automatic or hand-picked market selection. candidates: [{ id, family, start, pool, width?, spread? }].
 * Eligible: not excluded, family enabled (weight > 0), bid stop not reached, market not started, positive pool on mainnet.
 * When the user customizes familyWeights or rankWeights ({ pool, start, spread }), eligible markets are ordered by a
 * plain normalized score; with uniform neutral defaults, markets sort by quote pool descending then soonest start.
 */
export function autoPick(candidates, settings, { now, network = 'mainnet', policy, only } = {}) {
  const excluded = []
  const eligible = []
  const count = Math.min(maxPicked, Math.max(1, Math.floor(Number(settings?.marketCount ?? settings?.markets ?? 2)) || 1))
  const picked = Array.isArray(only) ? new Set(only) : null
  const blocked = Array.isArray(settings?.excludeMarkets) ? new Set(settings.excludeMarkets) : null
  for (const c of candidates ?? []) {
    const family = c.family ?? 'other'
    const start = numeric(c.start)
    const pool = numeric(c.pool)
    const spreadMetric = numeric(c.width ?? c.spread)
    const fw = familyWeightOf(family, settings)
    if (picked && !picked.has(c.id)) excluded.push({ id: c.id, reason: 'not_picked' })
    else if (!picked && blocked?.has(c.id)) excluded.push({ id: c.id, reason: 'excluded' })
    else if (family === 'futures') excluded.push({ id: c.id, reason: 'futures' })
    else if (!(fw > 0)) excluded.push({ id: c.id, reason: 'family' })
    else if (now !== undefined && !(Number.isFinite(now) && Number.isFinite(start) && start - entryCloseMs(family, policy) > now))
      excluded.push({ id: c.id, reason: 'start' })
    else if (now !== undefined && !(start - bidStopMs(family, settings, policy) > now)) excluded.push({ id: c.id, reason: 'bid_stop' })
    else if (network === 'mainnet' && !(pool > 0)) excluded.push({ id: c.id, reason: 'pool' })
    else eligible.push({ c, start, pool, spreadMetric, fw })
  }
  const scores = normalizedRank(eligible, settings, network)
  eligible.sort((a, b) => {
    if (scores) {
      const diff = (scores.get(b.c.id) ?? 0) - (scores.get(a.c.id) ?? 0)
      if (Math.abs(diff) > 1e-12) return diff
    }
    return (
      (network === 'mainnet' ? b.pool - a.pool : 0) ||
      (Number.isFinite(a.start) && Number.isFinite(b.start) ? a.start - b.start : 0) ||
      compareId(a.c.id, b.c.id)
    )
  })
  const chosen = eligible.slice(0, count).map((e) => e.c)
  for (const e of eligible.slice(count)) excluded.push({ id: e.c.id, reason: 'count' })
  return { chosen, excluded }
}

/**
 * What a ranking caller needs to know about one campaign. Kept so the engine keeps running; the book is no longer read.
 * The second argument (a policy) is accepted and ignored.
 */
export function candidate(input) {
  const { id, family = 'other', mid, width, pool, eventWeight = 1, start = null } = input ?? {}
  if (!(mid > 0 && mid < 1 && width > 0)) throw Error('A midpoint and band width are required.')
  return { id, family, mid, width, pool, eventWeight, start }
}

/**
 * The old entry point, as a thin wrapper over autoPick: { chosen: [{ id, perSideUsd }], excluded }. The user's own
 * per-side size is used for each chosen market, cut to what is left of the budget; a market that cannot get minOwnUsd
 * a side from what is left is excluded as 'budget', and a per-side limit under minOwnUsd excludes everything as
 * 'minimum'. policy and seed are accepted and ignored apart from the entry-close times.
 */
export function rankMarkets(candidates, settings, policy, { minOwnUsd = 0, now, network = 'mainnet' } = {}) {
  const picked = autoPick(candidates, settings, { now, network, policy })
  const excluded = [...picked.excluded]
  const chosen = []
  let left = Number(settings?.budgetUsd)
  for (const c of picked.chosen) {
    const perSide = Math.min(Number(settings?.perSideUsd), left / 2)
    if (!(settings?.perSideUsd > 0 && settings.perSideUsd >= minOwnUsd - 1e-9)) excluded.push({ id: c.id, reason: 'minimum' })
    else if (!(perSide > 0) || perSide < minOwnUsd - 1e-9) excluded.push({ id: c.id, reason: 'budget' })
    else {
      left -= 2 * perSide
      chosen.push({ id: c.id, perSideUsd: perSide })
    }
  }
  return { chosen, excluded }
}
