// The runner engine: one process, one owner, one trading account, one agent key per network.
//
// What it does each tick: read the account, settle fills into the ledger, check the ledger against the venue, pick the
// markets to quote, read books (websocket first, REST only as a fallback), plan each market (desk-plan), then cancel,
// arm the disconnect timer and place. The file name stays for the callers that import it; it runs testnet for
// developers and mainnet behind the code switch in lib/mm/network.mjs.
//
// The rule this file is built around: nothing but an integrity failure stops exits. A kill, a loss stop, the action
// budget, the per-address limit, a rate limit, other errors, the end of the session, quoting hours, a reward rollover
// hold and a lost feed only block NEW BIDS. Resting exit asks stay, and the forced pre-game sells keep running.
// Integrity failures (ledger or venue mismatch, a foreign order, an unknown order status, approval or builder lost, a
// disconnect timer that cannot be armed) stop everything and publish a hold for every held leg.
import { randomBytes } from 'node:crypto'
import { verifyMessage } from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { RunJournal } from './run-journal.mjs'
import {
  venue as testnetVenue,
  venueFor,
  info,
  permissions,
  targets,
  markets,
  accountView,
  readBooks,
  ownedOrders,
  cancelRows,
  inventory,
  orderPrefix,
  nameFor,
  quoteCutoff,
  runMinutes,
  builder,
  builderPayload,
  feeFor,
  minOrderUsd,
  maxRunMarkets,
  readWeightLastMinute,
  recordExchangeWeight,
  RateLimitError,
} from '../../lib/mm/testnet.mjs'
import { networkOf, mainnetOrdersEnabled } from '../../lib/mm/network.mjs'
import { verifyArming } from '../../lib/mm/arming.mjs'
import { exchangeClientFor } from './exchange-client.mjs'
import { BookFeed, coinsOfOutcome, isSettledProof } from './book-feed.mjs'
import { campaignTransition } from './campaign-watch.mjs'
import { campaignFeed, mainnetCatalog } from './campaign-bands.mjs'
import { loadPolicy } from './policy/index.mjs'
import { loadPreferences, preferencesFile, preferencesView, savePreferences, startCheck } from './preferences.mjs'
import { familyOf, autoPick, rankMarkets } from './market-rank.mjs'
import { testnetWidth } from './band-price.mjs'
import { quotingHoursOpen, startBlocked, hourlyLoss } from './guards.mjs'
import { exitPhase, forceAtOf, recordSample } from './exit-guard.mjs'
import {
  emptyLedger,
  applyFill,
  fillsFromView,
  reconcile,
  markedPnl,
  breakevenPx,
  rollDay,
  pruneFilled,
  feeRatesFor,
} from './inventory.mjs'
import {
  createActionBudget,
  budgetReached,
  actionAllowance,
  memoryActionStore,
  addressHeadroom,
  cancelBatches,
  nextBackoff,
} from './request-budget.mjs'
import {
  planMarket,
  diffOrders,
  emptyMarketState,
  bookTop,
  bookLevels,
  effectiveTops,
  effectiveLevels,
  withoutOwnLevels,
  marketTops,
  yesMid,
} from './desk-plan.mjs'
import { readOwnScores } from './rewards-read.mjs'
import { dayOf } from './daily-pnl.mjs'

export const venue = { info, permissions, targets, markets, accountView, readBooks }

/** Errors that pause quoting and back off instead of blocking bids at once. */
export class TransientError extends Error {}
const transientText = /read budget|\((429|5\d\d)\)|timed? ?out|timeout|aborted|fetch failed|network|ECONN|ETIMEDOUT/i
// Bugs and request-shape errors. Retrying them only repeats them, so they are never treated as a passing blip.
const programmingErrors = new Set([
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'ValidationError',
  'FormatError',
  'CanonicalizeError',
  'AbstractWalletError',
])
/** Network, timeout, 429, 5xx, a stale book and the read budget pass; everything else does not. */
export const isTransient = (e) => {
  const message = String(e?.message)
  if (message.includes(budgetReached)) return false
  if (e instanceof TransientError) return true
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return true
  // Node reports a failed fetch (DNS, reset, refused) as a TypeError with this message.
  if (programmingErrors.has(e?.name)) return e.name === 'TypeError' && /fetch failed/i.test(message)
  if (e?.name === 'HttpRequestError') {
    const status = e.response?.status
    return status === undefined || status === 429 || status >= 500
  }
  return transientText.test(message)
}
/** A rate limit from the venue: backs off and is never counted toward the error block. */
export const isRateLimit = (e) =>
  e instanceof RateLimitError ||
  e?.name === 'RateLimitError' ||
  (e?.name === 'HttpRequestError' && e.response?.status === 429)

/**
 * A ledger, venue or authorization integrity failure. These stop the run, cancel every order and publish a hold for
 * every held leg. Every other failure only blocks new bids.
 */
const integrity = (message, cause) => Object.assign(Error(message, cause ? { cause } : undefined), { integrity: true })
const asIntegrity = (e) => (isTransient(e) || isRateLimit(e) || e?.integrity ? e : integrity(e?.message ?? String(e), e))
// Reads that sometimes come back half done for a moment. They get a couple of re-reads before they count.
const blipText = /Incomplete account information|Incomplete approval information|still being reconciled/i
const blipRereads = 2
const rereadDelayMs = 300
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const maxTransientInARow = 10

// Mechanism constants, not tuned numbers. Each is conservative and listed in the WP3 report.
// Resting orders on a market are withdrawn this long before its cutoff (start minus 60 s), so the disconnect timer can
// always be armed with room to spare. Forced IOC sells keep going until the cutoff itself.
const closeMarginMs = 30000
// With ten failures in a row, the full loop is retried this often; exits are checked in between.
const errorRetryMs = 60e3
// During a backoff the account is read at most this often, for forced sells only.
const exitReadEveryMs = 30e3
// The exit price samples are saved to the journal at most this often.
const sampleSaveMs = 30e3
// The per-address request allowance is read this often.
const addressReadMs = 10 * 60e3
// The day's marks are saved this often, so the daily view has an end-of-day value.
const markSaveMs = 10 * 60e3
// The user's own reward estimate (mainnet only) is read this often.
const rewardReadMs = 30 * 60e3
// The marked totals behind the hourly loss stop are kept this long.
const historyKeepMs = 65 * 60e3
// One forced IOC per leg at most this often, so a book that keeps missing cannot drain the exit reserve.
const forcedRetryMs = 10e3
// A run with no end chosen ("until I stop it") and an agent with no expiry still ends after this long.
const untilStoppedCapMs = 30 * 86400e3
// A REST book older than this cannot be quoted against.
const restBookMaxAgeMs = 6000
// New bids need room in the entry allowance for at least two bids and the disconnect timer.
const bidActionsNeeded = 3
// Conservative fallbacks for policy keys a policy may not carry (see actionPolicy).
const fallbackActionsPerMarketPerHour = 160
const fallbackExitActionReserve = 0.2
const fallbackRefusalBackoffMaxMs = 15 * 60e3

const legOf = (id, i) => String(id * 10 + i)
const marketOfLeg = (legId) => Math.floor(Number(legId) / 10)
const money = (x) => Math.round(x * 1e6) / 1e6
const heldCostOf = (ledger) => Object.values(ledger?.positions ?? {}).reduce((sum, pos) => sum + (Number(pos.cost) || 0), 0)
const forcing = (phase) => phase === 'force' || phase === 'sweep'
const sellByHand = 'Sell by hand before the start.'

/** Tick interval for N markets: max(7 s, the time it takes to spend (22 + 4N) info weight at 600 a minute), +-jitter. */
export function tickDelayMs(n, jitter, random = Math.random) {
  const base = Math.max(7000, Math.ceil(((22 + 4 * n) * 60000) / 600))
  return Math.round(base * (1 + jitter * (2 * random() - 1)))
}

// A ledger's pending map holds every order sent and not yet settled, so a restart can account for its fills.
const validPending = (ledger) => {
  const pending = ledger.pending && typeof ledger.pending === 'object' ? ledger.pending : {}
  const out = {}
  for (const [c, p] of Object.entries(pending))
    if (
      typeof c === 'string' &&
      c.startsWith('0x') &&
      /^\d+$/.test(String(p?.legId)) &&
      (p.side === 'B' || p.side === 'A') &&
      p.px > 0 &&
      p.px < 1 &&
      p.sz > 0
    )
      out[c] = p
  return out
}

// The bid blocks, in the order the first open one is reported. 'unsafe' never reaches a running loop: an integrity
// failure ends the run instead.
export const bidBlockOrder = Object.freeze([
  'kill',
  'unsafe',
  'safe-mode',
  'loss-day',
  'loss-hour',
  'actions',
  'address-limit',
  'backoff',
  'errors',
  'session-end',
  'hours',
  'rollover',
  'feed',
])
const blockText = {
  kill: 'Bids stopped. Selling continues.',
  'safe-mode': 'The runner restarted several times in a few minutes. Only selling runs until you review it.',
  'loss-day': 'Your daily loss stop is reached. No new bids. Selling continues.',
  'loss-hour': 'Your hourly loss stop is reached. No new bids this hour. Selling continues.',
  actions: 'The hourly exchange action allowance for new bids is used. Selling continues.',
  'address-limit': 'The exchange request allowance for this account is nearly used. Selling continues.',
  backoff: 'Hyperliquid is limiting requests. Bids are withdrawn until it clears. Selling continues.',
  errors: 'Checks keep failing. Bids are withdrawn and selling is retried every minute.',
  'session-end': 'The session has ended. No new bids. Selling continues until your shares are sold.',
  hours: 'Outside your quoting hours. Selling continues.',
  rollover: 'The reward window is turning over. Resting bids stay as they are for up to two minutes.',
  feed: 'No fresh order book could be read. Bids are withdrawn.',
}
const block = (code, message) => ({ code, message: message ?? blockText[code] })

