import { networks } from '../../lib/mm/network.mjs'
import { familyOf } from './market-rank.mjs'

const feed = networks.mainnet.campaigns
const info = networks.mainnet.infoUrl

async function json(url, options) {
  const response = await fetch(url, { ...options, cache: 'no-store', signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw Error('The public market feed is unavailable.')
  return response.json()
}

// The incentive window: on the row itself, or (as the feed publishes pregame campaigns since November 2026) on
// the row's reward epochs. Open only inside a window that is itself still marked incentivized.
const inside = (entry, now) =>
  Date.parse(entry?.incentive_start_time) <= now && Date.parse(entry?.incentive_end_time) > now
export const windowOpen = (row, now) =>
  row?.incentive_start_time || row?.incentive_end_time
    ? inside(row, now)
    : Array.isArray(row?.epochs) &&
      row.epochs.some((epoch) => epoch?.incentive_status === 'incentivized' && inside(epoch, now))

// Rolling staleness window: avoids false failures when the clock crosses a :05 boundary while still rejecting stale feeds.
export const FEED_STALE_MS = 15 * 60_000
export const FEED_FUTURE_SKEW_MS = 30_000

const rollingLabel = /\b(5\s*m(?:in(?:ute)?s?)?|15\s*m(?:in(?:ute)?s?)?|30\s*m(?:in(?:ute)?s?)?|1\s*h(?:r|our)?|hourly)\b/i
const rollingStamp = /\bat\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}):(\d{2})\s*UTC\b/i

/**
 * Rolling 15m / hourly markets are always excluded: they turn over too fast for pre-game LP quoting and carry severe
 * expiry/adverse-selection risk. Scheduled sports matches are checked by label only.
 */
export function isRollingShortMarket(row, now) {
  const names = [row?.market_name, row?.parent_market_name, row?.cadence, row?.interval].filter(
    (v) => typeof v === 'string' && v.length > 0
  )
  if (names.some((text) => rollingLabel.test(text))) return true
  const p = row?.scoring_params
  if (p?.event_time_multiplier_mode === 'scheduled_match') return false
  for (const text of names) {
    const m = rollingStamp.exec(text)
    if (!m) continue
    const [, day, hh, mm] = m
    if (mm === '15' || mm === '30' || mm === '45') return true
    const targetMs = Date.parse(`${day}T${hh}:${mm}:00Z`)
    if (Number.isFinite(targetMs) && Number.isFinite(now) && targetMs > now && targetMs - now <= 75 * 60_000) return true
  }
  const curveStart = Date.parse(p?.band_curve_start)
  const curveEnd = Date.parse(p?.band_curve_end)
  if (Number.isFinite(curveStart) && Number.isFinite(curveEnd) && curveEnd > curveStart && curveEnd - curveStart <= 75 * 60_000)
    return true
  return false
}

/**
 * Expand multi-outcome question rows (`row.outcomes`) when the parent carries `hyperliquid_outcome_id == null`.
 * Child outcomes inherit the parent's status, scoring_params, and window fields; when a child omits `reward_amount_usdc`,
 * the parent's `total_reward_amount_usdc` (or `reward_amount_usdc`) is split evenly across child outcomes.
 */
export function expandMarketRows(markets) {
  const expanded = []
  for (const row of markets ?? []) {
    if (
      row &&
      row.hyperliquid_outcome_id == null &&
      Array.isArray(row.outcomes) &&
      row.outcomes.length > 0
    ) {
      const parentTotal = Number(row.total_reward_amount_usdc ?? row.reward_amount_usdc)
      const splitReward =
        Number.isFinite(parentTotal) && parentTotal > 0 ? String(parentTotal / row.outcomes.length) : null
      for (const child of row.outcomes) {
        if (!child || typeof child !== 'object') continue
        const childName = child.market_name ? String(child.market_name) : ''
        const parentName = row.market_name ? String(row.market_name) : ''
        const label = parentName && childName ? `${parentName} - ${childName}` : childName || parentName
        expanded.push({
          ...row,
          ...child,
          parent_market_id: row.market_id ?? null,
          parent_market_name: parentName || null,
          market_name: label,
          incentive_status: child.incentive_status ?? row.incentive_status,
          scoring_params: child.scoring_params ?? row.scoring_params,
          epochs: child.epochs ?? row.epochs,
          incentive_start_time: child.incentive_start_time ?? row.incentive_start_time,
          incentive_end_time: child.incentive_end_time ?? row.incentive_end_time,
          current_multiplier: child.current_multiplier ?? row.current_multiplier,
          live_event_multiplier:
            child.live_event_multiplier !== undefined ? child.live_event_multiplier : row.live_event_multiplier,
          reward_amount_usdc:
            child.reward_amount_usdc !== undefined && child.reward_amount_usdc !== null
              ? child.reward_amount_usdc
              : splitReward,
        })
      }
    } else {
      expanded.push(row)
    }
  }
  return expanded
}

