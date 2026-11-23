// Exits that no state can stop. A fake venue (nothing leaves the process) with a fake websocket book feed, driven in
// simulated time: a kill, every bid block and a long run of rate limits must leave the forced pre-game sells running.
import assert from 'node:assert/strict'
import test from 'node:test'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { ExchangeClient } from '@nktkas/hyperliquid'
import { TestnetRunner } from './testnet-engine.mjs'
import { RunJournal } from './run-journal.mjs'
import { nameFor, fee, builder, RateLimitError, orderPrefix } from '../../lib/mm/testnet.mjs'
import { loadPolicy } from './policy/index.mjs'
import { validatePreferences } from './preferences.mjs'
import { utcDay } from './inventory.mjs'

const policy = loadPolicy()
const account = () => privateKeyToAccount(generatePrivateKey())
const owner = account().address.toLowerCase()
const target = account().address.toLowerCase()
const id = 701
const yesCoin = '#7010'
const noCoin = '#7011'
const minute = 60e3
const ack = { version: 'risk-1', at: '2026-11-21T00:00:00.000Z' }

async function harness({ prefs = {}, startIn = 4 * 3600e3 } = {}) {
  const clock = { offset: 0, now: () => Date.now() + clock.offset }
  const start = clock.now() + startIn
  const catalog = [
    {
      id,
      start,
      label: 'A vs B',
      questionName: 'template:sportsContestResult',
      description: 'participantA:A|participantB:B',
    },
  ]
  const model = {
    cap: 0,
    slots: [],
    orders: [],
    history: new Map(),
    balances: [{ coin: 'USDC', total: '5000', hold: '0' }],
    actions: [],
    cancelBatches: [],
    deadlines: [],
    placed: [],
    tops: { [yesCoin]: ['0.499', '0.501'], [noCoin]: ['0.499', '0.501'] },
    empty: {},
    nextOid: 1,
    limited: { markets: false, rest: false, account: false },
  }
  const book = (coin) => {
    const [bid, ask] = model.tops[coin]
    const side = (px, which) => (model.empty[coin] === which ? [] : [{ px, sz: '5000', n: 1 }])
    return { coin, time: clock.now(), levels: [side(bid, 'bid'), side(ask, 'ask')] }
  }
  const balance = (coin, delta) => {
    let row = model.balances.find((b) => b.coin === coin)
    if (!row) model.balances.push((row = { coin, total: '0', hold: '0' }))
    row.total = String(Math.round((Number(row.total) + delta) * 1e6) / 1e6)
    if (coin !== 'USDC' && Number(row.total) === 0) model.balances = model.balances.filter((b) => b !== row)
  }
  const record = (o, status) => {
    const entry = { status, order: { ...o } }
    model.history.set(o.oid, entry)
    model.history.set(o.cloid, entry)
  }
  const fill = (cloid) => {
    const o = model.orders.find((x) => x.cloid === cloid)
    assert.ok(o, 'order to fill is resting')
    const take = Number(o.sz)
    o.sz = '0'
    const legCoin = '+' + o.coin.slice(1)
    if (o.side === 'B') {
      balance(legCoin, take)
      balance('USDC', -take * Number(o.limitPx))
    } else {
      balance(legCoin, -take)
      balance('USDC', take * Number(o.limitPx))
    }
    model.orders = model.orders.filter((x) => x !== o)
    record(o, 'filled')
  }
  const limited = (kind) => {
    if (model.limited[kind]) throw new RateLimitError('Hyperliquid testnet is rate limiting requests (429).')
  }
  const read = {
    targets: async () => [owner, target],
    markets: async () => {
      limited('markets')
      return catalog.filter((m) => m.start > clock.now() + 90000)
    },
    accountView: async () => {
      limited('account')
      return structuredClone({ orders: model.orders, balances: model.balances })
    },
    permissions: async (o, a) => ({
      cap: model.cap,
      builderReady: true,
      until: undefined,
      approved: model.slots.some((s) => s.address.toLowerCase() === a.toLowerCase()),
      occupied: false,
    }),
    readBooks: async (ids) => {
      limited('rest')
      return new Map(ids.map((m) => [m, [book('#' + m * 10), book('#' + (m * 10 + 1))]]))
    },
    info: async (type, p) => {
      if (type === 'l2Book') {
        limited('rest')
        return book(p.coin)
      }
      if (type === 'orderStatus') {
        const h = model.history.get(p.oid)
        return h ? { status: 'order', order: structuredClone(h) } : { status: 'unknownOid' }
      }
      throw Error('unexpected read ' + type)
    },
  }
  // The fake websocket: opens at once, acknowledges every subscribe, and sends a snapshot of each subscribed coin
  // whenever the test pushes (a quiet socket would send pongs; a push stands for any frame).
  const socket = { handlers: null, coins: new Set() }
  const socketFactory = (handlers) => {
    socket.handlers = handlers
    queueMicrotask(() => handlers.onOpen())
    return {
      subscribe: async (coin) => {
        socket.coins.add(coin)
        queueMicrotask(() => handlers.onBook(book(coin)))
      },
      unsubscribe: async (coin) => socket.coins.delete(coin),
      close: () => {},
    }
  }
  const push = () => {
    for (const coin of socket.coins) socket.handlers.onBook(book(coin))
  }
  let secret = null
  const entry = { getPassword: async () => secret, setPassword: async (v) => (secret = v) }
  const clientFor = (wallet) =>
    new ExchangeClient({
      wallet,
      signatureChainId: '0xa4b1',
      transport: {
        isTestnet: true,
        request: async (endpoint, payload) => {
          assert.equal(endpoint, 'exchange')
          const a = payload.action
          model.actions.push(a.type)
          assert.equal(payload.vaultAddress, target)
          if (a.type === 'order') {
            assert.equal(a.builder.b, builder)
            assert.equal(a.builder.f, fee)
            const statuses = a.orders.map((o) => {
              const coin = '#' + (o.a - 100000000)
              const row = { coin, cloid: o.c, limitPx: o.p, sz: o.s, origSz: o.s, oid: model.nextOid++, side: o.b ? 'B' : 'A' }
              model.placed.push({ ...row, tif: o.t.limit.tif, at: clock.now() })
              if (!o.b) {
                const have = Number(model.balances.find((b) => b.coin === '+' + coin.slice(1))?.total ?? 0)
                assert.ok(Number(o.s) <= have, 'never offers more shares than the account holds')
              }
              assert.ok(clock.now() < start - 60e3, 'nothing is sent at or after start minus 60 s')
              if (o.t.limit.tif === 'Ioc') {
                record(row, 'canceled')
                return { filled: { oid: row.oid, totalSz: '0', avgPx: o.p } }
              }
              model.orders.push(row)
              record(row, 'open')
              return { resting: { oid: row.oid } }
            })
            return { status: 'ok', response: { type: 'order', data: { statuses } } }
          }
          if (a.type === 'cancel') {
            model.cancelBatches.push(a.cancels.length)
            for (const c of a.cancels) {
              const row = model.orders.find((o) => o.oid === c.o)
              if (row) {
                model.orders = model.orders.filter((o) => o !== row)
                record(row, 'canceled')
              }
            }
          }
          if (a.type === 'scheduleCancel' && a.time) model.deadlines.push(a.time)
          return { status: 'ok', response: { type: 'default' } }
        },
      },
    })
  let stored = validatePreferences({ acknowledged: ack, budgetUsd: 2000, ...prefs }, { policy, strict: true }).prefs
  const preferences = {
    load: () => validatePreferences(stored, { policy }),
    save: (p) => {
      const result = validatePreferences(p, { policy, strict: true })
      stored = result.prefs
      return result
    },
  }
  const runner = new TestnetRunner({
    owner,
    target,
    entry,
    read,
    clientFor,
    policy,
    preferences,
    now: clock.now,
    journal: new RunJournal(),
    socketFactory,
  })
  await runner.load()
  model.slots.push({ address: runner.wallet.address, name: nameFor(runner.wallet.address) })
  model.cap = fee
  const bids = () => model.orders.filter((o) => o.side === 'B')
  const asks = () => model.orders.filter((o) => o.side === 'A')
  const iocs = () => model.placed.filter((o) => o.tif === 'Ioc')
  const at = (msBeforeStart) => {
    clock.offset = start - msBeforeStart - Date.now()
  }
  const tick = async () => {
    push()
    await runner.tick()
  }
  return { runner, model, clock, start, fill, bids, asks, iocs, at, tick, push, read }
}

