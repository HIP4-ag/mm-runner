// Order books for the runner: a websocket `l2Book` subscription per coin (fast: full-book snapshots, no deltas) as the
// primary source, and REST l2Book reads only for coins that are not live on the socket. The reason is the shared IP:
// polling every book over REST is what runs a machine into 429s.
//
// A coin is live on the socket only while all of these hold, so a quiet market is never mistaken for a dead one and a
// dead socket is never mistaken for a quiet market:
//   1. the socket is connected,
//   2. some frame (a book or a pong) arrived within `livenessMs`,
//   3. the coin was acknowledged after the last (re)connect,
//   4. a book snapshot for it arrived after that.
// The SDK is told not to resubscribe by itself (resubscribe: false). This class resubscribes from its own list on every
// open, minus retired coins, so a coin that has settled is never asked for again.
//
// The socket is injected: socketFactory(handlers) returns { subscribe(coin) -> Promise (resolves at the server's ack),
// unsubscribe(coin), close() } and calls handlers.onOpen(), onClose(), onFrame(kind), onBook(event). Tests pass a fake.
import { networkOf } from '../../lib/mm/network.mjs'
import { RateLimitError } from '../../lib/mm/testnet.mjs'

const defaultLivenessMs = 30e3
const defaultSpotCheckMs = 60e3
const restMaxAgeMs = 20e3
const restConcurrency = 4

/** The outcome id a leg coin like '#123450' belongs to (leg coins are #<id * 10 + side>). */
export const outcomeOfCoin = (coin) => {
  const n = /^#(\d+)$/.exec(String(coin))?.[1]
  return n === undefined ? null : Math.floor(Number(n) / 10)
}
/** Both leg coins of an outcome. */
export const coinsOfOutcome = (id) => ['#' + id * 10, '#' + (id * 10 + 1)]

/**
 * Subscribed outcome ids that the listing no longer shows: candidates for a settlement check. Sorted, no duplicates.
 * A candidate is only a candidate: retire it after venue.settledOutcome shows a settled record.
 */
export function settledCandidates(subscribedIds, listedIds) {
  const listed = new Set(listedIds)
  return [...new Set(subscribedIds)].filter((id) => !listed.has(id)).sort((a, b) => a - b)
}

/** True for a settledOutcome answer that proves settlement: a record carrying a settleFraction (null while unsettled). */
export const isSettledProof = (response) =>
  response !== null && typeof response === 'object' && typeof response.settleFraction === 'string'

const levelsOk = (book) =>
  Array.isArray(book?.levels) && Array.isArray(book.levels[0]) && Array.isArray(book.levels[1]) && Number.isFinite(book.time)
const topOf = (book) => [Number(book?.levels?.[0]?.[0]?.px), Number(book?.levels?.[1]?.[0]?.px)]

export class BookFeed {
  #now
  #wanted = new Set() // coins the caller asked for, whether or not retired
  #entries = new Map()
  #retired = new Map() // outcome id -> { reason, at }
  #listed = null
  #socket
  #restBook
  #livenessMs
  #spotMs
  #log
  #lastStall = null
  #closed = false
  epoch = 0
  connected = false
  lastFrameAt = 0
  reconnects = 0
  spotMismatches = 0