// Each accepted row is unique by market id: a repeated id drops out.
function selectCampaigns(data, now, accept) {
  const updated = Date.parse(data?.as_of)
  if (
    !(Number.isFinite(updated) && updated <= now + FEED_FUTURE_SKEW_MS && now - updated <= FEED_STALE_MS) ||
    !Array.isArray(data?.markets)
  )
    throw Error('Waiting for a current Monarch campaign list.')
  const unique = new Map()
  for (const row of expandMarketRows(data.markets)) {
    const p = row?.scoring_params
    if (
      row?.incentive_status !== 'incentivized' ||
      !Number.isSafeInteger(row.hyperliquid_outcome_id) ||
      row.hyperliquid_outcome_id < 0 ||
      row.market_id !== 'O' + row.hyperliquid_outcome_id ||
      isRollingShortMarket(row, now) ||
      !windowOpen(row, now) ||
      p?.distance_model !== 'logit' ||
      !(Number(row.current_multiplier) > 0) ||
      !accept(row, p, now)
    )
      continue
    unique.set(row.market_id, unique.has(row.market_id) ? null : row)
  }
  return [...unique.values()].filter(Boolean)
}

export const pregameCampaigns = (data, now) =>
  selectCampaigns(
    data,
    now,
    (row, p, at) => p.event_time_multiplier_mode === 'scheduled_match' && Date.parse(p.scheduled_event_start) > at
  )

// Futures: a price or date market with no game clock. The live feed (read 2026-11-19) has no dedicated futures mode:
// event_time_multiplier_mode is 'none' for these rows but ALSO for sports rows with no published start time, which
// must never be quoted blind. So futures are admitted only through this explicit allowlist of modes, which is EMPTY
// until the feed publishes a dedicated futures marker. A row in an allowed mode must then also have a strict
// price-style name, no start and no in-game multiplier. Add a mode here only after reading it off the live feed.
export const futuresModes = new Set()
// One upper-case ticker (optionally with a venue prefix), a bare number, then a date. Anything with a second word,
// a hyphenated pair, a unit or a team, player or total style word is refused.
const ticker = '(?:[a-z0-9]+:)?[A-Z0-9]{2,10}'
const amount = '[$]?[0-9][0-9,]*(?:\\.[0-9]+)?[kKmMbBtT]?'
const date = '\\d{4}-\\d{2}-\\d{2}'
const priceMarket = new RegExp(`^${ticker} (?:touches|above|below) ${amount} (?:by|at) ${date}`)
const capMarket = new RegExp(`^${ticker} (?:market cap|fdv) (?:above|below) ${amount} (?:by|at) ${date}`)
const sportsStyle =
  /(\bvs?\.?(?=\s)|@|\b(total|totals|over|under|spread|moneyline|points|goals|touchdowns|tds|yards|rebounds|assists|mvp|player|ticket|game|match)\b)/i
export const futuresName = (name) => {
  const text = String(name ?? '')
  return !sportsStyle.test(text) && (priceMarket.test(text) || capMarket.test(text))
}
export const futuresCampaign = (row, p = row?.scoring_params) =>
  futuresModes.has(p?.event_time_multiplier_mode) &&
  (p.scheduled_event_start ?? null) === null &&
  (row.live_event_multiplier ?? null) === null &&
  futuresName(row.market_name)

