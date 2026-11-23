import test from 'node:test'
import assert from 'node:assert/strict'
import { BookFeed, coinsOfOutcome, isSettledProof, outcomeOfCoin, settledCandidates } from './book-feed.mjs'
import { RateLimitError } from '../../lib/mm/testnet.mjs'

const t0 = Date.UTC(2026, 10, 21, 12)
const flush = () => new Promise((resolve) => setImmediate(resolve))
const policy = { feeds: { livenessMs: 30e3, restSpotCheckMs: 60e3 } }
const book = (coin, time, bid = '0.48', ask = '0.52') => ({
  coin,
  time,
  levels: [[{ px: bid, sz: '100', n: 1 }], [{ px: ask, sz: '100', n: 1 }]],
})

// A fake socket: tests drive open, close, frames and books by hand. Nothing here opens a real connection.
function rig({ hang = [], reject = [] } = {}) {
  const clock = { now: t0 }
  const socket = { handlers: null, subs: [], unsubs: [], closed: false, hang: new Set(hang), reject: new Set(reject) }
  const factory = (handlers) => {
    socket.handlers = handlers
    return {
      subscribe: (coin) => {
        socket.subs.push(coin)
        if (socket.hang.has(coin)) return new Promise(() => {})
        if (socket.reject.has(coin)) return Promise.reject(Error('rejected'))
        return Promise.resolve()
      },
      unsubscribe: async (coin) => {
        socket.unsubs.push(coin)
      },
      close: () => {
        socket.closed = true
      },
    }
  }
  const rest = { calls: [], books: new Map(), error: null }
  const feed = new BookFeed({
    network: 'testnet',
    socketFactory: factory,
    restBook: async (coin) => {
      rest.calls.push(coin)
      if (rest.error) throw rest.error
      return rest.books.get(coin) ?? book(coin, clock.now)
    },
    now: () => clock.now,
    policy,
    log: (event) => (rig.logs ??= []).push(event),
  })
  return { feed, socket, rest, clock }
}

async function live(r, coins) {
  r.socket.handlers.onOpen()
  r.feed.setCoins(coins)
  await flush()
  for (const coin of coins) r.socket.handlers.onBook(book(coin, r.clock.now))
}

test('coin and outcome helpers', () => {
  assert.equal(outcomeOfCoin('#123450'), 12345)
  assert.equal(outcomeOfCoin('#123451'), 12345)
  assert.equal(outcomeOfCoin('@5'), null)
  assert.deepEqual(coinsOfOutcome(7), ['#70', '#71'])
  assert.deepEqual(settledCandidates([1, 2, 3, 3], [2]), [1, 3])
  assert.equal(isSettledProof(null), false)
  assert.equal(isSettledProof({ spec: {}, settleFraction: '1.0', details: '' }), true)
  assert.equal(isSettledProof({ spec: {} }), false)
})

test('a calm book stays live with no data frames while pongs arrive, and REST is not read', async () => {
  const r = rig()
  await live(r, ['#10', '#11'])
  assert.equal(r.feed.book('#10').source, 'ws')
  // Ten minutes pass with no book updates, only a pong every 10 s.
  for (let i = 0; i < 60; i++) {
    r.clock.now += 10e3
    r.socket.handlers.onFrame('pong')
  }
  assert.equal(r.feed.book('#10').source, 'ws')
  const result = await r.feed.ensure(['#10', '#11'], r.clock.now)
  assert.deepEqual(r.rest.calls, [])
  assert.equal(result.rest, 0)
  assert.equal(r.feed.health().fallback, 0)
})

test('frames stopping means not live, and ensure falls back to REST', async () => {
  const r = rig()
  await live(r, ['#10'])
  r.clock.now += 31e3
  assert.equal(r.feed.book('#10'), null)
  assert.equal(r.feed.health().live, 0)
  const result = await r.feed.ensure(['#10'], r.clock.now)
  assert.deepEqual(r.rest.calls, ['#10'])
  assert.equal(result.rest, 1)
  const served = r.feed.book('#10')
  assert.equal(served.source, 'rest')
  assert.equal(served.book.coin, '#10')
  // A frame brings the socket back, but a book is served from the socket again only because it is still acknowledged.
  r.socket.handlers.onFrame('pong')
  assert.equal(r.feed.book('#10').source, 'ws')
  // A disconnect is never live; the REST book is used while it is fresh, and not after 20 s.
  r.socket.handlers.onClose()
  assert.equal(r.feed.book('#10').source, 'rest')
  r.clock.now += 21e3
  assert.equal(r.feed.book('#10'), null)
})