  /**
   * network: 'testnet' | 'mainnet' (only used by the default socket). socketFactory: see the top of the file; the
   * default opens a real SDK socket. restBook(coin) returns an l2Book answer. now: () => ms. policy: reads
   * policy.feeds.livenessMs (at most 30 s) and policy.feeds.restSpotCheckMs. log(event) is called for retire, restore,
   * reconnect and suspect events.
   */
  constructor({ network = 'testnet', socketFactory, restBook, now = Date.now, policy, log } = {}) {
    this.network = networkOf(network)
    if (typeof restBook !== 'function') throw Error('A REST book reader is required.')
    this.#restBook = restBook
    this.#now = now
    this.#log = typeof log === 'function' ? log : () => {}
    const liveness = Number(policy?.feeds?.livenessMs)
    this.#livenessMs = Number.isFinite(liveness) && liveness > 0 ? Math.min(liveness, defaultLivenessMs) : defaultLivenessMs
    const spot = Number(policy?.feeds?.restSpotCheckMs)
    this.#spotMs = Number.isFinite(spot) && spot > 0 ? spot : defaultSpotCheckMs
    const factory = socketFactory ?? sdkSocketFactory(this.network)
    this.#socket = factory({
      onOpen: () => this.#open(),
      onClose: () => this.#close(),
      onFrame: () => this.#frame(),
      onBook: (event) => this.#book(event),
    })
  }

  #entry(coin) {
    let entry = this.#entries.get(coin)
    if (!entry) {
      entry = { book: null, receivedAt: 0, ackEpoch: -1, snapshotEpoch: -1, pendingEpoch: -1, rest: null, lastSpotAt: 0 }
      this.#entries.set(coin, entry)
    }
    return entry
  }
  #retiredCoin = (coin) => this.#retired.has(outcomeOfCoin(coin))
  #active() {
    return [...this.#wanted].filter((coin) => !this.#retiredCoin(coin))
  }

  #open() {
    if (this.#closed) return
    if (this.epoch > 0) this.reconnects++
    this.epoch++
    this.connected = true
    this.lastFrameAt = this.#now()
    if (this.epoch > 1) this.#log({ event: 'reconnect', reconnects: this.reconnects })
    for (const coin of this.#active()) this.#subscribe(coin)
  }
  #close() {
    if (!this.connected) return
    this.connected = false
    // The coin the connection stopped at: wanted, not retired and never acknowledged on this connection. Two stops at
    // the same one in a row, with the outcome gone from the listing, mean the server rejects it: retire it.
    const stalled = this.#active().find((coin) => this.#entry(coin).ackEpoch !== this.epoch)
    if (stalled === undefined) this.#lastStall = null
    else this.#stall(stalled)
  }
  #frame() {
    this.lastFrameAt = this.#now()
  }
  #book(event) {
    this.lastFrameAt = this.#now()
    const coin = event?.coin
    if (!this.#wanted.has(coin) || this.#retiredCoin(coin) || !levelsOk(event)) return
    const entry = this.#entry(coin)
    entry.book = event
    entry.receivedAt = this.#now()
    entry.snapshotEpoch = this.epoch
  }

  #subscribe(coin) {
    if (this.#closed || !this.connected || this.#retiredCoin(coin)) return
    const entry = this.#entry(coin)
    const epoch = this.epoch
    if (entry.ackEpoch === epoch || entry.pendingEpoch === epoch) return
    entry.pendingEpoch = epoch
    Promise.resolve()
      .then(() => this.#socket.subscribe(coin))
      .then(() => {
        if (epoch === this.epoch && this.#wanted.has(coin) && !this.#retiredCoin(coin)) entry.ackEpoch = epoch
      })
      .catch(() => {
        if (epoch === this.epoch) this.noteAttemptFailure(coin)
      })
      .finally(() => {
        if (entry.pendingEpoch === epoch) entry.pendingEpoch = -1
      })
  }
  #unsubscribe(coin) {
    const entry = this.#entries.get(coin)
    if (entry) Object.assign(entry, { ackEpoch: -1, snapshotEpoch: -1, pendingEpoch: -1, book: null })
    if (this.connected) Promise.resolve().then(() => this.#socket.unsubscribe(coin)).catch(() => {})
  }
  #stall(coin) {
    const last = this.#lastStall
    if (last?.coin === coin && last.epoch === this.epoch) return // once per connection
    this.#lastStall = { coin, epoch: this.epoch, count: last?.coin === coin ? last.count + 1 : 1 }
    const id = outcomeOfCoin(coin)
    if (this.#lastStall.count >= 2 && this.#listed !== null && id !== null && !this.#listed.has(id)) {
      this.#log({ event: 'suspect', outcome: id, coin })
      this.retire(id, 'suspect')
    }
  }

  /** A subscribe for this coin failed or never answered on this connection. Feeds the suspect rule. */
  noteAttemptFailure(coin) {
    this.#stall(coin)
  }

  /** The coins to keep subscribed (leg coins like '#123450'). Retired coins in the list are kept aside, not subscribed. */
  setCoins(coins) {
    const next = new Set(coins)
    for (const coin of this.#wanted) if (!next.has(coin)) this.#unsubscribe(coin)
    this.#wanted = next
    for (const coin of this.#active()) this.#subscribe(coin)
  }

  /**
   * Stop asking for an outcome's books for good (until the listing shows it again): it has settled, or the server
   * keeps rejecting it. Both leg coins are unsubscribed and their books dropped.
   */
  retire(outcomeId, reason = 'settled') {
    if (this.#retired.has(outcomeId)) return
    this.#retired.set(outcomeId, { reason, at: this.#now() })
    for (const coin of coinsOfOutcome(outcomeId)) {
      this.#unsubscribe(coin)
      this.#entries.delete(coin)
    }
    this.#log({ event: 'retire', outcome: outcomeId, reason })
  }

  /** The outcome ids the exchange currently lists. A retired outcome that shows up again is restored. */
  setListing(listedIds) {
    this.#listed = new Set(listedIds)
    for (const id of [...this.#retired.keys()]) {
      if (!this.#listed.has(id)) continue
      this.#retired.delete(id)
      this.#log({ event: 'restore', outcome: id })
    }
    for (const coin of this.#active()) this.#subscribe(coin)
  }

  /** Records the listing and returns the subscribed outcome ids it no longer shows (see settledCandidates). */
  settledCandidates(listedIds) {
    this.setListing(listedIds)
    const ids = this.#active().map(outcomeOfCoin).filter((id) => id !== null)
    return settledCandidates(ids, this.#listed)
  }

  #live(coin, now) {
    const entry = this.#entries.get(coin)
    return !!(
      entry?.book &&
      this.connected &&
      !this.#closed &&
      !this.#retiredCoin(coin) &&
      now - this.lastFrameAt <= this.#livenessMs &&
      entry.ackEpoch === this.epoch &&
      entry.snapshotEpoch === this.epoch
    )
  }

  /**
   * Makes sure every coin has a usable book: coins that are live on the socket are left alone, the rest get a REST read.
   * resting: coins that have orders resting; a live one of those is checked against REST at most once per
   * restSpotCheckMs, and one whose top of book disagrees although the socket has been silent since is dropped back to
   * REST and resubscribed. Returns { live, rest, failed: [coin] }. A 429 is rethrown (as RateLimitError) after the
   * other reads finish.
   */
  async ensure(coins, now = this.#now(), { resting = [] } = {}) {
    const restingSet = new Set(resting)
    const reads = []
    for (const coin of coins) {
      if (this.#retiredCoin(coin)) continue
      const entry = this.#entry(coin)
      if (!this.#live(coin, now)) reads.push({ coin, spot: false })
      else if (restingSet.has(coin) && now - entry.lastSpotAt >= this.#spotMs) reads.push({ coin, spot: true })
    }
    const failed = []
    let limited = null
    let next = 0
    const worker = async () => {
      while (next < reads.length) {
        const { coin, spot } = reads[next++]
        const entry = this.#entry(coin)
        const startedAt = this.#now()
        try {
          const book = await this.#restBook(coin)
          if (!levelsOk(book)) throw Error('Unusable book answer.')
          entry.rest = { book, receivedAt: this.#now() }
          if (spot) {
            entry.lastSpotAt = now
            const [wsBid, wsAsk] = topOf(entry.book)
            const [restBid, restAsk] = topOf(book)
            // Differs, and the socket has said nothing since before this read began: it missed an update.
            if ((wsBid !== restBid || wsAsk !== restAsk) && entry.receivedAt < startedAt - 2000) {
              this.spotMismatches++
              this.#log({ event: 'spot-mismatch', coin })
              this.#unsubscribe(coin)
              this.#subscribe(coin)
            }
          }
        } catch (e) {
          if (e instanceof RateLimitError) limited ??= e
          else failed.push(coin)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(restConcurrency, reads.length) }, worker))
    if (limited) throw limited
    const cold = reads.filter((r) => !r.spot).length
    return { live: coins.filter((c) => !this.#retiredCoin(c)).length - cold, rest: reads.length, failed }
  }

  /**
   * The best book for a coin: { book, source: 'ws' | 'rest', receivedAt }, or null when there is none. A REST book older
   * than 20 s is not returned. A websocket book can be as old as the market is quiet, so the caller judges freshness of
   * a 'ws' book by `source`, not by its age.
   */
  book(coin, now = this.#now()) {
    const entry = this.#entries.get(coin)
    if (!entry || this.#retiredCoin(coin)) return null
    if (this.#live(coin, now)) return { book: entry.book, source: 'ws', receivedAt: entry.receivedAt }
    if (entry.rest && now - entry.rest.receivedAt <= restMaxAgeMs)
      return { book: entry.rest.book, source: 'rest', receivedAt: entry.rest.receivedAt }
    return null
  }

  health(now = this.#now()) {
    const active = this.#active()
    const live = active.filter((coin) => this.#live(coin, now)).length
    return {
      connected: this.connected,
      lastFrameAt: this.lastFrameAt,
      reconnects: this.reconnects,
      subscribed: active.length,
      live,
      fallback: active.length - live,
      spotMismatches: this.spotMismatches,
      retired: [...this.#retired].map(([id, r]) => ({ id, reason: r.reason, at: r.at })),
    }
  }

  close() {
    this.#closed = true
    this.connected = false
    try {
      this.#socket.close()
    } catch {}
  }
}

/**
 * The real socket, built on the SDK's WebSocketTransport. The SDK's own resubscribe is off (BookFeed does it) and the
 * keep-alive pings every 10 s, so a pong is a frame well inside the 30 s liveness window even on a silent book.
 * Not used by any test: the SDK imports load lazily so a test never opens a socket.
 */
export function sdkSocketFactory(network) {
  const net = networkOf(network)
  return (handlers) => {
    let transport = null
    let client = null
    const subs = new Map()
    const ready = (async () => {
      const { WebSocketTransport, SubscriptionClient } = await import('@nktkas/hyperliquid')
      transport = new WebSocketTransport({
        isTestnet: net.isTestnet,
        resubscribe: false,
        keepAlive: { interval: 10e3, timeout: 10e3 },
      })
      client = new SubscriptionClient({ transport })
      const socket = transport.socket
      socket.addEventListener('open', () => handlers.onOpen())
      socket.addEventListener('close', () => handlers.onClose())
      socket.addEventListener('error', () => handlers.onClose())
      socket.addEventListener('message', () => handlers.onFrame('data'))
      // The reconnecting socket may already be open by the time the listeners are attached.
      if (socket.readyState === 1) handlers.onOpen()
    })()
    return {
      async subscribe(coin) {
        await ready
        const subscription = await client.l2Book({ coin, fast: true }, (event) => handlers.onBook(event))
        subs.set(coin, subscription)
      },
      async unsubscribe(coin) {
        const subscription = subs.get(coin)
        subs.delete(coin)
        await subscription?.unsubscribe()
      },
      close() {
        ready.then(() => transport?.close()).catch(() => {})
      },
    }
  }
}