// Campaigns a reward plan may rank: today's pregame rule, plus futures. Anything live, in-game or of an unknown
// mode is left out.
export const rewardCampaigns = (data, now) =>
  selectCampaigns(
    data,
    now,
    (row, p, at) =>
      (p.event_time_multiplier_mode === 'scheduled_match' && Date.parse(p.scheduled_event_start) > at) ||
      futuresCampaign(row, p)
  )

// The USDC a campaign pays for quoting: the row's reward amount times the quote share of its component weights
// (both published on the row, as decimal strings). Null when either is missing, so the row is not ranked.
export function poolOf(row) {
  const amount = Number(row?.reward_amount_usdc)
  const share = Number(row?.scoring_params?.component_weights?.quote)
  if (row?.reward_amount_usdc == null || row?.scoring_params?.component_weights?.quote == null) return null
  if (!(amount > 0 && share > 0 && share <= 100)) return null
  return (amount * share) / 100
}

export function bandSnapshot(row, book, asOf, now) {
  if (
    book?.coin !== '#' + row.hyperliquid_outcome_id * 10 ||
    !Number.isSafeInteger(book.time) ||
    book.time < now - 6000 ||
    book.time > now + 1000
  )
    throw Error('Waiting for a fresh YES order book.')
  const bid = Number(book.levels?.[0]?.[0]?.px)
  const ask = Number(book.levels?.[1]?.[0]?.px)
  if (!(bid > 0 && bid < ask && ask < 1)) throw Error('Waiting for a two-sided YES order book.')
  const mid = (bid + ask) / 2
  const p = row.scoring_params
  const spread = Number(p.baseline_total_spread_cents)
  const multiplier = Number(p.settlement_band_multiplier)
  const maximum = Number(p.settlement_band_maximum_multiplier)
  const minMid = Number(p.midpoint_min)
  const maxMid = Number(p.midpoint_max)
  if (!(
    spread > 0 &&
    spread < 100 &&
    multiplier >= 1 &&
    multiplier <= maximum &&
    Number.isFinite(maximum) &&
    minMid > 0 &&
    minMid < maxMid &&
    maxMid < 1
  ))
    throw Error('Incomplete Monarch scoring parameters.')
  if (mid < minMid || mid > maxMid) throw Error('The observed YES midpoint is outside the campaign scoring range.')
  const logit = (price) => Math.log(price / (1 - price))
  const logistic = (odds) => 1 / (1 + Math.exp(-odds))
  const width = logit(0.5 + spread / 200) * multiplier
  const low = logistic(logit(mid) - width)
  const high = logistic(logit(mid) + width)
  return {
    id: row.market_id,
    asOf,
    bookTime: book.time,
    bid,
    ask,
    mid,
    low,
    high,
    bidInside: bid > low + 1e-12,
    askInside: ask < high - 1e-12,
  }
}

export async function inspectCampaign(id) {
  const data = await json(feed)
  const campaigns = pregameCampaigns(data, Date.now())
  if (!id) return campaigns.map((row) => ({ id: row.market_id, name: row.market_name }))
  const row = campaigns.find((r) => r.market_id === id)
  if (!row) throw Error('This pregame campaign is no longer available.')
  const book = await json(info, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'l2Book', coin: '#' + row.hyperliquid_outcome_id * 10 }),
  })
  const now = Date.now()
  if (!pregameCampaigns(data, now).includes(row)) throw Error('The campaign window has changed.')
  return bandSnapshot(row, book, data.as_of, now)
}

// The inputs a reward plan needs for one campaign: its feed row, the live YES book and the feed's as_of. The
// campaign list is reused for 15 seconds (it changes in five-minute buckets); the book is always read fresh.
let listed = null
export async function campaignInputs(id) {
  const at = Date.now()
  if (!listed || listed.at < at - 15000) listed = { at, data: await json(feed) }
  let campaigns
  try {
    campaigns = pregameCampaigns(listed.data, at)
  } catch (error) {
    // A reused list goes stale the moment a new five-minute bucket starts: read it again once before giving up.
    if (listed.at === at) throw error
    listed = { at, data: await json(feed) }
    campaigns = pregameCampaigns(listed.data, at)
  }
  const data = listed.data
  const row = campaigns.find((r) => r.market_id === id)
  if (!row) throw Error('This pregame campaign is no longer available.')
  const book = await json(info, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'l2Book', coin: '#' + row.hyperliquid_outcome_id * 10 }),
  })
  return { row, book, asOf: data.as_of, name: row.market_name }
}