export class TestnetRunner {
  constructor({
    owner,
    target,
    entry,
    entries = {},
    journal,
    journals = {},
    read,
    readFor,
    clientFor = (wallet, { network = 'testnet', arming } = {}) => exchangeClientFor({ network, wallet, arming }),
    feeWaived = [],
    policy = loadPolicy(),
    preferences = {
      load: () => loadPreferences(preferencesFile, policy),
      save: (prefs) => savePreferences(preferencesFile, prefs, policy),
    },
    now = () => Date.now(),
    actionStore = memoryActionStore(),
    network = 'testnet',
    networks: allowed = ['testnet', 'mainnet'],
    socketFactory,
    campaigns = campaignFeed,
    scores = readOwnScores,
    armingStore = null,
    device = 'runner',
    verify = verifyMessage,
    safeMode = false,
    mainnetSwitch = mainnetOrdersEnabled,
    log = () => {},
    // Every wait inside the engine (the stop routine, re-reads). Tests pass one that moves their clock instead.
    sleep: wait = sleep,
  }) {
    if (!Array.isArray(feeWaived)) throw Error('The fee-waived list must be an array.')
    Object.assign(this, { owner, target, policy, preferences, now, campaigns, scores, armingStore, device, verify, log })
    this.sleep = wait
    this.clientFor = clientFor
    this.safeMode = !!safeMode
    this.mainnetSwitch = mainnetSwitch === true
    this.feeWaived = feeWaived.map((w) => String(w).toLowerCase())
    this.allowed = allowed.map((n) => networkOf(n).name)
    this.entries = { testnet: entries.testnet ?? entry ?? null, mainnet: entries.mainnet ?? null }
    this.journals = {
      testnet: journals.testnet ?? journal ?? new RunJournal(),
      mainnet: journals.mainnet ?? null,
    }
    // A fake venue (tests) serves every network; the real ones are built per network.
    this.realVenue = !read && !readFor
    let mainnetVenue = null
    this.readFor =
      readFor ?? (read ? () => read : (n) => (n === 'testnet' ? testnetVenue : (mainnetVenue ??= venueFor('mainnet'))))
    // undefined: a real SDK socket with the real venue only; null: no socket; a function: an injected socket.
    this.socketFactory = socketFactory
    this.feeds = {}
    this.profiles = {}
    this.network = networkOf(network).name
    if (!this.allowed.includes(this.network)) throw Error('This runner does not offer ' + this.network + '.')
    this.read = this.readFor(this.network)
    this.notice = 'Idle'
    this.run = null
    this.last = null
    this.holds = []
    this.needsReview = null
    this.arming = null
    this.headroom = null
    this.lastTickAt = null
    this.queue = Promise.resolve()
    // One exchange action budget for this runner, across every start and stop, carried over a restart by the store.
    const t = now()
    const { ceiling, reserve } = this.actionPolicy()
    let carried = actionStore.load(t)
    if (carried === null) {
      // A saved count that cannot be trusted fails closed for bids: they wait out the hour, exits and cancels do not.
      carried = [{ at: t, n: ceiling - Math.ceil(ceiling * reserve) }]
      this.notice = 'The saved exchange action count could not be read. New bids wait up to an hour.'
    }
    this.actions = createActionBudget({
      perHour: ceiling,
      now: t,
      reserve,
      events: carried,
      onSpend: (events) => {
        try {
          actionStore.save(events, this.now())
          this.actionSaveError = null
        } catch (e) {
          this.actionSaveError = e.message
        }
      },
    })
  }

  // ---- the current network's key, journal and client -----------------------------------------------------------
  get profile() {
    return this.profiles[this.network]?.profile
  }
  get wallet() {
    return this.profiles[this.network]?.wallet
  }
  get entry() {
    return this.entries[this.network]
  }
  get journal() {
    return this.journals[this.network]
  }
  get feed() {
    return this.feeds[this.network] ?? null
  }
  /**
   * Action numbers from the policy. requests.maxOrderActionsPerHour is the hard ceiling for the whole runner. Keys a
   * policy may not have fall back to conservative constants: requests.actionsPerMarketPerHour (the allowance one
   * active market gets), requests.exitActionReserve (share kept for exits, cancels and the disconnect timer) and
   * requests.refusalBackoffMaxMs (longest wait after repeated refusals of one leg's order).
   */
  actionPolicy() {
    const r = this.policy.requests ?? {}
    const pick = (value, ok, fallback) => (ok(value) ? value : fallback)
    return {
      ceiling: r.maxOrderActionsPerHour,
      perMarket: pick(r.actionsPerMarketPerHour, (v) => Number.isSafeInteger(v) && v > 0, fallbackActionsPerMarketPerHour),
      reserve: pick(r.exitActionReserve, (v) => Number.isFinite(v) && v >= 0.05 && v <= 0.5, fallbackExitActionReserve),
      backoffMaxMs: pick(r.refusalBackoffMaxMs, (v) => Number.isFinite(v) && v >= r.minRequoteMs, fallbackRefusalBackoffMaxMs),
    }
  }
  /**
   * Most markets one run may quote: the venue, the policy and the user's hard range (6 at launch). The hourly action
   * ceiling is shared by however many are active; it is never raised for more markets.
   */
  marketCap() {
    return Math.min(maxRunMarkets, this.policy.requests.maxMarkets, this.policy.limits?.markets?.[1] ?? 6)
  }
  sizeActions(activeMarkets) {
    const { ceiling, perMarket } = this.actionPolicy()
    this.actions.setPerHour(actionAllowance({ ceiling, perMarket, markets: activeMarkets }).perHour)
  }
  get fee() {
    return feeFor(this.owner, this.feeWaived)
  }
  /** Buys pay the builder fee only; sells pay the exchange fee of their side plus the builder fee. */
  feeRates() {
    return feeRatesFor(this.fee / 100000)
  }
  // Mutations, including timer ticks and cancellation, always run in submission order.
  serial(fn) {
    const result = this.queue.then(fn)
    this.queue = result.catch(() => {})
    return result
  }
  /** The agent key of a network. create: false only opens a saved key and returns null when there is none. */
  async profileOf(network, { create = true } = {}) {
    if (this.profiles[network]) return this.profiles[network]
    const entry = this.entries[network]
    if (!entry) throw Error('This runner has no ' + network + ' agent key.')
    const saved = await entry.getPassword()
    if (!saved && !create) return null
    let profile
    try {
      profile = saved ? JSON.parse(saved) : null
    } catch {
      throw Error('The saved ' + network + ' agent profile cannot be read.')
    }
    profile ??= { key: generatePrivateKey(), issued: false, expires: 0 }
    if (!saved) await entry.setPassword(JSON.stringify(profile))
    const wallet = privateKeyToAccount(profile.key)
    const other = this.profiles[network === 'mainnet' ? 'testnet' : 'mainnet']
    if (other && other.wallet.address === wallet.address)
      throw Error('The mainnet agent must be a different key from the testnet agent.')
    this.profiles[network] = { entry, profile, wallet }
    return this.profiles[network]
  }
  async load() {
    await this.profileOf(this.network)
    this.bind()
    this.pendingStop = this.journal.interrupted()
    if (this.network !== 'mainnet' && this.entries.mainnet && this.allowed.includes('mainnet')) {
      try {
        // Only a key saved earlier is opened here. A new one is made when the user starts mainnet setup.
        await this.profileOf('mainnet', { create: false })
      } catch {
        // The mainnet key is optional; status reports it missing.
      }
    }
    await this.loadArming()
  }
  /** The user starts mainnet setup: make (or open) the mainnet agent key, so the page can ask the owner to approve it. */
  async prepareMainnet() {
    if (!this.allowed.includes('mainnet') || !this.entries.mainnet) throw Error('This runner does not offer mainnet.')
    const m = await this.profileOf('mainnet')
    return { mainnetAgent: m.wallet.address }
  }
  bind() {
    this.opts = this.target === this.owner ? {} : { vaultAddress: this.target }
    // A testnet client can exist at once. A mainnet client needs a verified arming and is built at start.
    this.client = this.network === 'testnet' ? this.clientFor(this.wallet, { network: 'testnet' }) : null
  }
  /** Switch the network the next run uses. Only while nothing runs and every earlier stop is verified. */
  async useNetwork(name) {
    const next = networkOf(name).name
    if (next === this.network) return
    if (!this.allowed.includes(next)) throw Error('This runner does not offer ' + next + '.')
    if (this.run || this.pendingStop) throw Error('Stop the current run before changing the network.')
    if (!this.journals[next]) throw Error('This runner has no ' + next + ' journal.')
    await this.profileOf(next)
    this.network = next
    this.read = this.readFor(next)
    this.bind()
    this.pendingStop = this.journal.interrupted()
    this.ledger = null
    this.last = null
  }
  save() {
    return this.entry.setPassword(JSON.stringify(this.profile))
  }
  clientNow() {
    if (this.client) return this.client
    this.client = this.clientFor(this.wallet, { network: this.network, arming: this.armingForClient() })
    return this.client
  }
  async checkTarget() {
    if (!(await this.read.targets(this.owner)).includes(this.target))
      throw Error('Trading account does not belong to the configured owner.')
  }
  checkApproval(p) {
    const fee = this.fee
    if (!p.approved || p.cap < fee) throw integrity('Agent or builder fee approval is missing or expired.')
    // A waived owner sends a zero fee, which the builder does not need to be eligible to receive.
    if (fee > 0 && !p.builderReady)
      throw integrity(
        'The builder cannot be paid a fee: ' +
          ((p.builderBlockers ?? []).join(', and ') || 'it needs Standard mode and 100 USDC of perps account value') +
          '.'
      )
  }
  dedicatedView(view) {
    const owned = ownedOrders(view.orders, this.wallet.address)
    if (view.orders.length !== owned.length)
      throw integrity('Use an account dedicated to this runner. Other open orders were found.')
    return owned
  }

  // ---- mainnet arming ------------------------------------------------------------------------------------------
  async loadArming() {
    if (!this.armingStore || !this.profiles.mainnet) return
    let record = null
    try {
      record = this.armingStore.load()
    } catch {
      record = null
    }
    if (record) await this.checkArming(record)
  }
  /** Verify an owner-signed arming record against the mainnet agent key this runner holds. */
  async checkArming(record) {
    const m = await this.profileOf('mainnet')
    const agent = m.wallet.address
    const result = await verifyArming({
      record,
      owner: this.owner,
      target: this.target,
      agent,
      device: this.device,
      now: this.now(),
      verify: this.verify,
    })
    // The agent kept is the address the signature was just verified for, never a copy taken from somewhere else.
    if (result.verified) this.arming = { verified: true, agent, expiresAt: result.expiresAt, record }
    else this.arming = null
    return result
  }
  armingForClient() {
    const a = this.arming
    return a?.verified ? { verified: true, agent: a.agent, expiresAt: a.expiresAt } : undefined
  }
  armingView() {
    if (!this.mainnetSwitch)
      return { verified: false, reason: 'Mainnet orders are not enabled in this build.', expiresAt: null }
    const a = this.arming
    if (!a) return { verified: false, reason: 'Mainnet is not armed.', expiresAt: null }
    if (!(a.expiresAt > this.now())) return { verified: false, reason: 'The arming has expired. Arm again.', expiresAt: a.expiresAt }
    return { verified: true, reason: null, expiresAt: a.expiresAt }
  }
  async arm(record) {
    if (!this.mainnetSwitch) throw Error('Mainnet orders are not enabled in this build. Nothing was armed.')
    if (!this.allowed.includes('mainnet')) throw Error('This runner does not offer mainnet.')
    const result = await this.checkArming(record)
    if (result.verified) this.armingStore?.save(record)
    return { arming: { verified: result.verified, reason: result.reason, expiresAt: result.expiresAt } }
  }
  async disarm() {
    if (this.run && this.network === 'mainnet') throw Error('Stop the mainnet run before disarming.')
    this.arming = null
    try {
      this.armingStore?.clear()
    } catch {}
    return { arming: this.armingView() }
  }

