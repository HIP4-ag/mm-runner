// The loop's brain for one market: which orders should rest right now, and which resting orders to keep.
// Pure functions, no network and no clock reads. Every number comes from the policy or the user's own settings
// passed in; the hard safety rules (start block, forced pre-game exit with the empty-book guard, never sell more than
// held, exit floor, never rest a bid at the best price) are plain code here, in exit-guard.mjs and in the engine.
import { bandFractionBids, slotFraction, tick } from './band-price.mjs'
import { bidStopFor, entryGate, pullCheck, startBlocked } from './guards.mjs'
import { breakevenPx, floorPx, exitAsk, sellMakerFeeRate, sellTakerFeeRate } from './inventory.mjs'
import { exitPhase, forceAtOf, forcedSell, laterPhase } from './exit-guard.mjs'
import { minOrderUsd as venueMinOrderUsd } from '../../lib/mm/testnet.mjs'

const ticks = (px) => Math.round(px / tick)
const sameShares = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-9
const fromTicks = (n) => Number((n * tick).toFixed(5))
const oneTicks = ticks(1)
const isPx = (value) => Number.isFinite(value) && value > 0 && value < 1

export const emptyMarketState = () => ({ pull: { refMid: null, lastMoveAt: null }, flattened: {} })

/**
 * Kept so existing callers still work. Forced sells are no longer one shot: they are planned again on every pass in
 * the force and sweep stages, so this mark no longer changes what planMarket returns.
 */
export const markFlattened = (state, legIdx, start) => ({
  ...state,
  flattened: { ...(state?.flattened ?? {}), [legIdx]: start },
})

/**
 * The book each leg really trades against. A NO ask at a is a YES buyer at 1 - a and a NO bid at q is a YES seller
 * at 1 - q, so for each leg: effectiveBid = max(bestBid, 1 - other.bestAsk), effectiveAsk = min(bestAsk,
 * 1 - other.bestBid). Missing sides stay NaN. Sizes follow the side that sets the price (summed on a tie).
 */
export function effectiveTops(books) {
  const tops = [books?.[0] ?? {}, books?.[1] ?? {}]
  return tops.map((own, i) => {
    const other = tops[1 - i]
    const pick = (ownPx, ownSz, impliedPx, impliedSz, better) => {
      const a = Number.isFinite(ownPx) ? ticks(ownPx) : NaN
      const b = Number.isFinite(impliedPx) && impliedPx > 0 && impliedPx < 1 ? ticks(impliedPx) : NaN
      if (!Number.isFinite(b)) return [Number.isFinite(a) ? ownPx : NaN, Number(ownSz) || 0]
      if (!Number.isFinite(a) || better(b, a)) return [fromTicks(b), Number(impliedSz) || 0]
      if (a === b) return [ownPx, (Number(ownSz) || 0) + (Number(impliedSz) || 0)]
      return [ownPx, Number(ownSz) || 0]
    }
    const [bestBid, bestBidSz] = pick(own.bestBid, own.bestBidSz, 1 - other.bestAsk, other.bestAskSz, (x, y) => x > y)
    const [bestAsk, bestAskSz] = pick(own.bestAsk, own.bestAskSz, 1 - other.bestBid, other.bestBidSz, (x, y) => x < y)
    return { ...own, bestBid, bestAsk, bestBidSz, bestAskSz }
  })
}

/**
 * Top of one l2Book as { bestBid, bestAsk, bestBidSz, bestAskSz, time }. A missing side is NaN. Throws when the
 * book is for another coin, from the future or older than maxAgeMs, so the caller can pull that market's bids.
 * maxAgeMs may be Infinity for a live websocket book whose freshness the feed already vouches for.
 */
export function bookTop(book, coin, now, maxAgeMs = 6000) {
  if (
    book?.coin !== coin ||
    !Number.isSafeInteger(book.time) ||
    book.time > now + 1000 ||
    now - book.time > maxAgeMs
  )
    throw Error('Waiting for a fresh book.')
  const bid = book.levels?.[0]?.[0]
  const ask = book.levels?.[1]?.[0]
  const bestBid = Number(bid?.px)
  const bestAsk = Number(ask?.px)
  return {
    bestBid: bestBid > 0 && bestBid < 1 ? bestBid : NaN,
    bestAsk: bestAsk > 0 && bestAsk < 1 ? bestAsk : NaN,
    bestBidSz: Number(bid?.sz) || 0,
    bestAskSz: Number(ask?.sz) || 0,
    time: book.time,
  }
}