// The live YES books of several campaigns (ids like 'O123', or the numeric outcome id), read four at a time.
// Returns Map<'O123', book>. A book that cannot be read is left out; bandSnapshot checks freshness.
export async function campaignBooks(ids) {
  const wanted = [...new Set(ids.map((id) => (typeof id === 'number' ? 'O' + id : String(id))))].filter((id) =>
    /^O\d+$/.test(id)
  )
  const books = new Map()
  let next = 0
  const worker = async () => {
    while (next < wanted.length) {
      const id = wanted[next++]
      try {
        books.set(
          id,
          await json(info, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'l2Book', coin: '#' + Number(id.slice(1)) * 10 }),
          })
        )
      } catch {}
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, wanted.length) }, worker))
  return books
}

// The whole campaign list once, for ranking. Reused for 15 seconds like campaignInputs.
export async function campaignList() {
  const at = Date.now()
  if (!listed || listed.at < at - 15000) listed = { at, data: await json(feed) }
  let rows
  try {
    rows = rewardCampaigns(listed.data, at)
  } catch (error) {
    if (listed.at === at) throw error
    listed = { at, data: await json(feed) }
    rows = rewardCampaigns(listed.data, at)
  }
  return { rows, asOf: listed.data.as_of }
}

// The raw feed with no five-minute bucket check, reused for 15 seconds, with the time it was published. mainnetCatalog
// and campaignTransition judge how old it is, so a late bucket reads as stale, not as an error. Throws when unreadable.
let rawListed = null
export async function campaignFeed() {
  const at = Date.now()
  if (!rawListed || rawListed.at < at - 15000) rawListed = { at, data: await json(feed) }
  const data = rawListed.data
  const asOf = Date.parse(data?.as_of)
  if (!Array.isArray(data?.markets) || !Number.isFinite(asOf)) throw Error('The public market feed is unavailable.')
  return { data, asOf }
}

const parts = (text) =>
  Object.fromEntries(
    String(text ?? '')
      .split('|')
      .map((f) => [f.slice(0, f.indexOf(':')), f.slice(f.indexOf(':') + 1)])
  )
// 'YYYYMMDD-HHMM' in UTC, as the exchange writes scheduledStart.
const metaTime = (text) => {
  const s = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(String(text ?? ''))
  return s ? Date.UTC(+s[1], +s[2] - 1, +s[3], +s[4], +s[5]) : NaN
}
// The exchange's own start for an outcome: scheduledStart on the outcome, else on the question that lists it.
function metaStart(meta, id) {
  const outcome = meta?.outcomes?.find((o) => o.outcome === id)
  const direct = metaTime(parts(outcome?.description).scheduledStart)
  if (Number.isFinite(direct)) return direct
  const question = meta?.questions?.find((q) => q.fallbackOutcome === id || q.namedOutcomes?.includes(id))
  return metaTime(parts(question?.description).scheduledStart)
}
const logit = (p) => Math.log(p / (1 - p))
// Same half-width as bandSnapshot and band-price.bandWidth, kept here so this file does not depend on pricing code.
const halfWidth = (p) => logit(0.5 + Number(p.baseline_total_spread_cents) / 200) * Number(p.settlement_band_multiplier)
// The end of the window that is open now: the row's own, or the open reward epoch's.
function windowEnd(row, now) {
  if (row?.incentive_start_time || row?.incentive_end_time) return Date.parse(row.incentive_end_time)
  const open = (row?.epochs ?? []).find((e) => e?.incentive_status === 'incentivized' && inside(e, now))
  return open ? Date.parse(open.incentive_end_time) : NaN
}