  // ---- preferences ---------------------------------------------------------------------------------------------
  preferencesView() {
    return preferencesView(this.preferences.load(), this.policy)
  }
  savePreferencesFrom(input) {
    if (this.run) throw Object.assign(Error('Stop the current run before changing settings.'), { status: 409 })
    return preferencesView(this.preferences.save(input), this.policy)
  }
  settings() {
    return this.policy.settingsFor(this.preferences.load().prefs, { seed: this.wallet.address.toLowerCase() })
  }
  // What a user may see of their settings: their own choices and the sizes that follow, never pricing internals.
  publicSettings(s) {
    return {
      budgetUsd: s.budgetUsd,
      marketCount: s.marketCount,
      perSideUsd: money(s.perSideUsd),
      maxHeldPerLegUsd: money(s.maxHeldPerLegUsd),
      depthPct: money(s.depthFraction * 100),
      dailyLossStopUsd: money(s.dailyLossStopUsd),
      hourlyLossStopUsd: money(s.hourlyLossStopUsd),
      hours: s.hours,
    }
  }

  // ---- ledger --------------------------------------------------------------------------------------------------
  openLedger(now) {
    let saved
    try {
      // null means no ledger was ever saved. A saved row that is not a valid ledger throws: that is never a fresh start.
      saved = this.journal.loadLedger()
    } catch (e) {
      throw integrity(
        'The position record saved on this device cannot be read (' +
          e.message +
          '). Quoting will not start until it is reviewed.'
      )
    }
    const ledger = rollDay(saved ?? emptyLedger(now), now)
    ledger.pending = saved ? validPending(saved) : {}
    return ledger
  }
  commit(ledger) {
    this.journal.saveLedger(ledger)
    this.ledger = ledger
  }
  /**
   * Shares the venue no longer shows, on a market that has started (or on any market before a run starts), were
   * settled or sold outside this device. They leave the ledger with their full cost booked as a loss, which can only
   * tighten the loss stop. Shares the venue shows are never touched here.
   */
  dropGone(ledger, balances, eligible) {
    const venueShares = new Map(
      balances.filter((b) => /^\+\d+$/.test(b.coin)).map((b) => [b.coin.slice(1), Number(b.total)])
    )
    let next = ledger
    for (const [legId, pos] of Object.entries(ledger.positions)) {
      if ((venueShares.get(legId) ?? 0) > 0 || !eligible(legId)) continue
      if (next === ledger) next = { ...ledger, positions: { ...ledger.positions } }
      next.realizedUsd = money(next.realizedUsd - pos.cost)
      delete next.positions[legId]
    }
    return next
  }
  /**
   * Account for every pending order against the account view: apply fills to the ledger, drop settled orders, save.
   * orderStatus is read only for orders that have left the book. Returns the market ids that had fills.
   */
  async syncFills(view, now) {
    try {
      return await this.settleFills(view, now)
    } catch (e) {
      // A read that timed out passes; anything else means the record and the venue disagree.
      throw asIntegrity(e)
    }
  }
  async settleFills(view, now) {
    let ledger = rollDay(this.ledger, now)
    ledger.pending = { ...this.ledger.pending }
    const open = new Map(view.orders.filter((o) => o.cloid).map((o) => [o.cloid, o]))
    const statuses = new Map()
    const skip = new Set()
    for (const [c, p] of Object.entries(ledger.pending)) {
      if (open.has(c)) {
        // A request that timed out but landed: learn its order id from the book so it can be withdrawn by id.
        const oid = open.get(c).oid
        if (!Number.isSafeInteger(p.oid) && Number.isSafeInteger(oid)) ledger.pending[c] = { ...p, oid, unacked: false }
        continue
      }
      if (ledger.filled[c] !== undefined && ledger.filled[c] >= p.sz - 1e-9) {
        delete ledger.pending[c]
        continue
      }
      const status = await this.read.info('orderStatus', { user: this.target, oid: c })
      if (status?.status === 'unknownOid' && p.unacked) {
        // A signed request the exchange never acknowledged. Past its expiry it can no longer be placed.
        if (now > p.expiresAfter) delete ledger.pending[c]
        skip.add(c)
        continue
      }
      statuses.set(c, status)
    }
    const expected = Object.entries(ledger.pending)
      .filter(([c]) => !skip.has(c))
      .map(([c, p]) => ({ c, legId: p.legId, side: p.side, px: p.px }))
    const fills = fillsFromView(expected, [...open.values()], (c) => statuses.get(c))
    const touched = new Set()
    const rates = this.feeRates()
    const builderRate = this.fee / 100000
    const journalRows = []
    for (const f of fills) {
      const p = ledger.pending[f.cloid]
      const before = ledger.filled[f.cloid] ?? 0
      const feeRate = p.side === 'B' ? rates.buy : p.tif === 'Ioc' ? rates.sellTaker : rates.sellMaker
      ledger = {
        ...applyFill(ledger, {
          cloid: f.cloid,
          legId: p.legId,
          side: p.side,
          filledTotal: f.filledTotal,
          px: f.px,
          feeRate,
          now,
        }),
        pending: ledger.pending,
      }
      if (f.filledTotal > before + 1e-9) {
        touched.add(marketOfLeg(p.legId))
        // The same fill, at the same price and fee rate the ledger booked, for the daily view.
        const value = (f.filledTotal - before) * f.px
        const oid = [p.oid, open.get(f.cloid)?.oid, statuses.get(f.cloid)?.order?.order?.oid].find(Number.isSafeInteger)
        journalRows.push({
          cloid: f.cloid,
          filledTotal: f.filledTotal,
          sz: f.filledTotal - before,
          px: f.px,
          oid: oid ?? 0,
          time: now,
          fee: value * Math.max(0, feeRate - builderRate),
          builderFee: value * builderRate,
        })
      }
      const detail = statuses.get(f.cloid)?.order
      if (detail && detail.status !== 'open' && detail.status !== 'triggered') delete ledger.pending[f.cloid]
    }
    // Fill totals of settled orders are no longer needed.
    const keep = new Set(Object.keys(ledger.pending))
    ledger = { ...pruneFilled(ledger, keep), pending: ledger.pending }
    // Fills go to the journal before the ledger is committed. Each row is keyed by the order and its filled total, so
    // a crash between the two writes, or a restart, re-detects the same fill under the same key and adds nothing.
    // The journal is the daily view only; a write that fails never stops trading.
    if (journalRows.length) {
      try {
        this.journal.recordEngineFills(journalRows)
        this.fillJournalError = null
      } catch (e) {
        this.fillJournalError = e.message
      }
    }
    this.commit(ledger)
    if (this.run) for (const m of touched) this.run.events.fills.add(m)
    if (this.run && touched.size) this.run.marksStale = true
    return touched
  }

  // ---- status --------------------------------------------------------------------------------------------------
  durations(until, now) {
    return [0, ...runMinutes].filter((m) => !until || m === 0 || now + m * 60000 <= until)
  }
  async status() {
    const [approval, view, catalog] = await Promise.all([
      this.read.permissions(this.owner, this.wallet.address),
      this.read.accountView(this.target),
      this.network === 'testnet' ? this.read.markets() : Promise.resolve(this.lastCatalog ?? []),
    ])
    let settings = null
    let settingsError = null
    try {
      settings = this.publicSettings(this.run?.settings ?? this.settings())
    } catch (e) {
      settingsError = e.message
    }
    const now = this.now()
    let daily = []
    try {
      daily = this.journal.dailyRows()
    } catch {
      daily = []
    }
    const run = this.run
    return {
      network: this.network,
      networks: this.allowed,
      owner: this.owner,
      target: this.target,
      agent: this.wallet.address,
      mainnetAgent: this.profiles.mainnet?.wallet.address ?? null,
      name: nameFor(this.wallet.address),
      issued: this.profile.issued,
      approval,
      fee: this.fee,
      builder,
      maxMarkets: this.marketCap(),
      runMinutes: this.durations(approval.until, now),
      markets: catalog.map(({ id, start, label }) => ({ id, start, label })),
      run: run && {
        mode: run.mode,
        minutes: run.minutes,
        endsAt: run.endsAt,
        ids: run.ids,
        backoffUntil: run.backoffUntil || null,
        sessionEnded: !!run.sessionEnded,
      },
      killed: !!run?.killed,
      bidBlock: run?.bidBlock ?? null,
      holds: this.holds,
      feed: this.feed ? this.feed.health(now) : null,
      daily,
      rollover: run?.rollover ? [...run.rollover].map(([id, s]) => ({ id, state: s.state, since: s.since })) : null,
      addressHeadroom: this.headroom,
      arming: this.armingView(),
      safeMode: this.safeMode,
      needsReview: this.needsReview,
      settings,
      settingsError,
      verificationPending: !!this.pendingStop,
      notice: this.notice,
      orders: ownedOrders(view.orders, this.wallet.address),
      inventory: inventory(view.balances),
      availableUsdc: (() => {
        const usdc = view.balances?.find((b) => b.coin === 'USDC')
        if (!usdc) return 0
        const avail = Number(usdc.total) - Number(usdc.hold ?? 0)
        return Number.isFinite(avail) ? Math.max(0, Math.round(avail * 100) / 100) : 0
      })(),
      deskMarkets: this.last?.markets ?? [],
      positions: this.last?.positions ?? [],
      loss: this.last?.loss ?? null,
      requests: (() => {
        const a = this.actions.snapshot(now)
        return {
          infoWeightLastMin: readWeightLastMinute(now),
          actionsLastHour: a.actionsLastHour,
          actionsPerHour: a.perHour,
          projectedPerDay: a.projectedPerDay,
        }
      })(),
      expires: this.profile.expires,
    }
  }
  /** Public, unauthenticated health: no addresses, no keys, no settings. */
  health() {
    const run = this.run
    return {
      ok: !this.needsReview,
      network: this.network,
      running: !!run,
      killed: !!run?.killed,
      bidBlock: run?.bidBlock?.code ?? null,
      holds: this.holds.length,
      lastTickAt: this.lastTickAt,
      feedConnected: this.feed ? this.feed.connected : null,
      safeMode: this.safeMode,
      needsReview: !!this.needsReview,
    }
  }

  // ---- key management -----------------------------------------------------------------------------------------
  async issue() {
    await this.checkTarget()
    const p = await this.read.permissions(this.owner, this.wallet.address)
    if (p.occupied || this.profile.issued)
      throw Error('This key was already presented. Refresh approval status or rotate it.')
    this.profile.issued = true
    await this.save()
  }
  async rotate() {
    const p = await this.read.permissions(this.owner, this.wallet.address)
    if (
      this.run ||
      this.pendingStop ||
      p.approved ||
      this.profile.expires > this.now() ||
      ownedOrders((await this.read.accountView(this.target)).orders, this.wallet.address).length
    )
      throw Error('Stop, cancel resting quotes and revoke the previous agent first.')
    const next = { key: generatePrivateKey(), issued: false, expires: 0 }
    await this.entry.setPassword(JSON.stringify(next))
    this.profiles[this.network] = { entry: this.entry, profile: next, wallet: privateKeyToAccount(next.key) }
    this.bind()
  }