test('after a reconnect a coin is live only once acknowledged and a snapshot arrived', async () => {
  const r = rig()
  await live(r, ['#10'])
  r.socket.handlers.onClose()
  r.socket.handlers.onOpen()
  assert.equal(r.feed.health().reconnects, 1)
  // Connected and frames flowing, but the old book is from the last connection.
  assert.equal(r.feed.book('#10'), null)
  await flush()
  assert.equal(r.feed.book('#10'), null, 'acknowledged, no snapshot yet')
  r.socket.handlers.onBook(book('#10', r.clock.now))
  assert.equal(r.feed.book('#10').source, 'ws')
})

test('on reconnect the list is resubscribed minus retired coins, and a settled coin is never asked for again', async () => {
  const r = rig()
  await live(r, ['#10', '#11', '#20', '#21'])
  assert.deepEqual(r.socket.subs, ['#10', '#11', '#20', '#21'])
  r.feed.retire(2, 'settled')
  await flush()
  assert.deepEqual(r.socket.unsubs.sort(), ['#20', '#21'])
  assert.equal(r.feed.book('#20'), null)
  r.socket.subs.length = 0
  r.socket.handlers.onClose()
  r.socket.handlers.onOpen()
  await flush()
  assert.deepEqual(r.socket.subs, ['#10', '#11'])
  // Asking for the whole list again does not bring the retired coins back.
  r.feed.setCoins(['#10', '#11', '#20', '#21'])
  await flush()
  assert.deepEqual(r.socket.subs, ['#10', '#11'])
  assert.deepEqual(
    r.feed.health().retired.map(({ id, reason }) => [id, reason]),
    [[2, 'settled']]
  )
  // REST does not read it either.
  await r.feed.ensure(['#20', '#21'], r.clock.now)
  assert.deepEqual(r.rest.calls, [])
  // The listing showing it again brings it back.
  r.feed.setListing([1, 2])
  await flush()
  assert.deepEqual(r.socket.subs.slice(-2), ['#20', '#21'])
  assert.deepEqual(r.feed.health().retired, [])
})

test('settledCandidates lists subscribed outcomes the listing dropped', async () => {
  const r = rig()
  await live(r, ['#10', '#11', '#20', '#21', '#30', '#31'])
  assert.deepEqual(r.feed.settledCandidates([1, 3]), [2])
  r.feed.retire(2, 'settled')
  assert.deepEqual(r.feed.settledCandidates([1, 3]), [])
})

test('suspect rule: two reconnects stopping at the same unacknowledged coin of an unlisted outcome retire it', async () => {
  const r = rig({ hang: ['#50'] })
  r.feed.setListing([1])
  await live(r, ['#10', '#11', '#50', '#51'])
  assert.equal(r.feed.health().retired.length, 0)
  r.socket.handlers.onClose() // first stop at #50
  assert.equal(r.feed.health().retired.length, 0)
  r.socket.handlers.onOpen()
  await flush()
  r.socket.handlers.onClose() // second stop at the same coin
  assert.deepEqual(
    r.feed.health().retired.map(({ id, reason }) => [id, reason]),
    [[5, 'suspect']]
  )
  assert.equal(rig.logs.some((e) => e.event === 'suspect' && e.outcome === 5), true)
  r.socket.subs.length = 0
  r.socket.handlers.onOpen()
  await flush()
  assert.deepEqual(r.socket.subs, ['#10', '#11'])
})

