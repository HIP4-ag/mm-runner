// Forced pre-game exit with the empty-book sell guard. Pure functions, no network and no clock reads.
//
// Before a game starts every held share is sold, but never into a collapsed book: a forced sell only goes out on a
// two-sided book with a tight spread, never below a floor of half a trusted reference price, never for more shares
// than are held or available, and never for more than the bids at or above its limit. When any of that fails the
// result is a hold with a plain message, never a bad order.
import { ceilTick, tickInt } from './inventory.mjs'
import { exitGroup, exitTimes, startBlockMs } from './guards.mjs'

export { exitGroup }

const TICKS = 100000
const maxSamples = 5000
const isNum = (value) => typeof value === 'number' && Number.isFinite(value)
const isPx = (value) => isNum(value) && value > 0 && value < 1
const wholeShares = (value) => Math.floor(Math.round(Number(value) * 1e6) / 1e6)
const cents = (px) => `${Number((px * 100).toFixed(3))}c`
const sellByHand = 'Sell by hand before the start.'

/** Order of the phases, earliest first. A later phase is always the stricter one. */
export const phases = Object.freeze(['open', 'closed', 'force', 'sweep', 'started'])

/**
 * Where a market stands against its start. Times come from guards.exitTimes (the policy, never later than the hard
 * floors): [S - close, S - force) closed; [S - force, S - sweep) force; [S - sweep, S - 60 s) sweep; from S - 60 s
 * started. Before S - close it is open. An unknown start or clock reads as started (nothing is placed).
 */
export function exitPhase({ start, now, family, policy }) {
  if (!isNum(start) || !isNum(now)) return 'started'
  const t = exitTimes(family, policy)
  const left = start - now
  if (left <= startBlockMs) return 'started'
  if (left <= t.sweepMs) return 'sweep'
  if (left <= t.forceMs) return 'force'
  if (left <= t.closeMs) return 'closed'
  return 'open'
}

/** The later (stricter) of two phases; an unknown phase counts as started. */
export function laterPhase(a, b) {
  const rank = (p) => (phases.includes(p) ? phases.indexOf(p) : phases.length - 1)
  return phases[Math.max(rank(a), rank(b))]
}

/** When the force stage of a market begins, epoch ms. NaN for an unknown start. */
export const forceAtOf = ({ start, family, policy }) => (isNum(start) ? start - exitTimes(family, policy).forceMs : NaN)

// Bid and ask levels of one leg as [{ px, sz }] with numbers, best first. Without levels, the top alone.
function sideOf(levels, top, side) {
  const raw = levels?.[side === 'bid' ? 'bids' : 'asks']
  const rows = Array.isArray(raw)
    ? raw.map((l) => ({ px: Number(l?.px), sz: Number(l?.sz) }))
    : [{ px: side === 'bid' ? top?.bestBid : top?.bestAsk, sz: Number(side === 'bid' ? top?.bestBidSz : top?.bestAskSz) }]
  const clean = rows.filter((l) => isPx(l.px) && l.sz > 0)
  return clean.sort((a, b) => (side === 'bid' ? b.px - a.px : a.px - b.px))
}

/**
 * Add one book sample of a held leg and drop the old ones. top: the bookTop shape of the leg (the effective book,
 * our own orders taken out). levels (optional): { bids: [{ px, sz }], asks: [{ px, sz }] }. One sample is
 * { at, bid, ask, bidLevels, askLevels } with a missing side as null and the level counts as whole numbers.
 * Returns a new array, oldest first, holding only samples from the last sampleKeepMs. An unknown clock changes
 * nothing.
 */
export function recordSample(samples, { top, levels, now, policy }) {
  const list = Array.isArray(samples) ? samples : []
  const keepMs = policy?.guards?.exit?.sampleKeepMs
  if (!isNum(now) || !isNum(keepMs)) return list.slice()
  const bid = isPx(top?.bestBid) ? top.bestBid : null
  const ask = isPx(top?.bestAsk) ? top.bestAsk : null
  const sample = {
    at: now,
    bid,
    ask,
    bidLevels: bid === null ? 0 : Math.max(1, sideOf(levels, top, 'bid').length),
    askLevels: ask === null ? 0 : Math.max(1, sideOf(levels, top, 'ask').length),
  }
  const kept = list.filter((s) => isNum(s?.at) && s.at >= now - keepMs && s.at <= now)
  kept.push(sample)
  kept.sort((a, b) => a.at - b.at)
  return kept.slice(-maxSamples)
}

