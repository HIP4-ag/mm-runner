import { bandSnapshot } from './campaign-bands.mjs'
import { bandFractionBids, bandWidth, ceilTick, floorTick } from './band-price.mjs'
import { entryGate } from './guards.mjs'

// Neutral band fraction when the caller gives none: 30 percent of the band half-width, the default depth setting.
// The user's own depth setting is passed in as `fraction`.
const neutralFraction = 0.3

// Reward eligibility for a prospective mainnet quote, checked against Monarch's published rules
// (https://docs.monarch.fast/outcome-liquidity-rewards, read 2026-11-19). Read-only: nothing here signs or submits.
//
// Frontend rule. Monarch scores an order only when it carries the Outcome builder code below, or comes from a
// "whitelisted builder frontend". A Hyperliquid order carries one builder, so an order with hip4.ag's builder code
// earns rewards only if Outcome has whitelisted hip4.ag. The public campaign feed has no field that says so.
// Recorded 2026-11-19: the owner states hip4.ag is whitelisted, and the live hip4.ag site and this runner send the
// same builder address (lib/mm/testnet.mjs `builder`). That is the owner's word, not something read from Monarch:
// set this back to false if Outcome withdraws it or the builder address changes. While it is false every plan is
// blocked: the runner must not present quotes as reward-earning.
export const outcomeBuilder = '0xab5dbc057628bc18523c4cdfc0e1e2ebdbecb704'
export const frontendApproved = true

export const rewardBudgets = [50, 100, 250, 500]
export const minDepth = 50 // USD of raw in-band bid-plus-ask notional, before any multiplier
const minOrder = 10 // USD per order, the exchange minimum
const tick = 1e-5
const edge = 1e-9

const round = (price) => Number(price.toFixed(5))
const usd = (value) => '$' + value.toFixed(2)

/**
 * The two post-only bids a budget buys inside the current scoring band, or the reasons it cannot.
 * row, book, asOf: one campaign from the feed, its YES book and the feed's as_of (see campaign-bands.mjs).
 * feeRate: builder fee as a fraction of notional, reserved from the budget on both orders.
 * Returns { ok, blockers: [{ code, message }], band, quotes, depth, debit, minBudget }.
 *
 * Bids: YES and NO each rest at `fraction` of the band half-width from the mid, always behind the touch (see
 * band-price.mjs). A leg whose price falls outside the band is skipped; with both skipped the plan is blocked as
 * 'touch'. Depth counts each order at the smaller of its two readings (its own cash, or its YES-surface notional),
 * since Monarch does not publish which it uses.
 */