// A fill on the YES leg with its exit resting, then book samples inside the reference window before the force stage.
async function heldWithSamples(h) {
  await h.runner.start({ dedicated: true, minutes: 480, markets: [id] })
  await h.tick() // the socket is live after its first acknowledgement
  h.fill(h.bids().find((o) => o.coin === yesCoin).cloid)
  await h.tick()
  assert.equal(h.asks().length, 1, 'the exit ask rests')
  for (const m of [35, 25, 15, 8]) {
    h.at(m * minute)
    await h.tick()
  }
  assert.ok((h.runner.run.samples['7010'] ?? []).length >= 3, 'samples recorded for the held leg')
}

test('1. after a fill and a kill no bid rests, the exit stays, and the force and sweep IOCs still go, at or above the floor', async () => {
  const h = await harness()
  await h.runner.start({ dedicated: true, minutes: 480, markets: [id] })
  await h.tick()
  h.fill(h.bids().find((o) => o.coin === yesCoin).cloid)
  await h.tick()
  assert.equal(h.asks().length, 1)
  await h.runner.kill()
  assert.equal(h.bids().length, 0, 'no bid rests after the kill')
  assert.equal(h.asks().length, 1, 'the exit ask still rests')
  assert.match(h.runner.notice, /Bids stopped\. Selling continues\./)
  const bidsPlaced = () => h.model.placed.filter((o) => o.side === 'B').length
  const before = bidsPlaced()
  for (let i = 0; i < 10; i++) {
    h.clock.offset += 8000
    await h.tick()
    assert.equal(h.bids().length, 0)
  }
  assert.equal(bidsPlaced(), before, 'no bid for 10 ticks')
  assert.equal((await h.runner.status()).killed, true)
  for (const m of [35, 25, 15, 8]) {
    h.at(m * minute)
    await h.tick()
  }
  h.at(6 * minute - 1000)
  await h.tick()
  const force = h.iocs()
  assert.equal(force.length, 1, 'one force IOC')
  assert.equal(h.asks().length, 0, 'the resting exit was withdrawn before it')
  // Reference: the median mid 0.5 of the samples, so the floor is 0.25.
  assert.ok(Number(force[0].limitPx) >= 0.25)
  assert.ok(h.runner.feed.health().live >= 2, 'books come from the socket')
  assert.equal(Number(force[0].limitPx), 0.499, 'the force limit is the best bid, above the floor')
  h.at(2 * minute - 1000)
  await h.tick()
  const sweep = h.iocs().slice(1)
  assert.equal(sweep.length, 1, 'one sweep IOC')
  assert.equal(Number(sweep[0].limitPx), 0.25, 'the sweep limit is the floor: half the reference price')
  const sent = h.model.actions.length
  h.at(60e3)
  await h.tick()
  h.at(30e3)
  await h.tick()
  assert.equal(h.model.actions.filter((a) => a === 'order').length, h.model.actions.slice(0, sent).filter((a) => a === 'order').length)
  assert.ok(h.model.placed.every((o) => o.at < h.start - 60e3))
})

