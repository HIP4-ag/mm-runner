// Pure position ledger and exit pricing for the local runner. No I/O, no clock reads.
// Prices are on the 1e-5 tick and always handled as integers of ticks when compared.
// Shares are handled as integers of 1e-6 share when compared.

export const sellMakerFeeRate = 0.00055
export const sellTakerFeeRate = 0.0011 // confirm on testnet, owner decision O4
/** Buys of outcome shares pay no exchange fee: only the builder fee. */
export const buyExchangeFeeRate = 0

const TICK = 1e-5
const TICKS = 100000
const SHARE_UNITS = 1e6
const MONEY_UNITS = 1e8

// Own tick helpers. Values are snapped to 1e-6 of a tick first so a binary float that is
// a hair off an exact tick does not move the result by a whole tick.
const snap = (ticks) => Math.round(ticks * 1e6) / 1e6
export const tickInt = (p) => Math.round(p * TICKS)
export const roundTick = (p) => Math.round(snap(p * TICKS)) / TICKS
export const floorTick = (p) => Math.floor(snap(p * TICKS)) / TICKS
export const ceilTick = (p) => Math.ceil(snap(p * TICKS)) / TICKS

const units = (shares) => Math.round(shares * SHARE_UNITS)
const fromUnits = (u) => u / SHARE_UNITS
const money = (x) => Math.round(x * MONEY_UNITS) / MONEY_UNITS
const num = (x) => (x === null || x === undefined || x === '' ? NaN : Number(x))

export const utcDay = (now) => new Date(now).toISOString().slice(0, 10)

export function emptyLedger(now) {
  return { positions: {}, filled: {}, day: utcDay(now), realizedUsd: 0 }
}

// Shape check used before a ledger is trusted (also by the journal on load and save).
export function isLedger(x) {
  const own = (o) => o && typeof o === 'object' && !Array.isArray(o)
  if (!own(x) || !own(x.positions) || !own(x.filled)) return false
  if (typeof x.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(x.day)) return false
  if (typeof x.realizedUsd !== 'number' || !Number.isFinite(x.realizedUsd)) return false
  for (const [id, p] of Object.entries(x.positions)) {
    if (!/^\d+$/.test(id) || !own(p)) return false
    if (typeof p.shares !== 'number' || !Number.isFinite(p.shares) || p.shares < 0) return false
    if (typeof p.cost !== 'number' || !Number.isFinite(p.cost) || p.cost < 0) return false
  }
  for (const [c, v] of Object.entries(x.filled)) {
    if (c === '__proto__' || typeof v !== 'number' || !Number.isFinite(v) || v < 0) return false
  }
  // Optional: which leg and side each client order id first filled on, so a replay on another leg is refused.
  if (x.filledOn !== undefined) {
    if (!own(x.filledOn)) return false
    for (const [c, v] of Object.entries(x.filledOn)) if (c === '__proto__' || !/^[0-9]+:[BA]$/.test(v)) return false
  }
  return true
}

// Starts a new realized-loss day at the UTC boundary. Returns a new ledger.
export function rollDay(ledger, now) {
  const day = utcDay(now)
  const copy = { ...ledger, positions: { ...ledger.positions }, filled: { ...ledger.filled } }
  if (ledger.filledOn) copy.filledOn = { ...ledger.filledOn }
  if (ledger.day === day) return copy
  return { ...copy, day, realizedUsd: 0 }
}

// A fee rate is a fraction of notional, never negative and never above 5 percent.
const MAX_FEE = 0.05
const checkFee = (rate) => {
  if (!Number.isFinite(rate) || rate < 0 || rate > MAX_FEE) throw Error('Invalid fee rate.')
  return rate
}

/**
 * The fee rates the ledger and the planner use, as fractions of notional, for a builder rate (a fraction, e.g. 0.0001
 * for 1 bp). Buys pay the builder fee only; sells pay the exchange fee for their side plus the builder fee.
 * Returns { buy, sellMaker, sellTaker }. Throws on a builder rate outside 0 to 0.05.
 */
export function feeRatesFor(builderRate) {
  const b = checkFee(num(builderRate))
  return {
    buy: checkFee(buyExchangeFeeRate + b),
    sellMaker: checkFee(sellMakerFeeRate + b),
    sellTaker: checkFee(sellTakerFeeRate + b),
  }
}

/**
 * Drops the fill totals of every client order id not in keep (a Set or array of the ids still pending). Returns a
 * new ledger; positions and realized P&L are untouched. A pruned id that fills again would count as new, so keep
 * every id that can still report a fill.
 */
export function pruneFilled(ledger, keep) {
  if (!isLedger(ledger)) throw Error('Invalid ledger.')
  const wanted = keep instanceof Set ? keep : new Set(keep ?? [])
  const next = { ...ledger, positions: {}, filled: {} }
  for (const [id, p] of Object.entries(ledger.positions)) next.positions[id] = { ...p }
  for (const [c, v] of Object.entries(ledger.filled)) if (wanted.has(c)) next.filled[c] = v
  if (ledger.filledOn) {
    next.filledOn = {}
    for (const [c, v] of Object.entries(ledger.filledOn)) if (wanted.has(c)) next.filledOn[c] = v
  }
  return next
}