export function planRewardQuotes({
  row,
  book,
  asOf,
  now,
  budget,
  feeRate = 0,
  approved = frontendApproved,
  fraction = neutralFraction,
  allowedLegs = [true, true],
  perSideUsd,
  maxHeldPerLegUsd,
}) {
  const blockers = []
  const block = (code, message) => blockers.push({ code, message })
  const none = { ok: false, blockers, band: null, quotes: [], depth: 0, debit: 0, minBudget: null }

  if (!approved)
    block(
      'frontend',
      "hip4.ag is not confirmed as a whitelisted reward frontend. Monarch only scores orders that carry Outcome's builder code or come from a whitelisted builder."
    )
  if (!rewardBudgets.includes(budget)) {
    block('budget', 'Choose an available budget.')
    return none
  }

  let band
  try {
    // Throws on a stale campaign list or book, a one-sided book, or a midpoint outside the scoring range.
    band = bandSnapshot(row, book, asOf, now)
  } catch (error) {
    block('unverified', error.message)
    return none
  }

  // First and last ticks strictly inside the band.
  const lowest = ceilTick(band.low + tick / 2)
  const highest = floorTick(band.high - tick / 2)
  if (!(lowest <= highest)) {
    block('band', 'The scoring band is too narrow to rest a bid on each side without crossing the book.')
    return { ...none, band }
  }

  // Bids rest at a fraction of the band half-width behind the touch. The NO book is the YES book seen from the
  // other side: a NO bid is a YES ask.
  const params = row.scoring_params
  const width = bandWidth({
    spreadCents: Number(params.baseline_total_spread_cents),
    multiplier: Number(params.settlement_band_multiplier),
  })
  const priced = bandFractionBids({
    mid: band.mid,
    width,
    fraction,
    legs: [
      { bestBid: band.bid, bestAsk: band.ask },
      { bestBid: round(1 - band.ask), bestAsk: round(1 - band.bid) },
    ],
  })
  // allowedLegs comes from entryGate: a leg it shuts (price too low, no book, spread) is not quoted.
  const gated = [0, 1].map((i) => (allowedLegs?.[i] === true ? priced.prices[i] : null))
  const [yes, no] = gated
  const active = gated.filter((price) => price !== null)
  if (!active.length) {
    if (priced.prices.some((price) => price !== null))
      block('gate', 'The entry guards do not allow a bid on either side right now.')
    else block('touch', 'Neither bid can rest behind the best bid and still inside the scoring band.')
    return { ...none, band }
  }

  const pair = active.reduce((sum, price) => sum + price, 0)
  const cost = pair * (1 + feeRate)
  // Each leg's cash stays inside the per-side and held-per-leg limits. A lone leg never takes the whole budget:
  // without a limit it is held to half of it, as one side of a pair.
  const limits = [perSideUsd, maxHeldPerLegUsd].filter((value) => value !== undefined)
  const cap = limits.length ? Math.min(...limits) : active.length === 1 ? budget / 2 : Infinity
  if (!(cap > 0)) {
    block('budget', 'The per-side limit leaves no room for an order.')
    return { ...none, band }
  }
  const shares = Math.floor(Math.min(budget / cost, cap / (Math.max(...active) * (1 + feeRate))) + edge)
  // Each order at the smaller of its cash and its YES-surface notional (a NO bid sits at 1 - no on the YES surface).
  const depthPerShare = (yes ?? 0) + (no === null ? 0 : Math.min(no, 1 - no))
  const depth = shares * depthPerShare
  const needed = Math.max(Math.ceil(minDepth / depthPerShare - edge), Math.ceil(minOrder / Math.min(...active) - edge))
  const minBudget = Math.ceil(needed * cost * 100 - edge) / 100
  const quotes = [
    ...(yes === null ? [] : [{ side: 'YES', price: yes, shares }]),
    ...(no === null ? [] : [{ side: 'NO', price: no, shares }]),
  ]

  if (shares < 1 || Math.min(...active) * shares < minOrder)
    block('order', `Each order must be at least ${usd(minOrder)}. This budget needs ${usd(minBudget)}.`)
  else if (depth < minDepth)
    block(
      'depth',
      `A ${usd(budget)} budget rests ${usd(depth)} inside the band after whole shares and fees. Monarch needs ${usd(minDepth)}, which takes ${usd(minBudget)}.`
    )

  return {
    ok: blockers.length === 0,
    blockers,
    band,
    quotes: blockers.some((entry) => entry.code !== 'frontend') ? [] : quotes,
    depth,
    debit: shares * cost,
    minBudget,
  }
}

/** Every offered budget against one snapshot, so the dashboard only enables the ones the runner will accept. */
export const budgetChoices = (input) =>
  rewardBudgets.map((budget) => {
    const plan = planRewardQuotes({ ...input, budget })

    return { budget, ok: plan.ok, blockers: plan.blockers, depth: plan.depth, debit: plan.debit }
  })

/**
 * One tick of a paper reward run: the quotes that may rest right now. Any failure to verify (feed, book, window,
 * band, depth, frontend) returns no quotes and the reason, so resting quotes are withdrawn on the same tick.
 */
export function rewardTick(input) {
  try {
    const plan = planRewardQuotes(input)

    return plan.ok
      ? { quotes: plan.quotes, held: null, plan }
      : { quotes: [], held: plan.blockers.map((entry) => entry.message).join(' '), plan }
  } catch (error) {
    return { quotes: [], held: error.message || 'Eligibility could not be verified.', plan: null }
  }
}

/**
 * One paper tick for one market with the same entry guards a live run applies: start block, bid stop, midpoint range,
 * leg price and spread, per leg. A shut leg is not quoted; with both shut there are no quotes and the reason is
 * given. Each leg's cash is held to perSideUsd and maxHeldPerLegUsd. Anything unreadable gives no quotes.
 * input is a rewardTick input plus { family, policy } and the market's per-side limits.
 */
export function guardedRewardTick({ family, policy, ...input }) {
  let gate = null
  try {
    const snap = bandSnapshot(input.row, input.book, input.asOf, input.now)
    const p = input.row.scoring_params
    gate = entryGate({
      mid: snap.mid,
      legs: [
        { bestBid: snap.bid, bestAsk: snap.ask },
        { bestBid: round(1 - snap.ask), bestAsk: round(1 - snap.bid) },
      ],
      start: Date.parse(p.scheduled_event_start) || Date.parse(input.row.incentive_end_time),
      now: input.now,
      family,
      hasResting: false,
      policy,
    })
  } catch {
    // An unreadable book or band is reported by the plan below, with its own message.
  }
  if (gate && !gate.legs.some(Boolean))
    return { quotes: [], held: gate.reasons.map((entry) => entry.message).join(' '), plan: null }
  return rewardTick({ ...input, allowedLegs: gate ? gate.legs : [false, false] })
}