  // ---- holds ---------------------------------------------------------------------------------------------------
  marketInfo(id) {
    return this.run?.known.get(id) ?? this.known?.get(id) ?? { id, start: NaN, label: 'Outcome ' + id, family: 'other' }
  }
  holdFor(legId, code, message) {
    const id = marketOfLeg(legId)
    const m = this.marketInfo(id)
    return {
      coin: '+' + legId,
      legIdx: Number(legId) % 10,
      marketId: id,
      label: m.label + (Number(legId) % 10 ? ' · NO' : ' · YES'),
      start: Number.isFinite(m.start) ? m.start : null,
      code,
      message,
    }
  }
  /** A hold for every held leg, for a stop that also stops selling. */
  holdsForAll(reason, positions = this.ledger?.positions ?? {}) {
    return Object.keys(positions).map((legId) => this.holdFor(legId, 'stopped', reason + ' ' + sellByHand))
  }

  // ---- stopping ------------------------------------------------------------------------------------------------
  /**
   * Cancel every order of this runner, settle fills, close the receipt. keepResume keeps the saved run so a headless
   * restart can reconcile and resume it (a shutdown signal); every other stop forgets it.
   */
  async cancel(reason = 'Stopped by user', { keepResume = false } = {}) {
    const receiptId = this.run?.receiptId ?? this.pendingStop
    this.pendingStop = receiptId
    if (this.run) this.known = this.run.known
    this.run = null
    if (!keepResume) this.forgetRun()
    try {
      const after = await this.clearOrders()
      // Fills that happened before the cancel took effect go into the ledger now. If this fails, the next start
      // retries it before reconciling, and a mismatch blocks quoting until it is reviewed.
      try {
        this.ledger ??= this.openLedger(this.now())
        await this.syncFills(after, this.now())
      } catch (e) {
        this.notice = 'Stopped · fills will be checked again before the next start: ' + e.message
      }
      if (receiptId) this.journal.finish(receiptId, reason + ' · cancellation verified', inventory(after.balances))
      this.pendingStop = null
      return after
    } catch (e) {
      if (receiptId) this.journal.finish(receiptId, reason + ' · cancellation unconfirmed')
      throw e
    }
  }
  forgetRun() {
    try {
      this.journal.saveState('run', null)
    } catch {}
  }
  /** Stop everything: every order cancelled (held shares will not be sold), the timer cleared, mainnet disarmed. */
  async stopAll(reason = 'Stopped everything by user') {
    const positions = { ...(this.ledger?.positions ?? {}) }
    const after = await this.cancel(reason)
    this.holds = this.holdsForAll('Everything was stopped, so these shares are not being sold.', positions)
    this.arming = null
    try {
      this.armingStore?.clear()
    } catch {}
    this.notice = 'Everything is stopped. Held shares are not being sold.'
    return after
  }
  /** A shutdown signal: cancel every owned order, verify, clear the timer. The run is kept for a headless resume. */
  async shutdown(reason = 'Stopped by shutdown') {
    return this.cancel(reason, { keepResume: true })
  }
  async sendCancels(rows, { swallow = () => true } = {}) {
    if (!rows.length) return
    const client = this.clientNow()
    for (const batch of cancelBatches(rows, this.policy.requests.cancelBatchMax)) {
      recordExchangeWeight(batch.length, this.now())
      await client.cancel({ cancels: batch }, this.opts).catch((e) => {
        if (!swallow(e)) throw e
      })
    }
  }
  async clearOrders() {
    const cancelVisible = async () => {
      const rows = ownedOrders((await this.read.accountView(this.target, true)).orders, this.wallet.address)
      if (rows.length) await this.sendCancels(cancelRows(rows))
    }
    await cancelVisible()
    const wait = this.profile.expires - this.now()
    if (wait > 0) {
      await this.sleep(Math.min(wait, 10000) + 150)
      await cancelVisible()
    }
    const after = await this.read.accountView(this.target, true)
    if (ownedOrders(after.orders, this.wallet.address).length)
      throw Error('Cancellation is pending exchange confirmation.')
    if (this.profile.deadline > this.now()) {
      // The SDK selects the action overload by presence of the time property.
      // An undefined time clears the timer while preserving the target subaccount.
      recordExchangeWeight(1, this.now())
      await this.clientNow().scheduleCancel({ time: undefined }, this.opts)
      this.profile.deadline = 0
      await this.save()
    }
    this.notice = 'Stopped · no runner orders reported on ' + this.network
    return after
  }
  async hardStop(e) {
    this.holds = this.holdsForAll('Stopped for review: ' + e.message)
    this.notice = e.message
    try {
      await this.cancel(e.message)
      this.notice = 'Stopped · ' + e.message
    } catch (cleanup) {
      this.notice = e.message + ' · ' + cleanup.message
    }
    throw e
  }
  /** Withdraw resting bids we know of, without a read. Exits stay: they are above the floor and only reduce risk. */
  async withdrawBids(now) {
    const bids = Object.entries(this.ledger?.pending ?? {}).filter(
      ([, p]) => p.side === 'B' && Number.isSafeInteger(p.oid) && !p.unacked
    )
    // Without the budget for it, the bids stay until the disconnect timer, which is not re-armed meanwhile.
    if (!bids.length || !this.actions.can('cancel', bids.length, now)) return
    this.actions.spend('cancel', bids.length, now)
    try {
      await this.sendCancels(bids.map(([, p]) => ({ a: 100000000 + Number(p.legId), o: p.oid })))
    } catch {
      // The next readable tick finds whatever is still resting and plans it again.
    }
  }
  /** Stop bidding, keep selling: cancel every bid (batched), verify each with orderStatus. Exit asks stay. */
  async kill() {
    const run = this.run
    if (!run) throw Error('Nothing is running.')
    const now = this.now()
    run.killed = { at: now }
    run.events.kill = true
    run.bidBlock = block('kill')
    this.notice = blockText.kill
    const view = await this.read.accountView(this.target, true)
    const bids = ownedOrders(view.orders, this.wallet.address).filter(
      (o) => (this.ledger?.pending?.[o.cloid]?.side ?? o.side) === 'B'
    )
    if (!bids.length) return
    // A user's stop is always sent; it is counted when the allowance has room.
    if (this.actions.can('cancel', bids.length, now)) this.actions.spend('cancel', bids.length, now)
    await this.sendCancels(cancelRows(bids))
    for (const o of bids) await this.confirmGone(o.oid, () => Error('A bid cancellation is not confirmed yet. No new bids are placed.'))
    this.notice = blockText.kill
  }
  resume() {
    if (!this.run) throw Error('Nothing is running.')
    if (this.safeMode) throw Error('Safe mode: the runner restarted several times. Only selling runs until it is restarted cleanly.')
    this.run.killed = null
    this.notice = 'Bidding resumes on the next check.'
  }
  async confirmGone(oid, fail) {
    for (let attempt = 0; ; attempt++) {
      const s = (await this.read.info('orderStatus', { user: this.target, oid }))?.order
      if (s && s.status !== 'open' && s.status !== 'triggered') return
      if (attempt >= blipRereads) throw fail()
      await this.sleep(rereadDelayMs)
    }
  }
  /** Per leg and side: wait after an order the exchange refused, longer each time it is refused again. */
  refused(run, legId, side, now) {
    const key = legId + ':' + side
    const count = (run.cooldowns.get(key)?.count ?? 0) + 1
    const { backoffMaxMs } = this.actionPolicy()
    const wait = Math.min(backoffMaxMs, this.policy.requests.minRequoteMs * 2 ** (count - 1))
    run.cooldowns.set(key, { count, until: now + wait })
  }
  coolingUntil(run, legId, side) {
    return run.cooldowns.get(legId + ':' + side)?.until ?? 0
  }

  // ---- markets -------------------------------------------------------------------------------------------------
  remember(catalog) {
    for (const m of catalog) this.run.known.set(m.id, { id: m.id, start: m.start, label: m.label, family: m.family, width: m.width })
  }
  /**
   * The quotable markets: { id, start, label, family, pool, width, rollover? }. Testnet: the venue's listed games, no
   * pools, the fixed testnet band. Mainnet: the reward feed through mainnetCatalog and the rollover watcher.
   */
  async catalog(now) {
    if (this.network === 'testnet') {
      const rows = await this.read.markets()
      return rows.map((m) => ({
        ...m,
        family: familyOf({ questionName: m.questionName, description: m.description }),
        pool: null,
        width: testnetWidth,
      }))
    }
    const run = this.run
    if (run && this.lastCatalog && now - run.catalogAt < this.policy.rollover.refreshMs) return this.lastCatalog
    let next = null
    try {
      const { data, asOf } = await this.campaigns()
      const meta = await this.read.info('outcomeMeta')
      next = { entries: mainnetCatalog({ feed: data, meta, now }), asOf }
    } catch (e) {
      if (isRateLimit(e)) throw e
      next = null
    }
    if (!run) {
      if (!next) throw Error('The reward feed could not be read.')
      return (this.lastCatalog = next.entries.map((e) => ({ ...e, rollover: 'active' })))
    }
    const events = { fills: [...run.events.fills], kill: run.events.kill, lossStop: run.events.lossStop }
    run.events = { fills: new Set(), kill: false, lossStop: false }
    run.rollover = campaignTransition({ prev: run.rollover, next, now, policy: this.policy, events })
    run.catalogAt = now
    const rows = []
    for (const [id, s] of run.rollover) {
      if (!s.row) continue
      rows.push({ ...s.row, id, rollover: s.state, replan: !!s.replan })
    }
    return (this.lastCatalog = rows)
  }
  static reasonText = {
    family: 'You chose not to quote this kind of market.',
    futures: 'Futures and price markets are not quoted.',
    start: 'The market starts too soon, or its start time is unknown.',
    bid_stop: 'Your bid stop for this kind of market is reached.',
    not_picked: 'Not among the markets you picked.',
    excluded: 'On your exclude list.',
    rolling: 'Rolling short-horizon markets are excluded.',
    pool: 'No reward pool for this market.',
    budget: 'Your budget is already used by other markets.',
    count: 'You chose fewer markets at once.',
    minimum: 'Your size per side is under the smallest order the exchange accepts.',
    book: 'Waiting for a fresh two-sided book.',
    closed: 'The market is no longer open to new quotes.',
  }
  /**
   * Settings for the automatic pick: the budget left after the cost of shares already held, and no more markets than
   * the runner carries.
   */
  rankSettings(settings, ledger) {
    return {
      ...settings,
      budgetUsd: Math.max(0, settings.budgetUsd - heldCostOf(ledger)),
      marketCount: Math.min(settings.marketCount, this.marketCap()),
    }
  }
  /** { chosen: [{ id, perSideUsd }], excluded: [{ id, reason }] } for 'auto' or a list of ids. */
  select(markets, catalog, settings, now, ledger = this.ledger) {
    const candidates = catalog.filter((m) => m.rollover === undefined || m.rollover === 'active')
    if (markets === 'auto')
      return rankMarkets(candidates, this.rankSettings(settings, ledger), this.policy, {
        minOwnUsd: minOrderUsd,
        now,
        network: this.network,
      })
    const ids = this.manualIds(markets, settings)
    const picked = autoPick(candidates, { ...settings, marketCount: ids.length }, { now, network: 'testnet', policy: this.policy, only: ids })
    const excluded = picked.excluded.filter((x) => x.reason !== 'not_picked')
    for (const id of ids) if (!catalog.some((m) => m.id === id)) excluded.push({ id, reason: 'closed' })
    return { chosen: picked.chosen.map((c) => ({ id: c.id, perSideUsd: settings.perSideUsd })), excluded }
  }
  manualIds(markets, settings) {
    const cap = Math.min(this.marketCap(), settings.marketCount)
    // Outcome ids start at 0 on the venue, so 0 is a valid market. Leg coins are #0 and #1.
    if (
      !Array.isArray(markets) ||
      !markets.length ||
      markets.length > cap ||
      new Set(markets).size !== markets.length ||
      !markets.every((id) => Number.isSafeInteger(id) && id >= 0)
    )
      throw Error(
        cap === 1 ? 'Choose one market, or let the runner pick.' : `Choose 1 to ${cap} different markets, or let the runner pick.`
      )
    return markets
  }