const twoSided = (s) => isPx(s?.bid) && isPx(s?.ask) && tickInt(s.bid) < tickInt(s.ask)
const midOf = (s) => (s.bid + s.ask) / 2

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2
}

/**
 * The reference price R of a held leg. The median mid of the trusted samples (two-sided, spread at most
 * trustedSpread) taken in [forceAt - refWindowMs, forceAt], when there are at least refMinSamples of them. Samples
 * taken inside the force stage never count, so selling pressure there cannot move R. Else the entry price (average
 * cost per share). Else nothing. Returns { px, kind: 'median' | 'entry' | null }.
 */
export function reference(samples, { forceAt, entryPx, policy }) {
  const ex = policy?.guards?.exit
  const none = { px: null, kind: null }
  if (!isNum(ex?.refWindowMs) || !isNum(ex?.trustedSpread) || !Number.isInteger(ex?.refMinSamples)) return none
  if (isNum(forceAt)) {
    const mids = (Array.isArray(samples) ? samples : [])
      .filter((s) => isNum(s?.at) && s.at >= forceAt - ex.refWindowMs && s.at <= forceAt && twoSided(s))
      .filter((s) => tickInt(s.ask) - tickInt(s.bid) <= tickInt(ex.trustedSpread))
      .map(midOf)
    if (mids.length >= ex.refMinSamples) return { px: median(mids), kind: 'median' }
  }
  if (isPx(entryPx)) return { px: entryPx, kind: 'entry' }
  return none
}

// The samples of the last stableMs, anchored on the last sample at or before its start, plus the book now: at least
// refMinSamples of them, all two-sided, the anchor no older than twice stableMs, and every mid within stableRange.
function steady(samples, { now, top, policy }) {
  const ex = policy.guards.exit
  const { stableMs, stableRange } = ex.noRef
  const from = now - stableMs
  const sorted = (Array.isArray(samples) ? samples : []).filter((s) => isNum(s?.at) && s.at <= now).sort((a, b) => a.at - b.at)
  let anchor = -1
  for (let i = 0; i < sorted.length; i++) if (sorted[i].at <= from) anchor = i
  if (anchor < 0 || sorted[anchor].at < from - stableMs) return false
  const window = sorted.slice(anchor)
  if (window.length < ex.refMinSamples) return false
  const current = { bid: top.bestBid, ask: top.bestAsk }
  const all = [...window, current]
  if (!all.every(twoSided)) return false
  const mids = all.map(midOf)
  return Math.max(...mids) - Math.min(...mids) <= stableRange + 1e-12
}

/**
 * The forced sell of one held leg in the force or sweep stage, or a hold.
 * phase: from exitPhase. pos: the ledger position { shares, cost }. top: the bookTop shape of the leg (the
 * effective book, our own orders taken out). levels (optional): { bids, asks } of that book for depth; without them
 * only the top level counts. samples: from recordSample. forceAt: forceAtOf. availableShares: the venue balance.
 * minOrderUsd: the venue's smallest order (required: without it every forced sell holds).
 *
 * Rules: hold 'book' unless the book is two-sided with a spread of at most maxSpread. floor = ceilTick(
 * refFloorFraction x R); hold 'no-reference' without R. Hold 'below-reference' when the best bid is under the floor.
 * The force-stage limit is max(floor, best bid); the sweep-stage limit is the floor. With R from the entry price the
 * book must also be healthy (tight, deep on both sides, steady for stableMs), else hold 'unhealthy'. The size is the
 * whole shares held, available and bid at or above the limit; hold 'depth' when none, 'dust' under the venue minimum.
 * Returns { order: { px, sz, tif: 'Ioc', role, floor } | null, hold: { code, message } | null }. Outside the force
 * and sweep stages, or with nothing held, both are null.
 */
