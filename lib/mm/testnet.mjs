import { networks, networkOf } from './network.mjs'

// Shared by the device runner and owner recovery screen. There is no configurable exchange URL.
export const url = 'https://api.hyperliquid-testnet.xyz'
export const builder = '0x0fdd59414989f52989973fef8995b7d10248cc18'
export const fee = 10 // tenths of a bp: 1 bp per fee-paying fill
/**
 * The maxFeeRate string to pass to Hyperliquid's approveBuilderFee when approval is needed.
 * Matches parabolic-web/lib/hip4/trade/exchange.js (`builderApprovalRate()`): never asks for less than the site's
 * standard taker/spot/perp cap (at least 0.1%, or 0.15% when SPOT=150) so approving on /mm never downgrades an
 * existing hip4.ag user's builder ceiling.
 */
export function siteBuilderApprovalRate(required = fee) {
  const env = typeof process !== 'undefined' && process?.env ? process.env : {}
  const spot = Number(env.NEXT_PUBLIC_BUILDER_FEE_SPOT ?? '0')
  const perp = Number(env.NEXT_PUBLIC_BUILDER_FEE_PERP ?? '0')
  const taker = Number(env.NEXT_PUBLIC_BUILDER_FEE_PREDICTION_TAKER ?? '100')
  const tenths = Math.max(
    Number.isFinite(required) ? required : fee,
    Number.isFinite(spot) ? spot : 0,
    Number.isFinite(perp) ? perp : 0,
    Number.isFinite(taker) ? taker : 100
  )
  return `${tenths / 1000}%`
}

const EVM_ADDR = /^0x[0-9a-f]{40}$/i

/**
 * Resolve the Hyperliquid order action `builder` object (`{ b, f }` or `{ b, f, s }`).
 * Matches parabolic-web/lib/hip4/trade/builderFee.js: key order `b, f, s` is part of the signed msgpack, and optional
 * sub-builder `s` is ONLY attached when `feeTenths > 0` (never on `f: 0` attribution-only / waived orders).
 */
export function builderPayload(feeTenths, envOverride) {
  const env = envOverride ?? (typeof process !== 'undefined' && process?.env ? process.env : {})
  const f = Number.isFinite(feeTenths) && feeTenths > 0 ? Math.floor(feeTenths) : 0
  const out = { b: builder.toLowerCase(), f }
  if (f <= 0) return out
  const subAddr = String(env.MM_SUB_BUILDER_ADDRESS ?? env.NEXT_PUBLIC_SUB_BUILDER_ADDRESS ?? '')
    .trim()
    .toLowerCase()
  const subShare = Number(env.MM_SUB_BUILDER_SHARE ?? env.NEXT_PUBLIC_SUB_BUILDER_SHARE ?? '100000')
  if (
    EVM_ADDR.test(subAddr) &&
    !/^0x0{40}$/i.test(subAddr) &&
    subAddr !== out.b &&
    Number.isInteger(subShare) &&
    subShare > 0 &&
    subShare <= 100000
  ) {
    out.s = [{ b: subAddr, s: subShare }]
  }
  return out
}
/**
 * The builder fee (tenths of a bp) orders for this owner wallet carry: 0 for a wallet in `waived`, `fee` otherwise.
 * The waived list is local operator config (scripts/mm/local-config.mjs), passed in by the Node runner. It is never
 * kept in this file, which the browser also loads. Entries are lowercase.
 */
export const feeFor = (owner, waived = []) => (waived.includes(String(owner ?? '').toLowerCase()) ? 0 : fee)
// Legacy single-market presets, kept for quotePair until the post-merge cleanup.
export const budgets = [25, 50, 100]
export const runMinutes = [1, 5, 15, 30, 45, 60, 120, 240, 480, 720]
/** Smallest order value the exchange accepts, in USDC. Owner decision O4: confirm for outcome orders on testnet. */
export const minOrderUsd = 10
export const maxRunMarkets = 12
export const quoteCutoff = (start, approvalUntil) => Math.min(start - 60000, approvalUntil || Infinity)
export function quoteEstimate(orders, rate = fee) {
  const [yes, no] = orders.map((o) => Number(o.p) * Number(o.s))
  const requestedRate = rate / 100000
  return {
    shares: Number(orders[0].s),
    yes,
    no,
    builderFee: (yes + no) * requestedRate,
    debit: (yes + no) * (1 + requestedRate),
    yesRisk: yes * (1 + requestedRate),
    noRisk: no * (1 + requestedRate),
  }
}
export const prefix = '0x484d4d01'
export const nameFor = (address) => 'hip4mm-' + address.slice(2, 11).toLowerCase()
export const maxAgentDays = 180
export const validAgentDays = (days) => Number.isInteger(days) && days >= 1 && days <= maxAgentDays
export function deviceApproval(agentAddress, days, clickedAt) {
  if (!validAgentDays(days)) throw Error(`Choose a whole number of days from 1 to ${maxAgentDays}.`)
  const until = clickedAt + days * 86400000
  return { agentAddress, agentName: nameFor(agentAddress) + ' valid_until ' + until }
}
export const orderPrefix = (address) => prefix + address.slice(2, 14).toLowerCase()
export const addressOf = (value) => {
  if (!/^0x[\da-f]{40}$/i.test(value) || /^0x0{40}$/i.test(value)) throw Error('Choose a valid account address.')
  return value.toLowerCase()
}