  // ---- books ---------------------------------------------------------------------------------------------------
  feedFor(network) {
    if (this.feeds[network] !== undefined) return this.feeds[network]
    const wanted = this.socketFactory === null ? false : this.socketFactory !== undefined || this.realVenue
    if (!wanted) return (this.feeds[network] = null)
    const read = this.readFor(network)
    this.feeds[network] = new BookFeed({
      network,
      socketFactory: this.socketFactory ?? undefined,
      restBook: (coin) => read.info('l2Book', { coin }),
      now: this.now,
      policy: this.policy,
      log: (event) => this.log(event),
    })
    return this.feeds[network]
  }
  closeFeeds() {
    for (const feed of Object.values(this.feeds)) feed?.close()
    this.feeds = {}
  }
  /**
   * Both leg books per market: Map<id, [{ book, maxAge, time }, ...]>. Websocket books count as fresh while the feed
   * vouches for them; REST books are fresh for 6 s. rest: false reads the socket only (a backoff).
   */
  async booksFor(ids, now, { resting = [], rest = true, subscribe = true } = {}) {
    const out = new Map()
    if (!ids.length) return out
    const feed = this.feed
    if (feed) {
      const coins = ids.flatMap(coinsOfOutcome)
      if (subscribe) feed.setCoins(coins)
      if (rest) await feed.ensure(coins, now, { resting })
      for (const id of ids)
        out.set(
          id,
          coinsOfOutcome(id).map((coin) => {
            const b = feed.book(coin, now)
            if (!b) return null
            // A live socket book is as old as the market is quiet; the feed's liveness rule vouches for it.
            return b.source === 'ws'
              ? { book: { ...b.book, coin, time: now }, maxAge: Infinity, time: now }
              : { book: b.book, maxAge: restBookMaxAgeMs, time: b.book.time }
          })
        )
      return out
    }
    if (!rest) return out
    const books = await this.read.readBooks(ids)
    for (const id of ids)
      out.set(
        id,
        (books.get(id) ?? []).map((book) => (book ? { book, maxAge: restBookMaxAgeMs, time: book.time } : null))
      )
    return out
  }