export function forcedSell({
  phase,
  pos,
  top,
  levels,
  samples = [],
  now,
  forceAt,
  policy,
  availableShares,
  minOrderUsd,
}) {
  if (phase !== 'force' && phase !== 'sweep') return { order: null, hold: null }
  const shares = Number(pos?.shares)
  if (!(shares > 0)) return { order: null, hold: null }
  const hold = (code, text) => ({ order: null, hold: { code, message: `${text} ${sellByHand}` } })

  const ex = policy?.guards?.exit
  const nr = ex?.noRef
  const readable =
    isNum(ex?.maxSpread) &&
    isNum(ex?.refFloorFraction) &&
    ex.refFloorFraction >= 0.5 &&
    isNum(nr?.maxSpread) &&
    isNum(nr?.stableMs) &&
    isNum(nr?.stableRange) &&
    isNum(nr?.askDepthWithin) &&
    isNum(now) &&
    isNum(minOrderUsd) &&
    minOrderUsd > 0
  if (!readable) return hold('policy', 'The forced sale settings could not be read, so nothing was sold.')

  const bid = top?.bestBid
  const ask = top?.bestAsk
  if (!(isPx(bid) && isPx(ask) && tickInt(bid) < tickInt(ask)))
    return hold('book', 'The book is one-sided, so a forced sale could fill far below a fair price.')
  const spread = tickInt(ask) - tickInt(bid)
  if (spread > tickInt(ex.maxSpread))
    return hold('book', `The spread is ${cents(ask - bid)}, wider than ${cents(ex.maxSpread)}, so no forced sale was sent.`)

  const cost = Number(pos.cost)
  const ref = reference(samples, { forceAt, entryPx: cost >= 0 ? cost / shares : NaN, policy })
  if (ref.px === null) return hold('no-reference', 'There is no trusted recent price to protect a forced sale.')
  const floor = ceilTick(ex.refFloorFraction * ref.px)
  if (!(tickInt(floor) >= 1 && tickInt(floor) <= TICKS - 1))
    return hold('no-reference', 'The reference price gives no usable floor.')
  if (tickInt(bid) < tickInt(floor))
    return hold(
      'below-reference',
      `The best bid is ${cents(bid)}, under the lowest allowed price of ${cents(floor)} (half of the recent price ${cents(ref.px)}).`
    )

  const limitTicks = phase === 'force' ? Math.max(tickInt(floor), tickInt(bid)) : tickInt(floor)
  const px = limitTicks / TICKS
  const bids = sideOf(levels, top, 'bid')
  const depth = wholeShares(bids.filter((l) => tickInt(l.px) >= limitTicks).reduce((a, l) => a + l.sz, 0))
  const available = Number(availableShares)
  const lot = Number.isFinite(available) ? wholeShares(Math.min(shares, available)) : 0
  if (!(lot >= 1)) return hold('dust', 'Less than one whole share is available to sell.')

  if (ref.kind === 'entry') {
    const asks = sideOf(levels, top, 'ask')
    const askDepth = asks.filter((l) => tickInt(l.px) <= tickInt(ask) + tickInt(nr.askDepthWithin)).reduce((a, l) => a + l.sz, 0)
    const healthy =
      spread <= tickInt(nr.maxSpread) && depth >= lot && wholeShares(askDepth) >= lot && steady(samples, { now, top, policy })
    if (!healthy)
      return hold(
        'unhealthy',
        'There is no trusted recent price, and the book is not tight, deep and steady enough to sell into.'
      )
  }

  const sz = Math.min(lot, depth)
  if (!(sz >= 1)) return hold('depth', 'No bids rest at or above the lowest allowed price.')
  if (sz * px < minOrderUsd)
    return hold('dust', 'The shares that can be sold now are worth less than the smallest order the exchange accepts.')
  return { order: { px, sz, tif: 'Ioc', role: phase, floor }, hold: null }
}