const cleanSide = (rows, bids) =>
  (Array.isArray(rows) ? rows : [])
    .map((l) => ({ px: Number(l?.px), sz: Number(l?.sz) }))
    .filter((l) => isPx(l.px) && l.sz > 0)
    .sort((a, b) => (bids ? b.px - a.px : a.px - b.px))

/** Every level of one l2Book as { bids: [{ px, sz }], asks: [{ px, sz }] }, best first. Same checks as bookTop. */
export function bookLevels(book, coin, now, maxAgeMs = 6000) {
  bookTop(book, coin, now, maxAgeMs)
  return { bids: cleanSide(book.levels?.[0], true), asks: cleanSide(book.levels?.[1], false) }
}

/** The top of a { bids, asks } pair in the bookTop shape (time left out). */
export function topOfLevels(levels) {
  const bid = cleanSide(levels?.bids, true)[0]
  const ask = cleanSide(levels?.asks, false)[0]
  return { bestBid: bid?.px ?? NaN, bestAsk: ask?.px ?? NaN, bestBidSz: bid?.sz ?? 0, bestAskSz: ask?.sz ?? 0 }
}

// Sum levels that share a tick, best first.
function merge(rows, bids) {
  const at = new Map()
  for (const l of rows) at.set(ticks(l.px), (at.get(ticks(l.px)) ?? 0) + l.sz)
  return [...at.entries()].map(([t, sz]) => ({ px: fromTicks(t), sz })).sort((a, b) => (bids ? b.px - a.px : a.px - b.px))
}

/** effectiveTops for full books: each leg's own levels plus the levels the other leg implies (1 - px). */
export function effectiveLevels(levels) {
  const legs = [0, 1].map((i) => ({ bids: cleanSide(levels?.[i]?.bids, true), asks: cleanSide(levels?.[i]?.asks, false) }))
  return legs.map((own, i) => {
    const other = legs[1 - i]
    const flip = (rows) => rows.map((l) => ({ px: fromTicks(oneTicks - ticks(l.px)), sz: l.sz })).filter((l) => isPx(l.px))
    return { bids: merge([...own.bids, ...flip(other.asks)], true), asks: merge([...own.asks, ...flip(other.bids)], false) }
  })
}

// Our own size resting at one price on one leg and side.
const ownAt = (restingOwn, legIdx, bid, px) =>
  (restingOwn ?? [])
    .filter((o) => o.legIdx === legIdx && Boolean(o.b) === bid && Number.isFinite(o.px) && ticks(o.px) === ticks(px))
    .reduce((sum, o) => sum + (Number(o.sz) || 0), 0)

/**
 * The two leg tops with our own resting orders taken out, so our orders never count as the market. With only the
 * top known, a top level made of our own size alone reads as unknown (NaN): the next level is not visible.
 */
export function withoutOwn(books, restingOwn = []) {
  return [0, 1].map((i) => {
    const top = books?.[i] ?? {}
    const side = (px, sz, bid) => {
      if (!Number.isFinite(px)) return [px, Number(sz) || 0]
      const mine = ownAt(restingOwn, i, bid, px)
      if (!mine) return [px, Number(sz) || 0]
      const left = (Number(sz) || 0) - mine
      return left > 1e-9 ? [px, left] : [NaN, 0]
    }
    const [bestBid, bestBidSz] = side(top.bestBid, top.bestBidSz, true)
    const [bestAsk, bestAskSz] = side(top.bestAsk, top.bestAskSz, false)
    return { ...top, bestBid, bestAsk, bestBidSz, bestAskSz }
  })
}