  // ---- the loop ------------------------------------------------------------------------------------------------
  async tick() {
    if (!this.run) return
    const now = this.now()
    this.lastTickAt = now
    if (now < this.run.backoffUntil) return this.exitPass(now)
    try {
      await this.step(now)
      if (this.run) {
        this.run.failures = 0
        this.run.unclassified = 0
        this.run.rate = null
        this.run.errorBlock = null
        this.run.backoffCode = null
        // The step reported its blocks with the old error state; a clean step clears that one.
        if (['errors', 'backoff'].includes(this.run.bidBlock?.code)) {
          this.run.bidBlock = this.firstBlock(this.run, now)
          if (!this.run.bidBlock) this.notice = 'Quoting on ' + this.network
        }
      }
    } catch (e) {
      return this.handleError(e, now)
    }
  }
  async handleError(e, now) {
    const run = this.run
    if (!run) throw e
    if (e?.integrity) return this.hardStop(e)
    if (isRateLimit(e)) {
      // Never counted toward the error block: wait as the venue asks and come back.
      const next = nextBackoff(run.rate, { now, retryAfterMs: e.retryAfterMs, policy: this.policy })
      run.rate = next.state
      run.backoffUntil = next.until
      run.backoffCode = 'backoff'
      run.bidBlock = this.firstBlock(run, now)
      await this.withdrawBids(now)
      this.notice = blockText.backoff + ' Retrying in ' + Math.round((run.backoffUntil - now) / 1000) + ' s.'
      return
    }
    if (String(e?.message).includes(budgetReached)) {
      run.bidBlock = block('actions')
      await this.withdrawBids(now)
      this.notice = blockText.actions
      return
    }
    run.failures += 1
    const steps = this.policy.requests.backoffMs
    let wait = steps[Math.min(run.failures - 1, steps.length - 1)]
    // A failure that is not a passing blip (a bug, a request the venue refuses) blocks bids at once.
    if (!isTransient(e)) run.unclassified += 1
    if (run.failures >= maxTransientInARow || run.unclassified > 0) {
      run.errorBlock = block(
        'errors',
        (run.failures >= maxTransientInARow ? 'Ten checks in a row failed. Last problem: ' : 'A check failed: ') +
          e.message +
          '. Bids are withdrawn; selling is retried every minute.'
      )
      wait = Math.max(wait, errorRetryMs)
    }
    run.backoffUntil = now + wait
    run.backoffCode = 'backoff-errors'
    run.bidBlock = this.firstBlock(run, now)
    await this.withdrawBids(now)
    this.notice =
      (run.errorBlock ? run.errorBlock.message : 'Paused · ' + e.message) +
      ' Retrying in ' +
      Math.round((run.backoffUntil - now) / 1000) +
      ' s.'
  }
  /**
   * During a backoff: at most one account read per 30 s, books from the websocket only, and only forced sells (and
   * the cancels before them) for legs in the force or sweep stage or inside the last 90 s.
   */
  async exitPass(now) {
    const run = this.run
    if (now - (run.exitReadAt ?? -Infinity) < exitReadEveryMs) return
    const due = Object.keys(this.ledger?.positions ?? {}).some((legId) => {
      const m = run.known.get(marketOfLeg(legId))
      return forcing(exitPhase({ start: m?.start, now, family: m?.family, policy: this.policy }))
    })
    if (!due) return
    run.exitReadAt = now
    try {
      await this.step(now, { exitsOnly: true })
    } catch (e) {
      if (e?.integrity) return this.hardStop(e)
      // Anything else waits for the backoff to end; the next exit pass tries again.
      this.notice = 'Selling check failed: ' + e.message
    }
  }
  async readAccount() {
    for (let attempt = 0; ; attempt++) {
      try {
        const [p, view] = await Promise.all([
          this.read.permissions(this.owner, this.wallet.address),
          this.read.accountView(this.target),
        ])
        this.checkApproval(p)
        this.dedicatedView(view)
        return { p, view }
      } catch (e) {
        if (!blipText.test(String(e?.message))) throw e
        if (attempt >= blipRereads) throw integrity(e.message)
        await this.sleep(rereadDelayMs)
      }
    }
  }
  /** The run-wide bid block: the first open one in bidBlockOrder, or null. */
  firstBlock(run, now, facts = run.facts ?? {}) {
    const open = {
      kill: !!run.killed,
      'safe-mode': this.safeMode,
      'loss-day': !!facts.lossDay,
      'loss-hour': !!facts.lossHour,
      actions: this.actions.snapshot(now).entriesLeft < bidActionsNeeded,
      'address-limit': !!this.headroom && this.headroom.left <= this.policy.requests.addressReserve,
      backoff: run.backoffCode === 'backoff' && now < run.backoffUntil,
      errors: !!run.errorBlock,
      'session-end': !!run.sessionEnded,
      hours: facts.hoursOpen === false,
      feed: !!facts.feedLost,
    }
    const code = bidBlockOrder.find((c) => open[c])
    if (!code) return null
    if (code === 'errors') return run.errorBlock
    return block(code)
  }
  async step(now, { exitsOnly = false } = {}) {
    const run = this.run
    if (now + 6000 >= run.endsAt) run.sessionEnded ??= now
    let { p, view } = await this.readAccount()
    if (!exitsOnly) {
      const catalog = await this.catalog(now)
      this.remember(catalog)
      run.catalog = catalog
      await this.checkSettled(catalog)
    }
    const startedLeg = (legId) => startBlocked(run.known.get(marketOfLeg(legId))?.start, now)

    // Fills, ledger, reconcile. One re-read covers a fill landing between the order and balance reads.
    const filledMarkets = new Set()
    for (let attempt = 0; ; attempt++) {
      for (const m of await this.syncFills(view, now)) filledMarkets.add(m)
      this.commit(this.dropGone(this.ledger, view.balances, startedLeg))
      const check = reconcile(this.ledger, view.balances)
      if (check.ok) break
      if (attempt) throw integrity('The position record does not match the account. Review remaining inventory.')
      ;({ p, view } = await this.readAccount())
    }
    const owned = ownedOrders(view.orders, this.wallet.address)
    for (const o of owned)
      if (!this.ledger.pending[o.cloid]) throw integrity('An unrecorded runner order is resting. Review the account.')

    // The session is over and nothing is held: stop cleanly.
    if (run.sessionEnded && !Object.keys(this.ledger.positions).length) {
      this.holds = []
      await this.cancel('Session ended')
      this.notice = 'Session ended · no runner orders reported on ' + this.network
      return
    }

    // Selection: every reselectMs in auto mode, against the budget left after held shares. Markets with shares or
    // resting orders stay, exits only.
    const settings = run.settings
    if (!exitsOnly && run.mode === 'auto' && now - run.rankedAt >= this.policy.selection.reselectMs) {
      const ranked = this.select('auto', run.catalog, settings, now)
      run.chosen = ranked.chosen.map((c) => ({ id: c.id, perSideUsd: c.perSideUsd }))
      run.excluded = ranked.excluded
      run.rankedAt = now
    }
    const listed = new Set((run.catalog ?? []).map((m) => m.id))
    const rolloverOf = (id) => run.rollover?.get(id)?.state ?? null
    const chosen = new Map(
      exitsOnly
        ? []
        : run.chosen.filter((c) => listed.has(c.id) && rolloverOf(c.id) !== 'ended').map((c) => [c.id, c])
    )
    const heldIds = Object.keys(this.ledger.positions).map(marketOfLeg)
    const restingIds = Object.values(this.ledger.pending).map((x) => marketOfLeg(x.legId))
    let active = [...new Set([...chosen.keys(), ...heldIds, ...restingIds])]
    if (exitsOnly) active = active.filter((id) => heldIds.includes(id) || restingIds.includes(id))
    this.sizeActions(Math.max(1, active.length))
    const restingCoins = owned.map((o) => o.coin)
    const books = await this.booksFor(active, now, { resting: restingCoins, rest: !exitsOnly, subscribe: !exitsOnly })

    // Tops and levels per market; a market without a fresh book is stale.
    const tops = new Map()
    const levelsOf = new Map()
    const bookTimes = new Map()
    const stale = new Set()
    for (const id of active) {
      try {
        const rows = books.get(id)
        tops.set(id, [0, 1].map((i) => bookTop(rows?.[i]?.book, '#' + legOf(id, i), now, rows?.[i]?.maxAge)))
        levelsOf.set(id, [0, 1].map((i) => bookLevels(rows[i].book, '#' + legOf(id, i), now, rows[i].maxAge)))
        bookTimes.set(id, Math.min(rows[0].time, rows[1].time))
      } catch {
        stale.add(id)
      }
    }

    // Marks, the day's loss and the hour's loss, account wide.
    const marks = {}
    for (const legId of Object.keys(this.ledger.positions)) {
      const top = tops.get(marketOfLeg(legId))?.[Number(legId) % 10]
      marks[legId] = Number.isFinite(top?.bestBid) ? top.bestBid : null
    }
    const rates = this.feeRates()
    const pnl = markedPnl(this.ledger, marks, { feeRate: rates.sellTaker })
    if (run.lastDay !== this.ledger.day) {
      if (run.lastDay) run.carry += run.lastRealized ?? 0
      run.lastDay = this.ledger.day
    }
    run.lastRealized = this.ledger.realizedUsd
    run.history = [...run.history.filter((h) => h.at > now - historyKeepMs), { at: now, totalUsd: run.carry + pnl.totalUsd }]
    const hourly = hourlyLoss({ history: run.history, now, stopUsd: settings.hourlyLossStopUsd })
    const lossDay = pnl.markedLossUsd >= settings.dailyLossStopUsd
    if ((lossDay || hourly.breached) && !run.lossStopped) run.events.lossStop = true
    run.lossStopped = lossDay || hourly.breached
    this.saveMarks(now, marks)
    if (!exitsOnly) {
      await this.readHeadroom(now)
      await this.readRewards(now, active)
    }
    const hoursOpen = quotingHoursOpen(settings.hours, now)
    run.facts = { lossDay, lossHour: hourly.breached, hoursOpen, feedLost: active.length > 0 && stale.size === active.length }
    run.bidBlock = exitsOnly ? (this.firstBlock(run, now) ?? block('backoff')) : this.firstBlock(run, now)
    const heldLegs = Math.max(1, Object.keys(this.ledger.positions).length)
    const lossBudgetLeftUsd = Math.max(0, settings.dailyLossStopUsd - pnl.markedLossUsd) / heldLegs
    const venueShares = (legId) => Number(view.balances.find((b) => b.coin === '+' + legId)?.total ?? 0)

    // Plan every market.
    const restingOf = (id) =>
      owned
        .filter((o) => marketOfLeg(o.coin.slice(1)) === id)
        .map((o) => {
          const x = this.ledger.pending[o.cloid]
          return {
            oid: o.oid,
            cloid: o.cloid,
            legIdx: Number(x.legId) % 10,
            b: x.side === 'B',
            px: x.px,
            sz: Number(o.sz),
            placedAt: x.placedAt,
          }
        })
    const cancels = []
    const places = []
    const keptBidUsd = { total: 0 }
    const deskMarkets = []
    const holds = []
    let samplesChanged = false
    for (const id of active) {
      const market = run.known.get(id) ?? { id, start: NaN, label: 'Outcome ' + id, family: 'other' }
      const width = Number.isFinite(market.width) && market.width > 0 ? market.width : testnetWidth
      const resting = restingOf(id)
      const state = run.markets.get(id) ?? emptyMarketState()
      const phase = exitPhase({ start: market.start, now, family: market.family, policy: this.policy })
      const report = (status, reason) => deskMarkets.push({ id, label: market.label, start: market.start, state: status, reason })
      const cutoff = quoteCutoff(market.start, p.until)
      const closing = !Number.isFinite(market.start) || now >= cutoff - closeMarginMs
      const heldHere = [0, 1].filter((i) => Number(this.ledger.positions[legOf(id, i)]?.shares) > 0)

      if (phase === 'started' || !(now < cutoff)) {
        cancels.push(...resting.map((r) => ({ ...r, id })))
        for (const i of heldHere)
          holds.push(this.holdFor(legOf(id, i), 'started', 'The market starts within a minute, so nothing more is sent. ' + sellByHand))
        report('stopped', heldHere.length ? 'The market starts within a minute. Sell any shares left by hand.' : 'The market starts within a minute.')
        continue
      }
      if (stale.has(id)) {
        // A stale book pulls this market's bids (all orders inside the last 90 s). Exits already resting stay.
        cancels.push(...resting.filter((r) => r.b || closing).map((r) => ({ ...r, id })))
        if (forcing(phase))
          for (const i of heldHere)
            holds.push(this.holdFor(legOf(id, i), 'feed', 'No fresh order book could be read, so no forced sale was sent. ' + sellByHand))
        report('pulled', 'Waiting for a fresh book.')
        continue
      }
      const legs = tops.get(id)
      const levels = levelsOf.get(id)
      // Exit samples per held leg, from the same book the forced sell is checked against.
      if (heldHere.length) {
        const mt = marketTops(legs, resting, levels)
        const ml = effectiveLevels(withoutOwnLevels(levels, resting))
        for (const i of heldHere) {
          const legId = legOf(id, i)
          run.samples[legId] = recordSample(run.samples[legId], { top: mt[i], levels: ml[i], now, policy: this.policy })
          samplesChanged = true
        }
      }
      const eff = effectiveTops(legs)
      const mid = yesMid(legs)
      const roll = rolloverOf(id)
      const marketBlock =
        run.bidBlock ??
        (!chosen.has(id)
          ? block('exit-only', 'Not among the markets you chose right now. Only your shares are offered.')
          : roll === 'hold'
            ? block('rollover')
            : null)
      const plan = planMarket({
        now,
        market,
        books: legs,
        levels,
        mid,
        width,
        settings,
        policy: this.policy,
        position0: this.ledger.positions[legOf(id, 0)],
        position1: this.ledger.positions[legOf(id, 1)],
        state,
        restingOwn: resting,
        phase,
        forceAt: forceAtOf({ start: market.start, family: market.family, policy: this.policy }),
        samples: [run.samples[legOf(id, 0)] ?? [], run.samples[legOf(id, 1)] ?? []],
        bidBlock: marketBlock,
        lossBudgetLeftUsd,
        available: [0, 1].map((i) => venueShares(legOf(id, i))),
        feeRates: rates,
        filled: filledMarkets.has(id),
        perSideUsd: chosen.get(id)?.perSideUsd ?? settings.perSideUsd,
      })
      run.markets.set(id, plan.state)
      for (const h of plan.holds) holds.push(this.holdFor(legOf(id, h.legIdx), h.code, h.message))
      let diff
      if (closing) {
        // Inside the last 90 s: every resting order goes; forced IOC sells continue until the cutoff.
        diff = { cancels: resting.map((r) => r.oid), places: plan.desired.filter((d) => d.tif === 'Ioc'), keeps: [] }
      } else {
        diff = diffOrders(resting, plan.desired, {
          now,
          policy: this.policy,
          mid,
          width,
          legs: eff,
          force: filledMarkets.has(id) || plan.status === 'pulled' || !!run.catalog?.find((m) => m.id === id)?.replan,
          fraction: settings.depthFraction,
          minRequoteMs: settings.requoteMs,
        })
        // A reward rollover hold leaves resting bids exactly as they are while the market is still open to bids.
        if (roll === 'hold' && !run.bidBlock && phase === 'open')
          diff.cancels = diff.cancels.filter((oid) => !resting.find((r) => r.oid === oid)?.b)
      }
      cancels.push(...resting.filter((r) => diff.cancels.includes(r.oid)).map((r) => ({ ...r, id })))
      for (const r of resting) if (r.b && diff.keeps.includes(r.oid)) keptBidUsd.total += r.px * r.sz
      // An order the exchange refused waits out its leg's cooldown. A forced IOC is never held back by it, only spaced.
      const cooled = diff.places.filter((d) =>
        d.tif === 'Ioc'
          ? (run.forcedAt[legOf(id, d.legIdx)] ?? -Infinity) > now - forcedRetryMs
          : this.coolingUntil(run, legOf(id, d.legIdx), d.b ? 'B' : 'A') > now
      )
      let toPlace = diff.places.filter((d) => !cooled.includes(d))
      if (exitsOnly) toPlace = toPlace.filter((d) => d.tif === 'Ioc')
      places.push(...toPlace.map((d) => ({ ...d, id, bookTime: bookTimes.get(id) })))
      const exitWait = cooled
        .filter((d) => !d.b && d.tif !== 'Ioc')
        .map((d) => this.coolingUntil(run, legOf(id, d.legIdx), 'A') - now)
      report(
        plan.status,
        exitWait.length
          ? 'The exchange refused the offer for your shares. Trying again in ' + Math.ceil(Math.max(...exitWait) / 1000) + ' s.'
          : cooled.length && plan.status === 'quoting'
            ? 'The exchange refused a bid. Retrying shortly.'
            : plan.reason
      )
    }
    if (samplesChanged && now - (run.samplesSavedAt ?? -Infinity) >= sampleSaveMs) {
      try {
        this.journal.saveState('exitSamples', run.samples)
        run.samplesSavedAt = now
      } catch {}
    }
    this.holds = holds

    // Cancels first, verified with orderStatus. Any fill found means the plan is stale: no placements this tick.
    // A cancel the action budget cannot pay for also means no placements: the plan assumed it went out.
    let freshFill = false
    let unpaid = false
    const sent = []
    if (cancels.length) {
      if (this.actions.can('cancel', cancels.length, now)) {
        this.actions.spend('cancel', cancels.length, now)
        sent.push(...cancels)
      } else {
        // Bids first when only part fits: withdrawing a bid only lowers risk.
        const bidsFirst = [...cancels.filter((c) => c.b), ...cancels.filter((c) => !c.b)]
        const left = this.actions.snapshot(now).left
        if (left > 0) {
          this.actions.spend('cancel', left, now)
          sent.push(...bidsFirst.slice(0, left))
        }
        unpaid = true
      }
    }
    if (sent.length) {
      // A cancel of an order that just filled is refused; the status read below tells what happened.
      await this.sendCancels(
        sent.map((r) => ({ a: 100000000 + Number(legOf(r.id, r.legIdx)), o: r.oid })),
        { swallow: (e) => e?.name === 'ApiRequestError' }
      )
      const after = { orders: view.orders.filter((o) => !sent.some((c) => c.oid === o.oid)), balances: view.balances }
      for (const c of sent)
        await this.confirmGone(c.oid, () => integrity('A cancellation is not confirmed by the exchange. Review the account.'))
      freshFill = (await this.syncFills(after, now)).size > 0
    }

    // Budget: held shares, kept bids and new bids together stay inside the user's budget and the cash on the account.
    const cash = view.balances.find((b) => b.coin === 'USDC')
    const restingBidUsd = owned
      .filter((o) => this.ledger.pending[o.cloid]?.side === 'B')
      .reduce((n, o) => n + Number(o.sz) * Number(o.limitPx), 0)
    const cashFree = Number(cash?.total) - Number(cash?.hold) + restingBidUsd
    let committed = keptBidUsd.total * (1 + rates.buy)
    const heldCost = heldCostOf(this.ledger)
    const limit = Math.min(settings.budgetUsd - heldCost, Number.isFinite(cashFree) ? cashFree : 0)
    let sendable = []
    for (const d of freshFill || unpaid ? [] : places) {
      if (d.b && run.bidBlock) continue
      if (d.b) {
        const cost = d.px * d.sz * (1 + rates.buy)
        if (committed + cost > limit + 1e-9) {
          const m = deskMarkets.find((x) => x.id === d.id)
          if (m) m.reason = 'Your budget or account cash is fully used.'
          continue
        }
        committed += cost
      }
      sendable.push(d)
    }

    // Never sell more than the ledger holds and the venue shows, and never below the exit floor.
    const remainingOwned = owned.filter((o) => !sent.some((c) => c.oid === o.oid))
    const selling = {}
    for (const o of remainingOwned) {
      const x = this.ledger.pending[o.cloid]
      if (x.side === 'A') selling[x.legId] = (selling[x.legId] ?? 0) + Number(o.sz)
    }
    for (const d of sendable.filter((x) => !x.b)) {
      const legId = legOf(d.id, d.legIdx)
      selling[legId] = (selling[legId] ?? 0) + d.sz
      const pos = this.ledger.positions[legId]
      if (!pos || selling[legId] > pos.shares + 1e-9 || selling[legId] > venueShares(legId) + 1e-9)
        throw integrity('Refusing to offer more shares than are held. Review the account.')
      if (!(d.floor > 0) || d.px < d.floor - 1e-12) throw integrity('Refusing to sell below the exit floor.')
    }

    // Bids only from the entry allowance, so the reserve for exits, cancels and the timer is never touched by them.
    const bidCount = sendable.filter((d) => d.b).length
    if (bidCount && !this.actions.can('order', bidCount + 1, now, { priority: 'bid' })) {
      run.bidBlock = block('actions')
      sendable = sendable.filter((d) => !d.b)
    }
    const exitCount = sendable.length - sendable.filter((d) => d.b).length
    if (exitCount && !this.actions.can('order', sendable.length + 1, now, { priority: 'exit' })) {
      sendable = []
      const m = deskMarkets.find((x) => x.state !== 'stopped')
      if (m) m.reason = 'The hourly exchange action allowance is used. Offers resume when it frees up.'
    }

    // The dead man's switch is armed whenever orders rest, bounded by the earliest cutoff among them. A forced IOC
    // never rests and needs no timer. Without the budget to re-arm it nothing new that rests is placed.
    const restingAfter = new Set([
      ...remainingOwned.map((o) => marketOfLeg(o.coin.slice(1))),
      ...sendable.filter((d) => d.tif !== 'Ioc').map((d) => d.id),
    ])
    if (restingAfter.size && !exitsOnly && !(await this.armDeadline(now, restingAfter, p)))
      sendable = sendable.filter((d) => d.tif === 'Ioc')
    if (exitsOnly) sendable = sendable.filter((d) => d.tif === 'Ioc')

    if (sendable.length) {
      const bids = sendable.filter((d) => d.b).length
      if (bids) this.actions.spend('order', bids, now, { priority: 'bid' })
      if (sendable.length > bids) this.actions.spend('order', sendable.length - bids, now, { priority: 'exit' })
      await this.place(sendable, now, run)
    }
    this.last = this.snapshot(deskMarkets, pnl, settings, hourly)

    // The session is over, nothing rests and every held leg's market has started: nothing more can be done.
    if (
      run.sessionEnded &&
      !sendable.length &&
      !remainingOwned.length &&
      Object.keys(this.ledger.positions).every(startedLeg)
    ) {
      const kept = this.holds
      await this.cancel('Session ended')
      this.holds = kept
      this.notice = 'Session ended with shares held. ' + sellByHand
      return
    }
    const quoting = sendable.some((d) => d.b) || remainingOwned.some((o) => this.ledger.pending[o.cloid]?.side === 'B')
    this.notice = run.bidBlock
      ? run.bidBlock.message
      : quoting || remainingOwned.length
        ? 'Quoting on ' + this.network
        : 'Watching markets'
  }
  /** Returns true when the timer is armed far enough out, false when the action budget cannot pay to re-arm it. */
  async armDeadline(now, ids, p) {
    const { deadlineMs, rearmEveryMs } = this.policy.dms
    const cutoffs = [...ids].map((id) => quoteCutoff(this.run.known.get(id)?.start ?? NaN, p.until))
    const ends = this.run.sessionEnded ? Infinity : this.run.endsAt
    const target = Math.min(now + deadlineMs, ends, p.until || Infinity, ...cutoffs)
    const current = this.profile.deadline ?? 0
    const due = !(current > now) || target < current || (current - now < deadlineMs - rearmEveryMs && target > current)
    if (!due) return true
    if (!(target > now + 6000))
      throw integrity('Session, market or agent is too close to expiry to arm the disconnect timer.')
    if (!this.actions.can('scheduleCancel', 1, now)) return false
    this.actions.spend('scheduleCancel', 1, now)
    try {
      recordExchangeWeight(1, now)
      await this.client.scheduleCancel({ time: target }, this.opts)
    } catch (e) {
      throw integrity('The disconnect timer could not be armed: ' + e.message)
    }
    this.profile.deadline = target
    await this.save()
    return true
  }
  async place(sendable, now, run) {
    const rests = sendable.some((d) => d.tif !== 'Ioc')
    const expiresAfter = Math.min(
      now + 4000,
      ...sendable.map((d) => (Number.isFinite(d.bookTime) ? d.bookTime : now) + 6000),
      rests ? this.profile.deadline - 1000 : Infinity
    )
    if (expiresAfter <= now + 500) throw new TransientError('Book or authorization is too close to expiry.')
    const orders = sendable.map((d) => ({
      a: 100000000 + Number(legOf(d.id, d.legIdx)),
      b: d.b,
      p: String(Number(d.px.toFixed(5))),
      s: String(d.sz),
      r: false,
      t: { limit: { tif: d.tif } },
      c: orderPrefix(this.wallet.address) + randomBytes(6).toString('hex'),
    }))
    // The actions were counted by the caller. The ledger, with every order about to be signed, is committed before
    // the request leaves.
    const ledger = { ...this.ledger, pending: { ...this.ledger.pending } }
    orders.forEach((o, i) => {
      ledger.pending[o.c] = {
        legId: legOf(sendable[i].id, sendable[i].legIdx),
        side: o.b ? 'B' : 'A',
        px: Number(o.p),
        sz: sendable[i].sz,
        tif: sendable[i].tif,
        placedAt: now,
        expiresAfter,
        unacked: true,
      }
    })
    this.commit(ledger)
    this.profile.expires = expiresAfter
    await this.save()
    this.journal.record(run.receiptId, orders)
    if (this.now() >= expiresAfter) throw new TransientError('Quote expired before signing.')
    let result
    try {
      recordExchangeWeight(orders.length, now)
      result = await this.client.order(
        { orders, grouping: 'na', builder: builderPayload(this.fee) },
        { ...this.opts, expiresAfter }
      )
    } catch (e) {
      const statuses = e?.response?.response?.data?.statuses
      if (e?.name === 'ApiRequestError' && Array.isArray(statuses)) result = e.response
      // Only a lost or throttled request is worth a retry. A refused request, a bug or a request the SDK rejects
      // before sending is not; the orders stay pending and unacknowledged until their expiry settles them.
      else if (isRateLimit(e)) throw e
      else if (isTransient(e)) throw new TransientError('Order request not confirmed: ' + e.message)
      else throw e
    }
    this.journal.acknowledge(orders, result)
    const statuses = result?.response?.data?.statuses ?? []
    const next = { ...this.ledger, pending: { ...this.ledger.pending } }
    let refused = null
    orders.forEach((o, i) => {
      const s = statuses[i]
      const d = sendable[i]
      const legId = legOf(d.id, d.legIdx)
      const side = d.b ? 'B' : 'A'
      const oid = s?.resting?.oid ?? s?.filled?.oid
      const answered = !!s?.error || Number.isSafeInteger(oid)
      if (answered && d.tif === 'Ioc') run.forcedAt[legId] = now
      if (s?.error) {
        refused ??= s.error
        delete next.pending[o.c]
        // An IOC that finds nothing to match is answered with an error too; it is planned again, spaced out.
        if (d.tif !== 'Ioc') this.refused(run, legId, side, now)
      } else if (Number.isSafeInteger(oid)) {
        next.pending[o.c] = { ...next.pending[o.c], oid, unacked: false }
        run.cooldowns.delete(legId + ':' + side)
      }
    })
    this.commit(next)
    if (refused) this.notice = 'The exchange refused an order: ' + refused
  }
  snapshot(deskMarkets, pnl, settings, hourly) {
    const rates = this.feeRates()
    const positions = Object.entries(this.ledger.positions).map(([legId, pos]) => {
      const exit = Object.values(this.ledger.pending).find((x) => x.legId === legId && x.side === 'A')
      const m = this.marketInfo(marketOfLeg(legId))
      return {
        coin: '+' + legId,
        marketId: marketOfLeg(legId),
        label: m.label,
        start: Number.isFinite(m.start) ? m.start : null,
        shares: pos.shares,
        avgCost: money(pos.cost / pos.shares),
        breakeven: breakevenPx(pos, rates.sellMaker),
        exitPx: exit?.px ?? null,
      }
    })
    return {
      markets: deskMarkets,
      positions,
      loss: {
        markedLossUsd: money(pnl.markedLossUsd),
        stopUsd: money(settings.dailyLossStopUsd),
        hourlyLossUsd: Number.isFinite(hourly?.lossUsd) ? money(hourly.lossUsd) : null,
        hourlyStopUsd: money(settings.hourlyLossStopUsd),
      },
    }
  }