test('2. with the bid side empty at the force time nothing is sold and status names the leg with "Sell by hand"', async () => {
  const h = await harness()
  await heldWithSamples(h)
  await h.runner.kill()
  // No YES bids and no NO asks: nothing to sell into, directly or through the other leg.
  h.model.empty = { [yesCoin]: 'bid', [noCoin]: 'ask' }
  h.at(6 * minute - 1000)
  await h.tick()
  assert.equal(h.iocs().length, 0, 'no sale into an empty book')
  const status = await h.runner.status()
  const hold = status.holds.find((x) => x.coin === '+7010')
  assert.ok(hold, 'the held leg is named')
  assert.match(hold.message, /Sell by hand/)
  assert.equal(hold.start, h.start)
  assert.equal(hold.marketId, id)
})

const easternMinute = (ms) => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms))
  return Number(parts.find((p) => p.type === 'hour').value) * 60 + Number(parts.find((p) => p.type === 'minute').value)
}
const hhmm = (m) => String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0')

const blocks = {
  'loss-day': (h, now) => {
    h.runner.ledger = { ...h.runner.ledger, day: utcDay(now), realizedUsd: -500 }
  },
  'loss-hour': (h, now) => {
    h.runner.run.history.push({ at: now - 10 * minute, totalUsd: 500 })
  },
  actions: (h, now) => {
    const snap = h.runner.actions.snapshot(now)
    h.runner.actions.spend('order', snap.entriesLeft, now, { priority: 'bid' })
  },
  'session-end': (h, now) => {
    h.runner.run.endsAt = now
  },
  hours: (h, now) => {
    const m = easternMinute(now)
    h.runner.run.settings = { ...h.runner.run.settings, hours: { from: hhmm((m + 120) % 1440), to: hhmm((m + 121) % 1440) } }
  },
  rollover: (h, now) => {
    h.runner.run.rollover = new Map([[id, { state: 'hold', row: null, since: now }]])
  },
  backoff: (h) => {
    // Persistent 429 on the REST reads (the catalog and REST books); the account and the socket still answer.
    h.model.limited.markets = true
    h.model.limited.rest = true
  },
}