test('suspect rule: a listed outcome, a different coin or a clean connection in between never retires', async () => {
  // Listed: the market is real, so a stall is not proof that it is gone.
  const listed = rig({ hang: ['#50'] })
  listed.feed.setListing([1, 5])
  await live(listed, ['#10', '#50'])
  for (let i = 0; i < 3; i++) {
    listed.socket.handlers.onClose()
    listed.socket.handlers.onOpen()
    await flush()
  }
  assert.equal(listed.feed.health().retired.length, 0)
  // A clean connection between the two stops resets the count.
  const clean = rig({ hang: ['#50'] })
  clean.feed.setListing([1])
  await live(clean, ['#10', '#50'])
  clean.socket.handlers.onClose()
  clean.socket.handlers.onOpen()
  clean.socket.hang.delete('#50')
  clean.feed.setCoins(['#10', '#50'])
  await flush()
  await flush()
  clean.socket.handlers.onClose()
  assert.equal(clean.feed.health().retired.length, 0)
  // With no listing known there is nothing to compare against.
  const blind = rig({ hang: ['#50'] })
  await live(blind, ['#50'])
  for (let i = 0; i < 3; i++) {
    blind.socket.handlers.onClose()
    blind.socket.handlers.onOpen()
    await flush()
  }
  assert.equal(blind.feed.health().retired.length, 0)
})

test('a rejected subscribe counts as an attempt failure for the suspect rule', async () => {
  const r = rig({ reject: ['#50'] })
  r.feed.setListing([1])
  await live(r, ['#10', '#50'])
  await flush()
  r.socket.handlers.onClose()
  r.socket.handlers.onOpen()
  await flush()
  await flush()
  assert.deepEqual(
    r.feed.health().retired.map(({ id, reason }) => [id, reason]),
    [[5, 'suspect']]
  )
})

test('a live coin with resting orders is checked against REST once a minute, and a missed update drops it to REST', async () => {
  const r = rig()
  await live(r, ['#10'])
  r.clock.now += 61e3
  r.socket.handlers.onFrame('pong')
  // REST agrees: one read, still live.
  r.rest.books.set('#10', book('#10', r.clock.now))
  await r.feed.ensure(['#10'], r.clock.now, { resting: ['#10'] })
  assert.deepEqual(r.rest.calls, ['#10'])
  assert.equal(r.feed.book('#10').source, 'ws')
  await r.feed.ensure(['#10'], r.clock.now + 1000, { resting: ['#10'] })
  assert.equal(r.rest.calls.length, 1, 'not again inside the minute')
  // REST disagrees and the socket has been silent: it missed an update.
  r.clock.now += 61e3
  r.socket.handlers.onFrame('pong')
  r.rest.books.set('#10', book('#10', r.clock.now, '0.40', '0.44'))
  r.socket.subs.length = 0
  await r.feed.ensure(['#10'], r.clock.now, { resting: ['#10'] })
  assert.equal(r.feed.health().spotMismatches, 1)
  assert.equal(r.feed.book('#10').source, 'rest')
  await flush()
  assert.deepEqual(r.socket.subs, ['#10'], 'resubscribed for a fresh snapshot')
  // Coins without resting orders are never spot checked.
  const idle = rig()
  await live(idle, ['#10'])
  idle.clock.now += 120e3
  idle.socket.handlers.onFrame('pong')
  await idle.feed.ensure(['#10'], idle.clock.now)
  assert.deepEqual(idle.rest.calls, [])
})

test('REST failures are reported per coin and a 429 is rethrown after the other reads', async () => {
  const r = rig()
  r.socket.handlers.onOpen()
  r.rest.error = Error('boom')
  const result = await r.feed.ensure(['#10', '#11'], r.clock.now)
  assert.deepEqual(result.failed.sort(), ['#10', '#11'])
  assert.equal(r.feed.book('#10'), null)
  r.rest.error = new RateLimitError('slow down', 5000)
  await assert.rejects(r.feed.ensure(['#10'], r.clock.now), (e) => e instanceof RateLimitError && e.retryAfterMs === 5000)
  assert.throws(() => new BookFeed({ socketFactory: () => ({}) }))
})

test('health reports the socket, the counts and close shuts the socket', async () => {
  const r = rig()
  assert.equal(r.feed.health().connected, false)
  await live(r, ['#10', '#11'])
  const h = r.feed.health()
  assert.deepEqual([h.connected, h.subscribed, h.live, h.fallback, h.reconnects], [true, 2, 2, 0, 0])
  assert.equal(h.lastFrameAt, t0)
  r.feed.close()
  assert.equal(r.socket.closed, true)
  assert.equal(r.feed.health().connected, false)
})