/** withoutOwn for full books: [{ bids, asks }, { bids, asks }]. */
export function withoutOwnLevels(levels, restingOwn = []) {
  return [0, 1].map((i) => {
    const strip = (rows, bid) =>
      cleanSide(rows, bid)
        .map((l) => ({ px: l.px, sz: l.sz - ownAt(restingOwn, i, bid, l.px) }))
        .filter((l) => l.sz > 1e-9)
    return { bids: strip(levels?.[i]?.bids, true), asks: strip(levels?.[i]?.asks, false) }
  })
}

/**
 * The tops planMarket prices against: our own resting orders taken out, then the effective book of each leg. Record
 * exit-guard samples from these, so the reference is built from the same book the forced sell is checked against.
 * levels (optional) as in planMarket.
 */
export const marketTops = (books, restingOwn = [], levels) =>
  Array.isArray(levels)
    ? effectiveLevels(withoutOwnLevels(levels, restingOwn)).map(topOfLevels)
    : effectiveTops(withoutOwn(books, restingOwn))

const held = (pos) => Number(pos?.shares) > 0

/** YES mid of the effective book, or NaN when it is one-sided. */
export function yesMid(books) {
  const [yes] = effectiveTops(books)
  return yes.bestBid < yes.bestAsk ? (yes.bestBid + yes.bestAsk) / 2 : NaN
}

/**
 * planMarket returns { desired: [{ legIdx, b, px, sz, tif, role, floor? }], holds: [{ legIdx, code, message }], phase,
 * state, status, reason }.
 * books: the two leg tops from bookTop (YES, NO), as read. levels (optional): [{ bids, asks }, { bids, asks }] from
 * bookLevels, for the depth a forced sell may count; without them only the top level counts. Our own resting orders
 * (restingOwn) are taken out of both, then the effective book of each leg is worked out here.
 * mid and width are on the YES price (use yesMid); with our own orders resting the mid is recomputed without them.
 * position0/1 are ledger positions or undefined. available: venue shares per leg.
 * phase (optional): from exitPhase; the later of it and the phase computed from market.start wins. forceAt
 * (optional): forceAtOf. samples: [samples0, samples1] from recordSample, one list per leg.
 * bidBlock: null or { code, message }: no new bids while set; exits and forced sells run whatever it says. The old
 * booleans still work and fold into it: exitOnly (code 'exit-only'), hoursOpen false ('hours'), lossBreached
 * ('loss-day').
 * lossBudgetLeftUsd: the part of the daily loss stop this market's resting exits may still use, per held leg.
 * feeRates: { buy, sellMaker, sellTaker } as fractions including the builder rate (inventory.feeRatesFor).
 * filled: one of our orders on this market filled since the last plan (counts as a trade through).
 *
 * Rules: 'started' places nothing. 'force' and 'sweep' send a forced sell per held leg (exit-guard forcedSell) or
 * report a hold, keeping a resting exit ask for a held leg on hold. Otherwise exits rest and slide from breakeven to
 * their floor between slideStartMs before the start and forceAt. Bids only in 'open' with no bid block, never at or
 * in front of the best bid and never closer to the mid than the smallest allowed depth.
 */