  // ---- side reads: settlement, address allowance, marks, rewards -------------------------------------------------
  /** Once per catalog refresh: one settlement check for a subscribed outcome the listing no longer shows. */
  async checkSettled(catalog) {
    const feed = this.feed
    if (!feed || typeof this.read.settledOutcome !== 'function') return
    const candidates = feed.settledCandidates(catalog.map((m) => m.id))
    if (!candidates.length) return
    const run = this.run
    const id = candidates[run.settleCursor++ % candidates.length]
    try {
      const proof = await this.read.settledOutcome(id)
      if (isSettledProof(proof)) {
        feed.retire(id, 'settled')
        this.log({ event: 'settled', outcome: id })
      }
    } catch (e) {
      if (isRateLimit(e)) throw e
    }
  }
  async readHeadroom(now) {
    const run = this.run
    if (typeof this.read.userRateLimit !== 'function' || now - (run.headroomAt ?? -Infinity) < addressReadMs) return
    run.headroomAt = now
    try {
      const h = addressHeadroom(await this.read.userRateLimit(this.target))
      // An unusable answer keeps the last known headroom: unknown is never treated as plenty.
      if (h) this.headroom = { ...h, at: now }
    } catch (e) {
      if (isRateLimit(e)) throw e
    }
  }
  saveMarks(now, marks) {
    const run = this.run
    const day = dayOf(now)
    // A fill changes the shares held, so the day's saved marks are refreshed at once.
    if (!run.marksStale && run.marksDay === day && now - run.marksAt < markSaveMs) return
    const positions = {}
    const values = {}
    for (const [legId, pos] of Object.entries(this.ledger.positions)) {
      if (!Number.isFinite(marks[legId])) return // a leg without a mark: wait for a full set
      positions['#' + legId] = pos.shares
      values['#' + legId] = marks[legId]
    }
    try {
      this.journal.saveDayMarks(day, { positions, marks: values })
      run.marksDay = day
      run.marksAt = now
      run.marksStale = false
    } catch {}
  }
  /** Mainnet only, the run's own trading account only. An unusable answer stores nothing. */
  async readRewards(now, ids) {
    const run = this.run
    if (this.network !== 'mainnet' || !ids.length || now - (run.rewardsAt ?? -Infinity) < rewardReadMs) return
    run.rewardsAt = now
    try {
      const r = await this.scores({ marketIds: ids, wallet: this.target })
      if (r?.status === 'estimated' && Number.isFinite(r.usd))
        this.journal.saveRewards([{ earningDay: dayOf(now), usd: r.usd, status: 'estimated' }])
    } catch {
      // The estimate is optional; nothing is stored.
    }
  }