export function applyFill(ledger, { cloid, legId, side, filledTotal, px, feeRate, now }) {
  if (!isLedger(ledger)) throw Error('Invalid ledger.')
  if (typeof cloid !== 'string' || !cloid || cloid === '__proto__') throw Error('Invalid client order id.')
  const leg = String(legId)
  if (!/^\d+$/.test(leg)) throw Error('Invalid leg id.')
  if (side !== 'B' && side !== 'A') throw Error('Invalid side.')
  const total = units(num(filledTotal))
  if (!Number.isFinite(total) || total < 0) throw Error('Invalid filled total.')
  const price = roundTick(num(px))
  if (!(price >= TICK && tickInt(price) <= TICKS - 1)) throw Error('Fill price must be inside (0, 1).')
  const rate = checkFee(num(feeRate))
  if (!Number.isFinite(now)) throw Error('Invalid time.')

  const next = rollDay(ledger, now)
  const seen = Object.hasOwn(next.filled, cloid) ? units(next.filled[cloid]) : 0
  const where = `${leg}:${side}`
  if (next.filledOn && Object.hasOwn(next.filledOn, cloid) && next.filledOn[cloid] !== where)
    throw Error('Client order id was used on another leg or side.')
  if (total < seen) throw Error('Fill total went down.')
  const delta = total - seen
  if (delta === 0) return next

  const have = next.positions[leg] ?? { shares: 0, cost: 0 }
  const haveUnits = units(have.shares)
  if (side === 'B') {
    next.positions[leg] = {
      shares: fromUnits(haveUnits + delta),
      cost: money(have.cost + fromUnits(delta) * price * (1 + rate)),
    }
  } else {
    if (delta > haveUnits) throw Error('Sold more than the ledger holds')
    const sold = fromUnits(delta)
    const avg = have.cost / have.shares
    const left = haveUnits - delta
    next.realizedUsd = money(next.realizedUsd + sold * price * (1 - rate) - sold * avg)
    if (left === 0) delete next.positions[leg]
    else next.positions[leg] = { shares: fromUnits(left), cost: money(have.cost - sold * avg) }
  }
  next.filled[cloid] = fromUnits(total)
  next.filledOn = { ...(next.filledOn ?? {}), [cloid]: where }
  return next
}

const SETTLED = (s) => s === 'filled' || s === 'open' || s === 'triggered' || /canceled$/i.test(s) || /rejected$/i.test(s) || s === 'scheduledCancel'

// expected: [{ c, legId, side, px }]. openRows come from frontendOpenOrders. statusOf(cloid)
// returns the orderStatus response (or its inner order object) for orders that left the book.
export function fillsFromView(expected, openRows, statusOf) {
  const open = new Map()
  for (const r of openRows ?? []) if (r?.cloid) open.set(r.cloid, r)
  const out = []
  for (const e of expected) {
    const row = open.get(e.c)
    let orig
    let rest
    if (row) {
      if ((row.coin !== undefined && row.coin !== '#' + e.legId) || (row.side !== undefined && row.side !== e.side))
        throw Error('Open order does not match what was submitted.')
      orig = units(num(row.origSz))
      rest = units(num(row.sz))
    } else {
      const raw = statusOf(e.c)
      const detail = raw?.order?.order ? raw.order : raw
      const inner = detail?.order
      if (!detail || typeof detail.status !== 'string' || !inner) throw Error('Unknown order status for ' + e.c)
      if (!SETTLED(detail.status)) throw Error('Unexpected order status ' + detail.status)
      if (inner.cloid !== e.c) throw Error('Order status does not match what was submitted.')
      if ((inner.coin !== undefined && inner.coin !== '#' + e.legId) || (inner.side !== undefined && inner.side !== e.side))
        throw Error('Order status does not match what was submitted.')
      orig = units(num(inner.origSz))
      rest = detail.status === 'filled' ? 0 : units(num(inner.sz))
    }
    if (!Number.isFinite(orig) || !Number.isFinite(rest) || orig <= 0 || rest < 0 || rest > orig)
      throw Error('Inconsistent order sizes for ' + e.c)
    out.push({ cloid: e.c, filledTotal: fromUnits(orig - rest), px: e.px })
  }
  return out
}