// One weight counter for the whole process: both networks share the machine's IP, so they share its allowance.
const readCosts = []
const prune = (now) => {
  while (readCosts.length && readCosts[0].at <= now - 60000) readCosts.shift()
}
/** A 429 from the exchange or the info endpoint. retryAfterMs is the server's Retry-After in ms, or null when it sent none. */
export class RateLimitError extends Error {
  constructor(message = 'Hyperliquid is rate limiting requests.', retryAfterMs = null) {
    super(message)
    this.name = 'RateLimitError'
    this.retryAfterMs = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : null
  }
}
/** Info weight this process spent in the last minute (Node runner only; the browser does not count). */
export function readWeightLastMinute(now = Date.now()) {
  return readCosts.filter((r) => r.at > now - 60000).reduce((sum, r) => sum + r.weight, 0)
}
/**
 * Counts one exchange action of n orders or cancels against the IP weight: 1 + floor(n / 40). Call it for every
 * action the runner sends, so info reads shed first when the minute fills up. Node runner only. Returns the weight.
 */
export function recordExchangeWeight(n = 1, now = Date.now()) {
  if (typeof window !== 'undefined') return 0
  const count = Number.isFinite(n) && n > 0 ? Math.floor(n) : 1
  const weight = 1 + Math.floor(count / 40)
  prune(now)
  readCosts.push({ at: now, weight })
  return weight
}
const infoWeight = (type) =>
  type === 'userFillsByTime'
    ? 120
    : ['l2Book', 'clearinghouseState', 'spotClearinghouseState', 'orderStatus'].includes(type)
      ? 2
      : 20

async function fetchInfo(net, type, params) {
  const r = await fetch(net.infoUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, ...params }),
    signal: AbortSignal.timeout(6500),
    cache: 'no-store',
  })
  if (r.status === 429) {
    const seconds = Number(r.headers?.get?.('retry-after'))
    throw new RateLimitError('Hyperliquid ' + net.name + ' is rate limiting requests (429).', seconds * 1000)
  }
  if (!r.ok) throw Error('Hyperliquid ' + net.name + ' could not verify ' + type + ' (' + r.status + ').')
  return r.json()
}
export const builderMinPerps = 100
const standardModes = ['disabled', 'default', 'standard']
const dollars = (value) => '$' + (Number.isFinite(value) ? value.toFixed(2) : '0.00')
/**
 * Whether the builder can be paid a fee, from its account mode and perps account value, with the exact reason when
 * it cannot. Hyperliquid: "The builder must have at least 100 USDC in perps account value and must use standard as
 * the account abstraction mode" (builder codes, read 2026-11-19).
 */
export function builderGate(mode, perpsValue) {
  const perps = Number(perpsValue)
  const blockers = []
  if (!standardModes.includes(mode))
    blockers.push(
      'its account mode is ' + (mode === 'unifiedAccount' ? 'Unified' : String(mode)) + ' and must be Standard'
    )
  if (!(perps >= builderMinPerps))
    blockers.push('it holds ' + dollars(perps) + ' of perps account value and needs ' + dollars(builderMinPerps))
  return { ready: blockers.length === 0, mode, perps: Number.isFinite(perps) ? perps : 0, blockers }
}
export const active = (row) => row.validUntil == null || row.validUntil === 0 || row.validUntil > Date.now()
// The Node runner reuses one answer per (owner, agent) for 60 s, so approval changes made in the wallet show up
// within a minute. The browser always reads fresh, because it checks approvals right before the owner signs.
export const permissionsTtlMs = 60000

/**
 * Every read and the account shapes for one network ('testnet', 'mainnet' or a record from network.mjs). The weight
 * counter is shared by all venues in the process. Returns:
 * { network, info, permissions, forgetPermissions, builderStatus, targets, markets, accountView, readBooks,
 *   settledOutcome(id), userRateLimit(user) }
 */