export function planMarket({
  now,
  market,
  books,
  levels,
  mid,
  width,
  fraction = undefined,
  settings,
  policy,
  position0,
  position1,
  state = emptyMarketState(),
  restingOwn = [],
  phase: givenPhase,
  forceAt: givenForceAt,
  samples = [[], []],
  bidBlock = null,
  lossBreached = false,
  hoursOpen = true,
  lossBudgetLeftUsd = 0,
  available = [0, 0],
  feeRates = { buy: 0, sellMaker: sellMakerFeeRate, sellTaker: sellTakerFeeRate },
  filled = false,
  exitOnly = false,
  perSideUsd = settings?.perSideUsd,
  minOrderUsd = venueMinOrderUsd,
}) {
  const g = policy.guards
  const next = { pull: { ...(state?.pull ?? {}) }, flattened: { ...(state?.flattened ?? {}) } }
  const positions = [position0, position1]
  const holds = []

  const computed = exitPhase({ start: market.start, now, family: market.family, policy })
  const phase = startBlocked(market.start, now) ? 'started' : givenPhase ? laterPhase(givenPhase, computed) : computed
  const done = (desired, status, reason) => ({ desired, holds, phase, state: next, status, reason })

  // Rule 1: at or after start minus 60 s nothing is sent. Orders are cancelled; shares stay and are reported.
  if (phase === 'started')
    return done([], 'stopped', positions.some(held) ? 'The market starts within a minute. Sell any shares left by hand.' : 'The market starts within a minute.')

  const block =
    bidBlock ??
    (exitOnly
      ? { code: 'exit-only', message: 'Ranked out for now. Only your shares are offered.' }
      : !hoursOpen
        ? { code: 'hours', message: 'Outside your quoting hours.' }
        : lossBreached
          ? { code: 'loss-day', message: 'Your daily loss stop is reached. No new bids.' }
          : null)

  // Every price below is set against the book each leg really trades against, sibling-implied levels included and
  // our own resting orders taken out.
  const ownLevels = Array.isArray(levels) ? effectiveLevels(withoutOwnLevels(levels, restingOwn)) : null
  const eff = ownLevels ? ownLevels.map(topOfLevels) : marketTops(books, restingOwn)
  const legLevels = (i) =>
    ownLevels?.[i] ?? {
      bids: isPx(eff[i].bestBid) ? [{ px: eff[i].bestBid, sz: eff[i].bestBidSz }] : [],
      asks: isPx(eff[i].bestAsk) ? [{ px: eff[i].bestAsk, sz: eff[i].bestAskSz }] : [],
    }
  const quoteMid = restingOwn.length || ownLevels ? (eff[0].bestBid < eff[0].bestAsk ? (eff[0].bestBid + eff[0].bestAsk) / 2 : NaN) : mid

  const desired = []
  const notes = []
  const forceAt = Number.isFinite(givenForceAt) ? givenForceAt : forceAtOf({ start: market.start, family: market.family, policy })
  const slideStartAt = market.start - g.exit.slideStartMs
  const forcing = phase === 'force' || phase === 'sweep'

  // Rule 2: exits first, independent of every bid gate and every bid block.
  positions.forEach((pos, legIdx) => {
    if (!held(pos)) return
    const leg = eff[legIdx]
    const shares = Number(available[legIdx]) || 0
    if (forcing) {
      const forced = forcedSell({
        phase,
        pos,
        top: leg,
        levels: legLevels(legIdx),
        samples: samples?.[legIdx] ?? [],
        now,
        forceAt,
        policy,
        availableShares: shares,
        minOrderUsd,
      })
      if (forced.order) {
        const o = forced.order
        desired.push({ legIdx, b: false, px: o.px, sz: o.sz, tif: 'Ioc', role: o.role, floor: o.floor })
        return
      }
      if (forced.hold) holds.push({ legIdx, ...forced.hold })
    }
    const breakeven = breakevenPx(pos, feeRates.sellMaker)
    const floor = floorPx(pos, {
      maxExitLossFraction: g.maxExitLossFraction,
      lossBudgetLeftUsd,
      takerFeeRate: feeRates.sellTaker,
    })
    const ask = exitAsk({ pos, leg, now, flattenStartAt: slideStartAt, flattenEndAt: forceAt, floor, breakeven, availableShares: shares })
    if (!ask) return notes.push('No valid price to offer your shares right now.')
    if (ask.px * ask.sz < minOrderUsd)
      return notes.push('Your shares on this market are worth less than the smallest order the exchange accepts.')
    desired.push({ legIdx, b: false, px: ask.px, sz: ask.sz, tif: 'Alo', role: 'exit', floor })
  })

  // Both legs held: a YES ask and a NO ask that sum to 1 or less would match each other. Price the pair so the two
  // sells sum to more than 1. Only resting exits move, and only up, so neither goes below its floor or the bid.
  const sells = desired.filter((d) => !d.b)
  if (sells.length === 2) {
    let short = oneTicks + 1 - (ticks(sells[0].px) + ticks(sells[1].px))
    const movable = sells.filter((d) => d.tif !== 'Ioc')
    // Two IOCs never rest, so they cannot meet each other.
    if (short > 0 && movable.length) {
      movable.forEach((d, k) => {
        const share = k === movable.length - 1 ? short : Math.ceil(short / movable.length)
        const raised = Math.min(oneTicks - 1, ticks(d.px) + share)
        short -= raised - ticks(d.px)
        d.px = fromTicks(raised)
      })
      if (short > 0) {
        // Cannot be priced apart (both near 1). Offer one leg at a time.
        desired.splice(desired.indexOf(movable.at(-1)), 1)
        notes.push('Both sides are held. One side is offered at a time.')
      }
    }
  }

  if (forcing) {
    const status = holds.length ? 'hold' : desired.length || positions.some(held) ? 'exit only' : 'stopped'
    const reason = holds[0]?.message ?? (desired.some((d) => d.tif === 'Ioc') ? 'Selling your shares before the start.' : notes[0] ?? 'Entries are closed before the start.')
    return done(desired, status, reason)
  }

  // Rule 3: bids, only in the open phase and only when every gate is open.
  const restingBids = restingOwn.filter((o) => o.b).map((o) => ({ leg: o.legIdx, px: o.px }))
  let pulled = false
  let bidReason = null
  if (Number.isFinite(quoteMid)) {
    const check = pullCheck({
      state: next.pull,
      mid: quoteMid,
      restingBids,
      now,
      filled,
      policy,
      moveFraction: settings?.pullMoveFraction,
      calmMs: settings?.calmMs,
    })
    next.pull = check.state
    pulled = check.pull || !check.calm
  } else {
    pulled = true
    bidReason = 'Waiting for a two-sided book.'
  }
  const bidStopMs = bidStopFor({ family: market.family, settings, policy })
  const gate = Number.isFinite(quoteMid)
    ? entryGate({
        mid: quoteMid,
        legs: eff,
        start: market.start,
        now,
        family: market.family,
        hasResting: [0, 1].map((i) => restingBids.some((r) => r.leg === i)),
        policy,
        bidStopMs,
      })
    : { legs: [false, false], reasons: [] }
  const open = [0, 1].filter((i) => gate.legs[i] && !held(positions[i]))
  const [minDepth, maxDepth] = policy.pricing.range
  const depth = Number.isFinite(fraction) ? fraction : settings?.depthFraction
  if (phase !== 'open') bidReason = 'Entries are closed before the start. Only your shares are offered.'
  else if (block) bidReason = block.message
  else if (pulled) bidReason ??= 'The price moved. Bids are paused until it settles.'
  else if (!open.length)
    bidReason =
      gate.reasons[0]?.message ??
      (positions.some(held) ? 'Holding shares. Bids on that side wait until they are sold.' : 'No side can be quoted.')
  else if (!(Number.isFinite(depth) && Number.isFinite(width) && width > 0)) bidReason = 'Your depth setting or the band could not be read.'

  if (!bidReason) {
    const bids = bandFractionBids({ mid: quoteMid, width, fraction: Math.min(maxDepth, Math.max(minDepth, depth)), legs: eff })
    // Hard rule, checked again here: strictly behind the best bid, never closer to the mid than the smallest depth.
    let legs = open.filter((i) => {
      const px = bids.prices[i]
      if (px === null) return false
      const behind = isPx(eff[i].bestBid) && ticks(px) < ticks(eff[i].bestBid)
      const deep = slotFraction(px, i, { mid: quoteMid, width }) >= minDepth - 1e-9
      return behind && deep
    })
    // A YES bid and a NO bid that sum to 1 or more would match each other. The band keeps them apart; this is the
    // backstop.
    if (legs.length === 2 && ticks(bids.prices[0]) + ticks(bids.prices[1]) >= oneTicks) legs = [0]
    if (!legs.length) bidReason = bids.skipped[0]?.message ?? 'No price fits inside the band behind the best bid.'
    const cap = Math.min(perSideUsd, settings.maxHeldPerLegUsd)
    let sz = 0
    // Equal size on both legs when both are open; drop a leg whose order would be under the exchange minimum.
    for (let round = 0; round < 2 && legs.length; round++) {
      sz = Math.min(...legs.map((i) => Math.floor(cap / bids.prices[i] + 1e-9)))
      const fits = legs.filter((i) => sz >= 1 && sz * bids.prices[i] >= minOrderUsd)
      if (fits.length === legs.length) break
      legs = fits
    }
    if (!legs.length && !bidReason)
      bidReason = 'Your size per side is under the smallest order the exchange accepts.'
    for (const legIdx of legs)
      desired.push({ legIdx, b: true, px: bids.prices[legIdx], sz, tif: 'Alo', role: 'bid' })
  }

  const hasBid = desired.some((d) => d.b)
  const hasExit = desired.some((d) => !d.b) || positions.some(held)
  const status = hasBid ? 'quoting' : pulled && !block && phase === 'open' ? 'pulled' : hasExit ? 'exit only' : 'stopped'
  const reason = hasBid ? (notes[0] ?? null) : (bidReason ?? notes[0] ?? null)
  return done(desired, status, reason)
}