// Venue outcome balances ('+7010') must equal ledger shares exactly, in both directions.
export function reconcile(ledger, balances) {
  const venue = {}
  const rows = Array.isArray(balances)
    ? balances
    : Object.entries(balances ?? {}).map(([coin, total]) => ({ coin, total }))
  for (const b of rows) {
    if (typeof b?.coin !== 'string' || !b.coin.startsWith('+')) continue
    const id = b.coin.slice(1)
    const u = units(num(b.total))
    venue[id] = (venue[id] ?? 0) + (Number.isFinite(u) ? u : NaN)
  }
  const mismatches = []
  const ids = new Set([...Object.keys(ledger?.positions ?? {}), ...Object.keys(venue)])
  for (const id of [...ids].sort()) {
    const mine = units(ledger?.positions?.[id]?.shares ?? 0)
    const theirs = venue[id] ?? 0
    if (mine !== theirs) mismatches.push({ legId: id, ledger: fromUnits(mine), venue: Number.isFinite(theirs) ? fromUnits(theirs) : null })
  }
  return { ok: mismatches.length === 0, mismatches }
}

const held = (pos) => {
  const s = units(pos?.shares ?? 0)
  if (!(s > 0)) throw Error('No shares held.')
  if (!(pos.cost >= 0) || !Number.isFinite(pos.cost)) throw Error('Invalid cost.')
  return fromUnits(s)
}

export function breakevenPx(pos, sellFeeRate) {
  checkFee(sellFeeRate)
  const shares = held(pos)
  return ceilTick(pos.cost / shares / (1 - sellFeeRate))
}

// Lowest price an exit may use. Both bounds are on net proceeds after the taker fee, so a
// flatten IOC at this price can never lose more than either bound. With no loss budget left the
// floor is breakeven at the taker rate (no loss taken); it is never below the maker breakeven.
export function floorPx(pos, { maxExitLossFraction, lossBudgetLeftUsd, takerFeeRate = sellTakerFeeRate }) {
  checkFee(takerFeeRate)
  const shares = held(pos)
  const avg = pos.cost / shares
  const loss = Number.isFinite(maxExitLossFraction) ? Math.min(1, Math.max(0, maxExitLossFraction)) : 0
  const budget = Number.isFinite(lossBudgetLeftUsd) ? Math.max(0, lossBudgetLeftUsd) : 0
  const byFraction = (avg * (1 - loss)) / (1 - takerFeeRate)
  const byBudget = (avg - budget / shares) / (1 - takerFeeRate)
  return ceilTick(Math.max(byFraction, byBudget, TICK))
}

const sellable = (pos, availableShares) => {
  const a = num(availableShares)
  if (!Number.isFinite(a) || a < 1) return 0
  return Math.min(Math.floor(fromUnits(units(pos.shares))), Math.floor(fromUnits(units(a))))
}

export function exitAsk({ pos, leg, now, flattenStartAt, flattenEndAt, floor, breakeven, availableShares }) {
  if (!pos || !(units(pos.shares) > 0)) return null
  const sz = sellable(pos, availableShares)
  if (sz < 1) return null
  if (!(num(floor) >= TICK * (1 - 1e-9))) return null
  const fl = ceilTick(floor)
  const be = ceilTick(breakeven)
  // A floor under one tick (zero, negative or missing) would sell at any price: no order.
  if (!Number.isFinite(fl) || !Number.isFinite(be) || tickInt(fl) < 1) return null
  let t = 0
  if (Number.isFinite(flattenStartAt) && Number.isFinite(flattenEndAt)) {
    if (now >= flattenEndAt) t = 1
    else if (now > flattenStartAt) t = (now - flattenStartAt) / (flattenEndAt - flattenStartAt)
  }
  const target = be + (fl - be) * t
  const bid = Number.isFinite(leg?.bestBid) ? leg.bestBid : 0
  let ticks = Math.max(tickInt(ceilTick(target)), tickInt(fl), tickInt(roundTick(bid)) + 1)
  if (ticks > TICKS - 1) ticks = TICKS - 1
  // Never below the floor and never at or below the best bid; if both cannot hold, no exit.
  if (ticks < tickInt(fl) || ticks <= tickInt(roundTick(bid))) return null
  return { px: ticks / TICKS, sz, tif: 'Alo' }
}

// marks: { [legId]: best bid or null }. A missing mark counts as worth nothing.
// Positions are valued as if sold now at the mark after the taker fee.
export function markedPnl(ledger, marks, { feeRate = sellTakerFeeRate } = {}) {
  checkFee(feeRate)
  const perLeg = {}
  let unrealizedUsd = 0
  for (const [id, pos] of Object.entries(ledger.positions)) {
    const m = Number.isFinite(marks?.[id]) ? marks[id] : 0
    const value = pos.shares * m * (1 - feeRate)
    const pnl = value - pos.cost
    perLeg[id] = { shares: pos.shares, cost: pos.cost, mark: m, value: money(value), pnl: money(pnl) }
    unrealizedUsd += pnl
  }
  unrealizedUsd = money(unrealizedUsd)
  const totalUsd = money(ledger.realizedUsd + unrealizedUsd)
  return { realizedUsd: ledger.realizedUsd, unrealizedUsd, totalUsd, markedLossUsd: Math.max(0, -totalUsd), perLeg }
}