/**
 * The campaigns a mainnet run may quote, built from the Monarch feed and the exchange's outcomeMeta. Returns the entries
 * and, for every row left out, the reason: { entries, excluded: [{ id, reason }] }. Reasons: status, id, duplicate,
 * window, model, multiplier, params, in-play, mode, no-start, started, no-end-time, futures-off.
 *
 * entry = { id, marketId, start, windowEnd, family, label, pool, eventWeight, width, midMin, midMax, row }
 *   id         the numeric outcome id (what books and orders use); marketId is the feed's 'O123'
 *   start      sports: the earlier of the feed's scheduled_event_start and the outcomeMeta scheduledStart (ms)
 *              futures: the end of the window, and only with one (no end time is excluded as 'no-end-time')
 *   windowEnd  when the open reward window ends (ms), or NaN when the feed gives none
 *   pool       the USDC the quote component pays (poolOf), or null when the row does not publish it
 * Futures are still off: futuresModes is empty, so they leave as 'futures-off' until the feed has a futures marker.
 * Unknown or in-game modes are excluded. Nothing here reads the five-minute bucket; see campaign-watch.mjs.
 */
export function mainnetCatalogReport({ feed: data, meta = null, now }) {
  if (!Array.isArray(data?.markets)) throw Error('The public market feed is unavailable.')
  const entries = []
  const excluded = []
  const seen = new Set()
  const repeated = new Set() // an id that appears twice drops out entirely, as selectCampaigns does
  for (const row of expandMarketRows(data.markets)) {
    const id = row?.hyperliquid_outcome_id
    const skip = (reason) => excluded.push({ id: Number.isSafeInteger(id) ? id : null, reason })
    const p = row?.scoring_params
    const midMin = Number(p?.midpoint_min)
    const midMax = Number(p?.midpoint_max)
    if (row?.incentive_status !== 'incentivized') skip('status')
    else if (!Number.isSafeInteger(id) || id < 0 || row.market_id !== 'O' + id) skip('id')
    else if (seen.has(id)) {
      repeated.add(id)
      skip('duplicate')
    }
    else if (isRollingShortMarket(row, now)) skip('rolling')
    else if (!windowOpen(row, now)) skip('window')
    else if (p?.distance_model !== 'logit') skip('model')
    else if (!(Number(row.current_multiplier) > 0)) skip('multiplier')
    else if (!(halfWidth(p) > 0 && midMin > 0 && midMin < midMax && midMax < 1)) skip('params')
    else {
      seen.add(id)
      const end = windowEnd(row, now)
      let start
      let family
      let reason = null
      if (p.event_time_multiplier_mode === 'scheduled_match') {
        if (row.live_event_multiplier != null) reason = 'in-play'
        else {
          const times = [Date.parse(p.scheduled_event_start), metaStart(meta, id)].filter(Number.isFinite)
          start = times.length ? Math.min(...times) : NaN
          if (!Number.isFinite(start)) reason = 'no-start'
          else if (!(start > now)) reason = 'started'
          family = familyOf({
            questionName: row.market_name,
            description: parts(meta?.outcomes?.find((o) => o.outcome === id)?.description).competition,
          })
        }
      } else if (futuresCampaign(row, p)) {
        start = end
        family = 'futures'
        if (!Number.isFinite(end)) reason = 'no-end-time'
        else if (!(end > now)) reason = 'started'
      } else if (p.event_time_multiplier_mode === 'none' && futuresName(row.market_name)) {
        // Looks like a price market, but the feed has no futures marker yet: off.
        reason = 'futures-off'
      } else reason = 'mode'
      if (reason) skip(reason)
      else
        entries.push({
          id,
          marketId: row.market_id,
          start,
          windowEnd: end,
          family,
          label: row.market_name,
          pool: poolOf(row),
          eventWeight: Number(row.current_multiplier),
          width: halfWidth(p),
          midMin,
          midMax,
          row,
        })
    }
  }
  return {
    entries: entries.filter((e) => !repeated.has(e.id)),
    excluded: [...excluded, ...entries.filter((e) => repeated.has(e.id)).map((e) => ({ id: e.id, reason: 'duplicate' }))],
  }
}

export const mainnetCatalog = (input) => mainnetCatalogReport(input).entries