for (const [code, apply] of Object.entries(blocks)) {
  test('3. the force IOC is still sent under the ' + code + ' bid block', async () => {
    const h = await harness()
    await heldWithSamples(h)
    h.at(6 * minute - 1000)
    apply(h, h.clock.now())
    await h.tick()
    if (code === 'backoff') {
      assert.equal(h.iocs().length, 0, 'the first step hit the rate limit')
      assert.equal(h.runner.run.bidBlock.code, 'backoff')
      h.clock.offset += 3000
      await h.tick() // inside the backoff: the exit pass reads the account once and uses the socket books
      assert.ok(h.runner.run.backoffUntil > h.clock.now(), 'still inside the backoff')
    }
    assert.ok(h.runner.run, 'the run goes on')
    if (code !== 'rollover') assert.equal(h.runner.run.bidBlock?.code, code)
    assert.equal(h.iocs().length, 1, 'the force IOC was sent')
    assert.ok(Number(h.iocs()[0].limitPx) >= 0.25)
    assert.equal(h.bids().length, 0)
  })
}

test('4. a 429 on 15 ticks in a row never stops the run, and quoting resumes after it clears', async () => {
  const h = await harness()
  await h.runner.start({ dedicated: true, minutes: 480, markets: [id] })
  await h.tick()
  assert.equal(h.bids().length, 2)
  h.model.limited.account = true
  for (let i = 0; i < 15; i++) {
    h.clock.offset += 61000
    await h.tick()
    assert.ok(h.runner.run, 'still running after ' + (i + 1))
    assert.equal(h.runner.run.failures, 0, 'a rate limit is never counted as a failure')
    assert.equal(h.runner.run.errorBlock, null)
  }
  assert.equal(h.runner.run.bidBlock.code, 'backoff')
  assert.equal(h.bids().length, 0, 'bids are pulled while limited')
  h.model.limited.account = false
  for (let i = 0; i < 5 && h.bids().length < 2; i++) {
    h.clock.offset += 61000
    await h.tick()
  }
  assert.equal(h.bids().length, 2, 'quoting resumes')
  assert.equal(h.runner.run.bidBlock, null)
})

test('5. cancels of 250 orders go out as batches of 200 and 50', async () => {
  const h = await harness()
  const prefix = orderPrefix(h.runner.wallet.address)
  for (let i = 0; i < 250; i++) {
    const row = {
      coin: i % 2 ? noCoin : yesCoin,
      cloid: prefix + i.toString(16).padStart(12, '0'),
      limitPx: '0.4',
      sz: '30',
      origSz: '30',
      oid: h.model.nextOid++,
      side: 'B',
    }
    h.model.orders.push(row)
  }
  await h.runner.stopAll()
  assert.deepEqual(h.model.cancelBatches, [200, 50])
  assert.equal(h.model.orders.length, 0)
})