/**
 * Which resting orders to keep and which to replace. resting: [{ oid, legIdx, b, px, sz, placedAt }].
 * opts: { now, policy, mid, width, legs: [top, top], force, fraction, minRequoteMs }. legs are the effective tops as
 * read, our own orders included: a bid of ours at the best bid (alone or joined) is at the best price and is
 * replaced. fraction (optional): the user's depth; a bid is kept while its slot is within policy.pricing.hysteresis
 * of it (and inside the allowed range). minRequoteMs (optional): the user's requote patience, never under the
 * policy's minRequoteMs. force is true on a pull or a fill; without it no order is requoted on a timer shorter than
 * that. Returns { cancels: [oid], places: [desired], keeps: [oid] }.
 */
export function diffOrders(resting, desired, { now, policy, mid, width, legs = [], force = false, fraction, minRequoteMs }) {
  let [low, high] = policy.pricing.range
  const spread = policy.pricing.hysteresis
  if (Number.isFinite(fraction) && Number.isFinite(spread)) {
    low = Math.max(low, fraction - spread)
    high = Math.min(high, fraction + spread)
  }
  const minAge = Math.max(policy.requests.minRequoteMs, Number.isFinite(minRequoteMs) ? minRequoteMs : 0)
  const used = new Set()
  const cancels = []
  const keeps = []
  for (const r of resting) {
    const i = desired.findIndex((d, k) => !used.has(k) && d.legIdx === r.legIdx && d.b === r.b && d.tif !== 'Ioc')
    const d = desired[i]
    let keep = false
    if (d && r.b) {
      const top = legs[r.legIdx] ?? {}
      const slot = Number.isFinite(mid) ? slotFraction(r.px, r.legIdx, { mid, width }) : NaN
      const inBand = slot > 0 && slot < 1
      const belowAsk = !Number.isFinite(top.bestAsk) || ticks(r.px) < ticks(top.bestAsk)
      // Hard rule: never at the best price. An unknown best bid cannot prove the bid is behind it.
      const behind = Number.isFinite(top.bestBid) && ticks(r.px) < ticks(top.bestBid)
      const deep = slot >= policy.pricing.range[0] - 1e-9
      const valid = inBand && belowAsk && behind && deep
      if (valid && ticks(r.px) === ticks(d.px) && sameShares(r.sz, d.sz)) keep = true
      else if (valid && slot >= low - 1e-9 && slot <= high + 1e-9 && sameShares(r.sz, d.sz)) keep = true
      else if (valid && !force && now - r.placedAt < minAge) keep = true
    } else if (d && !r.b) {
      if (ticks(r.px) === ticks(d.px) && sameShares(r.sz, d.sz)) keep = true
      // Never keep an exit larger than what should be offered, and never below the new target once it is stale.
      else if (sameShares(r.sz, d.sz) && ticks(r.px) >= ticks(d.px) && now - r.placedAt < minAge) keep = true
    }
    if (keep) {
      used.add(i)
      keeps.push(r.oid)
    } else cancels.push(r.oid)
  }
  return { cancels, places: desired.filter((_, k) => !used.has(k)), keeps }
}