  // ---- preview and start ---------------------------------------------------------------------------------------
  /** Chosen markets, per-side size, opening debit and worst one-leg loss per market, for the current settings. */
  async preview(markets = 'auto') {
    const now = this.now()
    const settings = this.settings()
    const [p, catalog] = await Promise.all([this.read.permissions(this.owner, this.wallet.address), this.catalog(now)])
    const durations = this.durations(p.until, now)
    let ledger = this.ledger
    try {
      ledger ??= this.journal.loadLedger()
    } catch {
      ledger = null // start() refuses an unreadable record with its own message
    }
    const { chosen, excluded } = this.select(markets, catalog, settings, now, ledger)
    const books = await this.booksFor(chosen.map((c) => c.id), now, { subscribe: false })
    const rate = this.feeRates().buy
    const rows = []
    for (const c of chosen) {
      const m = catalog.find((x) => x.id === c.id)
      let legs
      let levels
      try {
        const b = books.get(c.id)
        legs = [0, 1].map((i) => bookTop(b?.[i]?.book, '#' + legOf(c.id, i), now, b?.[i]?.maxAge))
        levels = [0, 1].map((i) => bookLevels(b[i].book, '#' + legOf(c.id, i), now, b[i].maxAge))
      } catch {
        rows.push({ id: c.id, label: m.label, start: m.start, bids: [], reason: TestnetRunner.reasonText.book })
        continue
      }
      const plan = planMarket({
        now,
        market: { id: c.id, start: m.start, family: m.family },
        books: legs,
        levels,
        mid: yesMid(legs),
        width: m.width,
        settings,
        policy: this.policy,
        perSideUsd: c.perSideUsd,
        hoursOpen: quotingHoursOpen(settings.hours, now),
      })
      const bids = plan.desired.filter((d) => d.b)
      const costs = bids.map((d) => d.px * d.sz * (1 + rate))
      rows.push({
        id: c.id,
        label: m.label,
        start: m.start,
        bids: bids.map((d) => ({ side: d.legIdx ? 'NO' : 'YES', px: d.px, shares: d.sz })),
        perSideUsd: money(c.perSideUsd),
        debitUsd: money(costs.reduce((a, b) => a + b, 0)),
        worstOneLegLossUsd: money(Math.max(0, ...costs)),
        reason: bids.length ? null : plan.reason,
      })
    }
    return {
      network: this.network,
      durations,
      settings: this.publicSettings(settings),
      markets: rows,
      openingCostUsd: money(rows.reduce((a, r) => a + (r.debitUsd ?? 0), 0)),
      worstCaseUsd: money(rows.reduce((a, r) => a + (r.worstOneLegLossUsd ?? 0), 0)),
      excluded: excluded.map(({ id, reason }) => ({
        id,
        label: catalog.find((x) => x.id === id)?.label ?? 'Outcome ' + id,
        reason: TestnetRunner.reasonText[reason] ?? reason,
      })),
    }
  }
  async start({ dedicated, minutes = 15, markets = 'auto', network } = {}) {
    return this.startRun({ dedicated, minutes, markets, network })
  }
  async startRun({ dedicated, minutes, markets, network }, { endsAt: resumeEndsAt, receiptLabel } = {}) {
    const net = networkOf(network ?? this.network).name
    if (net === 'mainnet' && !this.mainnetSwitch) throw Error('Mainnet orders are not enabled in this build.')
    if (net !== this.network) await this.useNetwork(net)
    if (this.pendingStop) throw Error('Verify cancellation before starting a new session.')
    if (this.run || dedicated !== true) throw Error('Confirm the dedicated account.')
    const now = this.now()
    if (this.profile.expires > this.now()) throw Error('Waiting for the previous signed request to expire.')
    if (resumeEndsAt === undefined && minutes !== 0 && !runMinutes.includes(minutes))
      throw Error('Choose an available session duration.')
    if (markets !== 'auto') this.manualIds(markets, { marketCount: maxRunMarkets })
    if (this.actionSaveError) throw Error('The exchange action count could not be saved: ' + this.actionSaveError)
    const ack = startCheck(this.preferences.load().prefs)
    if (!ack.ok) throw Error(ack.message)
    if (net === 'mainnet') {
      const check = this.arming?.record ? await this.checkArming(this.arming.record) : { verified: false, reason: 'Mainnet is not armed.' }
      if (!check.verified) throw Error(check.reason ?? 'Mainnet is not armed.')
      this.client = this.clientFor(this.wallet, { network: 'mainnet', arming: this.armingForClient() })
    }
    await this.checkTarget()
    const settings = this.settings()
    const { p, view } = await this.readAccount()
    const bound = Math.min(p.until || Infinity, net === 'mainnet' ? this.arming.expiresAt : Infinity)
    const endsAt =
      resumeEndsAt ?? (minutes === 0 ? Math.min(bound, now + untilStoppedCapMs) : now + minutes * 60000)
    if (endsAt > bound) throw Error('Duration exceeds the agent approval' + (net === 'mainnet' ? ' or the arming.' : '.'))
    if (ownedOrders(view.orders, this.wallet.address).length) throw Error('Clear the previous run before starting.')

    // Held shares are allowed only when the saved ledger matches the account exactly.
    this.ledger = this.openLedger(now)
    await this.syncFills(view, now)
    this.commit(this.dropGone(this.ledger, view.balances, () => true))
    if (!reconcile(this.ledger, view.balances).ok)
      throw Error('The dedicated account holds outcome shares. Review remaining inventory before quoting again.')
    if (Object.keys(this.ledger.pending).length)
      throw Error('Earlier orders are still being reconciled. Try again in a moment.')

    const catalog = await this.catalog(now)
    const { chosen } = this.select(markets, catalog, settings, now)
    const heldIds = [...new Set(Object.keys(this.ledger.positions).map(marketOfLeg))]
    const ids = [...new Set([...chosen.map((c) => c.id), ...heldIds])]
    if (!ids.length) throw Error('No market fits your settings right now. Check the preview for reasons.')
    const label =
      receiptLabel ??
      (ids.length === 1 ? (catalog.find((m) => m.id === ids[0])?.label ?? 'Outcome ' + ids[0]) : ids.length + ' markets')
    const receiptId = this.journal.begin({
      markets: ids,
      label,
      budget: settings.budgetUsd,
      started: now,
      endsAt: Math.min(endsAt, 8.64e15),
      agent: this.wallet.address,
    })
    let samples = {}
    try {
      const saved = this.journal.loadState('exitSamples')
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) samples = saved
    } catch {}
    this.run = {
      receiptId,
      minutes,
      endsAt,
      mode: markets === 'auto' ? 'auto' : 'manual',
      ids: markets === 'auto' ? null : markets,
      settings,
      chosen: chosen.map((c) => ({ id: c.id, perSideUsd: c.perSideUsd })),
      excluded: [],
      rankedAt: now,
      markets: new Map(),
      known: new Map(),
      cooldowns: new Map(),
      forcedAt: {},
      samples,
      history: [],
      carry: 0,
      events: { fills: new Set(), kill: false, lossStop: false },
      rollover: null,
      catalogAt: now,
      catalog,
      settleCursor: 0,
      killed: null,
      bidBlock: null,
      errorBlock: null,
      failures: 0,
      unclassified: 0,
      backoffUntil: 0,
      rate: null,
    }
    this.holds = []
    this.needsReview = null
    this.last = null
    this.feedFor(this.network)
    this.remember(catalog)
    try {
      this.journal.saveState('run', { network: net, mode: this.run.mode, ids: this.run.ids, minutes, endsAt, dedicated: true })
    } catch {}
    await this.tick()
  }
  /**
   * Headless boot: cancel every owned order (batched), settle fills, reconcile, then resume the saved run only when
   * the ledger matches and, for mainnet, the arming still verifies. Otherwise nothing is bid or sold, every held leg
   * gets a hold, and health says the runner needs review. Safe mode resumes with bids blocked.
   */
  async resumeFromState() {
    const saved = (() => {
      try {
        return this.journal.loadState('run')
      } catch {
        return null
      }
    })()
    await this.cancel('Restarted', { keepResume: true })
    const now = this.now()
    const view = await this.read.accountView(this.target, true)
    this.ledger = this.openLedger(now)
    try {
      await this.syncFills(view, now)
    } catch (e) {
      return this.review('Fills could not be settled after the restart: ' + e.message, view)
    }
    this.commit(this.dropGone(this.ledger, view.balances, () => true))
    if (!reconcile(this.ledger, view.balances).ok || Object.keys(this.ledger.pending).length)
      return this.review('The saved position record does not match the account.', view)
    if (!saved?.network || saved.network !== this.network) return { resumed: false, reason: 'Nothing to resume.' }
    const held = Object.keys(this.ledger.positions).length > 0
    if (saved.endsAt <= now + 60e3 && !held) {
      this.forgetRun()
      return { resumed: false, reason: 'The saved session has ended.' }
    }
    if (this.safeMode && !held) return { resumed: false, reason: 'Safe mode: nothing is held, so nothing runs.' }
    try {
      await this.startRun(
        { dedicated: true, minutes: saved.minutes, markets: saved.mode === 'auto' ? 'auto' : saved.ids, network: saved.network },
        { endsAt: Math.max(saved.endsAt, now + 60e3), receiptLabel: 'Resumed after restart' }
      )
    } catch (e) {
      return this.review('The saved run could not be resumed: ' + e.message, view)
    }
    return { resumed: true }
  }
  review(reason, view) {
    this.needsReview = reason + ' Nothing is bid or sold until you review it.'
    const positions = {}
    for (const b of view?.balances ?? []) if (/^\+\d+$/.test(b.coin) && Number(b.total) > 0) positions[b.coin.slice(1)] = b
    this.holds = this.holdsForAll(reason, positions)
    this.notice = this.needsReview
    return { resumed: false, reason: this.needsReview }
  }
}

/** Signals the runner treats as a shutdown: cancel orders, then exit. SIGHUP is a closed console on Windows. */
export const shutdownSignals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']