export function venueFor(network) {
  const net = networkOf(network)
  const publicCache = new Map()
  const permissionCache = new Map()

  async function info(type, params = {}, forCancel = false) {
    const now = Date.now()
    // Only public operator and market metadata can be reused. Account permissions,
    // order books, balances and outstanding orders always get exchange readback.
    const reusable =
      type === 'outcomeMeta' || (params.user === builder && ['userAbstraction', 'clearinghouseState'].includes(type))
    const cached = reusable && publicCache.get(type)
    if (cached && cached.until > now) return cached.promise
    if (typeof window === 'undefined') {
      prune(now)
      // Reserve the full 2,000-row history response weight before issuing a receipt read.
      const weight = infoWeight(type)
      if (readCosts.reduce((sum, r) => sum + r.weight, 0) + weight > (forCancel ? 1080 : 900))
        throw Error('Runner read budget reached. Cancellation capacity is reserved.')
      readCosts.push({ at: now, weight })
    }
    const promise = fetchInfo(net, type, params)
    if (reusable) {
      const record = { until: now + 30000, promise }
      publicCache.set(type, record)
      promise.catch(() => {
        if (publicCache.get(type) === record) publicCache.delete(type)
      })
    }
    return promise
  }

  async function readPermissions(owner, agent) {
    const [agents, cap, mode, perp] = await Promise.all([
      info('extraAgents', { user: owner }),
      info('maxBuilderFee', { user: owner, builder }),
      info('userAbstraction', { user: builder }),
      info('clearinghouseState', { user: builder }),
    ])
    if (!Array.isArray(agents) || !Number.isSafeInteger(cap) || cap < 0) throw Error('Incomplete approval information.')
    const slot = agents.find((a) => a.name === nameFor(agent) && active(a))
    return {
      builderReady: builderGate(mode, perp?.marginSummary?.accountValue).ready,
      builderMode: mode,
      builderBlockers: builderGate(mode, perp?.marginSummary?.accountValue).blockers,
      approved: slot?.address?.toLowerCase() === agent.toLowerCase(),
      occupied: !!slot,
      until: slot?.validUntil,
      cap,
    }
  }
  function permissions(owner, agent) {
    if (typeof window !== 'undefined') return readPermissions(owner, agent)
    const key = String(owner).toLowerCase() + ':' + String(agent).toLowerCase()
    const now = Date.now()
    const hit = permissionCache.get(key)
    if (hit && hit.until > now) return hit.promise
    const record = { until: now + permissionsTtlMs, promise: readPermissions(owner, agent) }
    permissionCache.set(key, record)
    record.promise.catch(() => {
      if (permissionCache.get(key) === record) permissionCache.delete(key)
    })
    return record.promise
  }
  // Public reads only: usable before a wallet is connected or a runner is paired.
  async function builderStatus() {
    const [mode, perp] = await Promise.all([
      info('userAbstraction', { user: builder }),
      info('clearinghouseState', { user: builder }),
    ])
    if (typeof mode !== 'string' || !perp?.marginSummary) throw Error('Incomplete builder status.')
    return builderGate(mode, perp.marginSummary.accountValue)
  }
  async function targets(owner) {
    const subs = await info('subAccounts', { user: owner })
    if (subs !== null && !Array.isArray(subs)) throw Error('Could not verify trading accounts.')
    return [addressOf(owner), ...(subs ?? []).map((s) => addressOf(s.subAccountUser))]
  }
  async function accountView(target, forCancel = false) {
    const [orders, spot] = await Promise.all([
      info('frontendOpenOrders', { user: target }, forCancel),
      info('spotClearinghouseState', { user: target }, forCancel),
    ])
    if (!Array.isArray(orders) || !Array.isArray(spot?.balances)) throw Error('Incomplete account information.')
    const hydrated = await Promise.all(
      orders.map(async (row) => {
        if (!/^#\d+$/.test(row.coin) || row.cloid !== undefined) return row
        const detail = await info('orderStatus', { user: target, oid: row.oid }, forCancel)
        if (!detail?.order?.order) throw Error('Order details are still being reconciled.')
        return { ...row, cloid: detail.order.order.cloid }
      })
    )
    return { orders: hydrated, balances: spot.balances }
  }
  async function markets() {
    const meta = await info('outcomeMeta')
    const outcomes = new Map(meta.outcomes.map((o) => [o.outcome, o]))
    return meta.questions.flatMap((q) => {
      if (!/^template:sportsContestResult/.test(q.name)) return []
      const fields = Object.fromEntries(
        q.description.split('|').map((f) => [f.slice(0, f.indexOf(':')), f.slice(f.indexOf(':') + 1)])
      )
      const s = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(fields.scheduledStart)
      if (!s) return []
      const start = Date.UTC(+s[1], +s[2] - 1, +s[3], +s[4], +s[5])
      if (!(start > Date.now() + 90000)) return []
      return q.namedOutcomes.flatMap((id) => {
        const o = outcomes.get(id)
        if (!o || o.quoteToken !== 'USDC' || q.settledNamedOutcomes?.includes(id)) return []
        return [
          {
            id,
            start,
            questionName: q.name,
            description: q.description,
            label:
              fields.participantA + ' vs ' + fields.participantB + ' · ' + o.description.replace(/^participant:/, ''),
          },
        ]
      })
    })
  }
  /**
   * Both outcome books for each market id: Map<id, [yesBook, noBook]>. REST: the fallback behind the websocket feed in
   * scripts/mm/book-feed.mjs. Each l2Book read costs 2 weight.
   */
  async function readBooks(ids) {
    const rows = await Promise.all(
      ids.map(async (id) => [id, await Promise.all([0, 1].map((i) => info('l2Book', { coin: '#' + (id * 10 + i) })))])
    )
    return new Map(rows)
  }
  /**
   * Settlement proof for one outcome (weight 20): { spec, settleFraction, details, question? } once settled, null while
   * it is not.
   */
  const settledOutcome = (id) => {
    if (!Number.isSafeInteger(id) || id < 0) throw Error('Choose a valid outcome id.')
    return info('settledOutcome', { outcome: id })
  }
  /** Current on-chain maxBuilderFee cap (tenths of a bp) that `owner` has approved for `builderAddr`. */
  async function maxBuilderFee(owner, builderAddr = builder) {
    const cap = await info('maxBuilderFee', { user: addressOf(owner), builder: addressOf(builderAddr) })
    if (!Number.isSafeInteger(cap) || cap < 0) throw Error('Could not read the current builder fee ceiling.')
    return cap
  }
  /** The per-address request allowance { cumVlm, nRequestsUsed, nRequestsCap, nRequestsSurplus } (weight 20). */
  const userRateLimit = (user) => info('userRateLimit', { user: addressOf(user) })

  return {
    network: net,
    info,
    permissions,
    forgetPermissions: () => permissionCache.clear(),
    builderStatus,
    maxBuilderFee,
    targets,
    markets,
    accountView,
    readBooks,
    settledOutcome,
    userRateLimit,
  }
}

/** The testnet venue: what every existing caller of this file uses. */
export const venue = venueFor(networks.testnet)
export const { info, permissions, forgetPermissions, builderStatus, maxBuilderFee, targets, accountView, markets, readBooks } = venue

export const ownedOrders = (orders, address) =>
  orders.filter((o) => /^#\d+$/.test(o.coin) && o.cloid?.startsWith(orderPrefix(address)))
export const inventory = (balances) => balances.filter((b) => /^[+#]\d+$/.test(b.coin) && Number(b.total) > 0)
export function cancelRows(orders) {
  return orders.map((o) => {
    if (!/^#\d+$/.test(o.coin) || !Number.isSafeInteger(o.oid) || !o.cloid?.startsWith(prefix))
      throw Error('Unrecognized market-maker order.')
    return { a: 100000000 + Number(o.coin.slice(1)), o: o.oid }
  })
}
// Legacy single-market price policy (+/- 1 cent band). Unused by the engine; remove in the post-merge cleanup.
export function quotePrices({ books, market, now = Date.now() }) {
  if (!(market.start > now + 60000)) throw Error('Market is too close to kickoff.')
  const tops = books.map((b, i) => {
    if (
      b?.coin !== '#' + (market.id * 10 + i) ||
      !Number.isSafeInteger(b.time) ||
      b.time > now + 1000 ||
      now - b.time > 6000
    )
      throw Error('Waiting for fresh books.')
    const bid = Number(b.levels?.[0]?.[0]?.px),
      ask = Number(b.levels?.[1]?.[0]?.px)
    if (!(bid > 0 && ask < 1 && bid < ask)) throw Error('Waiting for two-sided books.')
    return { bid, ask }
  })
  if (tops.length !== 2) throw Error('Both outcome books are required.')
  const mid = (tops[0].bid + tops[0].ask) / 2
  const prices = tops.map((x) => Math.floor((x.bid + 1e-10) * 100) / 100)
  if (
    prices.some((p) => p <= 0) ||
    prices[0] + prices[1] >= 1 ||
    Math.abs(mid - prices[0]) > 0.01000001 ||
    Math.abs(mid - (1 - prices[1])) > 0.01000001
  )
    throw Error('Prices are outside the testnet preset band.')
  return prices
}
export function quotePair({ books, budget, available, market, now = Date.now() }) {
  if (!budgets.includes(budget) || !Number.isFinite(available) || available < budget)
    throw Error('Available budget is outside the preset.')
  const prices = quotePrices({ books, market, now })
  const shares = Math.floor(budget / ((prices[0] + prices[1]) * 1.001))
  if (prices.some((p) => shares * p < 1)) throw Error('The budget cannot fund both quotes.')
  return prices.map((p, i) => ({
    a: 100000000 + market.id * 10 + i,
    b: true,
    p: String(p),
    s: String(shares),
    r: false,
    t: { limit: { tif: 'Alo' } },
  }))
}
