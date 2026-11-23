import assert from 'node:assert/strict'
import test from 'node:test'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { ExchangeClient } from '@nktkas/hyperliquid'
import { TestnetRunner, tickDelayMs, isTransient, shutdownSignals } from './testnet-engine.mjs'
import { memoryActionStore } from './request-budget.mjs'
import { RunJournal } from './run-journal.mjs'
import { inspectRecovery, revokeDevice, cancelRecoveryOrder, authorizeRecovery } from '../../lib/mm/recovery.mjs'
import { nameFor, fee, builder, deviceApproval, quoteCutoff } from '../../lib/mm/testnet.mjs'
import { loadPolicy } from './policy/index.mjs'
import { validatePreferences } from './preferences.mjs'
import { breakevenPx, emptyLedger } from './inventory.mjs'

const policy = loadPolicy()
const ack = { version: 'risk-1', at: '2026-11-21T00:00:00.000Z' }
const account = () => privateKeyToAccount(generatePrivateKey())

test('device approval signs the chosen whole-day term from the owner click', () => {
  const address = account().address
  const clickedAt = Date.UTC(2026, 10, 18)
  for (const days of [1, 7, 23, 180]) {
    assert.deepEqual(deviceApproval(address, days, clickedAt), {
      agentAddress: address,
      agentName: nameFor(address) + ' valid_until ' + (clickedAt + days * 86400000),
    })
  }
  for (const days of [0, -1, 181, 7.5, NaN, Infinity]) {
    assert.throws(() => deviceApproval(address, days, clickedAt), /whole number/)
  }
})

test('the tick interval grows with the number of markets and keeps its jitter', () => {
  assert.equal(tickDelayMs(1, 0), 7000)
  assert.equal(tickDelayMs(12, 0), 7000)
  assert.equal(tickDelayMs(30, 0), 14200)
  for (const r of [0, 0.5, 0.999]) {
    const d = tickDelayMs(6, 0.3, () => r)
    assert.ok(d >= 4900 && d <= 9100)
  }
})

const ownerKey = account(),
  owner = ownerKey.address.toLowerCase(),
  target = account().address.toLowerCase()
const id = 701
const yesCoin = '#7010'
const noCoin = '#7011'

/**
 * A fake testnet: books, an order book of our own orders with fills on demand, balances, order status history and
 * the exchange endpoint behind real SDK signing. Nothing leaves the process.
 */
async function harness({
  feeWaived = [],
  expectFee = fee,
  prefs = { budgetUsd: 2000 },
  start,
  runnerPolicy = policy,
  journal,
  ids = [id],
  actionStore,
} = {}) {
  const clock = { offset: 0, now: () => Date.now() + clock.offset }
  const t0 = clock.now()
  const catalog = ids.map((m) => ({
    id: m,
    start: start ?? t0 + 5 * 3600e3,
    label: 'A vs B · ' + m,
    questionName: 'template:sportsContestResult',
    description: 'participantA:A|participantB:B',
  }))
  const market = catalog[0]
  const model = {
    cap: 0,
    slots: [],
    orders: [],
    history: new Map(),
    balances: [{ coin: 'USDC', total: '5000', hold: '0' }],
    actions: [],
    deadlines: [],
    placed: [],
    bookAge: 0,
    iocFill: false,
    tops: { [yesCoin]: ['0.499', '0.501'], [noCoin]: ['0.499', '0.501'] },
    until: undefined,
    nextOid: 1,
  }
  const book = (coin) => {
    const [bid, ask] = model.tops[coin] ?? ['0.499', '0.501']
    const sz = model.depth?.[coin] ?? '5000'
    return { coin, time: clock.now() - model.bookAge, levels: [[{ px: bid, sz }], [{ px: ask, sz }]] }
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
  // Fill `sz` shares of a resting order of ours at its limit price.
  const fill = (cloid, sz) => {
    const o = model.orders.find((x) => x.cloid === cloid)
    assert.ok(o, 'order to fill is resting')
    const take = sz ?? Number(o.sz)
    o.sz = String(Number(o.sz) - take)
    const legCoin = '+' + o.coin.slice(1)
    const value = take * Number(o.limitPx)
    if (o.side === 'B') {
      balance(legCoin, take)
      balance('USDC', -value)
    } else {
      balance(legCoin, -take)
      balance('USDC', value)
    }
    if (Number(o.sz) === 0) {
      model.orders = model.orders.filter((x) => x !== o)
      record(o, 'filled')
    } else record(o, 'open')
  }
  const read = {
    targets: async () => [owner, target],
    markets: async () => catalog.filter((m) => m.start > clock.now() + 90000),
    accountView: async () => structuredClone({ orders: model.orders, balances: model.balances }),
    permissions: async (o, a) => ({
      cap: model.cap,
      builderReady: true,
      until: model.until,
      approved: model.slots.some((s) => s.address.toLowerCase() === a.toLowerCase()),
      occupied: model.slots.some((s) => s.name === nameFor(a)),
    }),
    readBooks: async (ids) => new Map(ids.map((m) => [m, [book('#' + m * 10), book('#' + (m * 10 + 1))]])),
    info: async (type, p) => {
      if (type === 'extraAgents') return model.slots
      if (type === 'l2Book') return book(p.coin)
      if (type === 'orderStatus') {
        const h = model.history.get(p.oid)
        return h ? { status: 'order', order: structuredClone(h) } : { status: 'unknownOid' }
      }
      throw Error('unexpected read ' + type)
    },
  }
  let secret = null
  const entry = {
    getPassword: async () => secret,
    setPassword: async (val) => {
      secret = val
    },
  }
  const clientFor = (wallet) =>
    new ExchangeClient({
      wallet,
      signatureChainId: '0xa4b1',
      transport: {
        isTestnet: true,
        request: async (endpoint, payload) => {
          assert.equal(endpoint, 'exchange')
          assert.match(payload.signature.r, /^0x[0-9a-f]{64}$/)
          const a = payload.action
          const master = wallet.address.toLowerCase() === owner
          model.actions.push(a.type)
          if (a.type === 'approveAgent') {
            assert.ok(master)
            const name = a.agentName.split(' ')[0]
            model.slots = model.slots.filter((s) => s.name !== name)
            model.slots.push({ name, address: a.agentAddress, validUntil: Date.now() + 60000 })
            return { status: 'ok', response: { type: 'default' } }
          }
          if (a.type === 'approveBuilderFee') {
            assert.ok(master)
            model.cap = Number.parseFloat(a.maxFeeRate) * 1000
            return { status: 'ok', response: { type: 'default' } }
          }
          assert.equal(payload.vaultAddress, target)
          if (!master && !model.slots.some((s) => s.address.toLowerCase() === wallet.address.toLowerCase()))
            throw Error('Agent revoked')
          if (a.type === 'order') {
            // Every order carries the builder, with the fee this owner should pay.
            assert.equal(a.builder.b, builder)
            assert.equal(a.builder.f, expectFee)
            assert.ok(payload.expiresAfter > Date.now())
            // A batch that rests needs the disconnect timer to outlive it; a forced IOC never rests.
            if (a.orders.some((o) => o.t.limit.tif !== 'Ioc'))
              assert.ok(payload.expiresAfter < model.deadlines.at(-1), 'the disconnect timer outlives the request')
            const statuses = a.orders.map((o) => {
              if (!o.b && model.rejectSells) return { error: 'Post only order would have immediately matched' }
              const coin = '#' + (o.a - 100000000)
              const row = { coin, cloid: o.c, limitPx: o.p, sz: o.s, origSz: o.s, oid: model.nextOid++, side: o.b ? 'B' : 'A' }
              model.placed.push({ ...row, tif: o.t.limit.tif, at: clock.now() })
              if (!o.b) {
                const have = Number(model.balances.find((b) => b.coin === '+' + coin.slice(1))?.total ?? 0)
                assert.ok(Number(o.s) <= have, 'never offers more shares than the account holds')
              }
              if (o.t.limit.tif === 'Ioc') {
                model.orders.push(row)
                if (model.iocFill) fill(o.c)
                else {
                  model.orders = model.orders.filter((x) => x !== row)
                  record(row, 'canceled')
                }
                return { filled: { oid: row.oid, totalSz: '0', avgPx: o.p } }
              }
              model.orders.push(row)
              record(row, 'open')
              return { resting: { oid: row.oid } }
            })
            return { status: 'ok', response: { type: 'order', data: { statuses } } }
          }
          if (a.type === 'cancel') {
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
  let stored = validatePreferences({ acknowledged: ack, ...prefs }, { policy, strict: true }).prefs
  const preferences = {
    load: () => validatePreferences(stored, { policy }),
    save: (p) => {
      const result = validatePreferences(p, { policy, strict: true })
      stored = result.prefs
      return result
    },
  }
  const make = (over = {}) =>
    new TestnetRunner({
      owner,
      target,
      entry,
      read,
      clientFor,
      feeWaived,
      policy: runnerPolicy,
      preferences,
      now: clock.now,
      journal,
      actionStore,
      // Waits in the stop routine and re-reads move the test clock instead of real time.
      sleep: async (ms) => {
        clock.offset += ms
      },
      ...over,
    })
  const runner = make()
  await runner.load()
  const client = clientFor(ownerKey)
  const approve = () => {
    model.slots.push({ address: runner.wallet.address, name: nameFor(runner.wallet.address) })
    model.cap = fee
  }
  const resting = (pred = () => true) => model.orders.filter(pred)
  const bids = (coin) => resting((o) => o.side === 'B' && (!coin || o.coin === coin))
  const asks = (coin) => resting((o) => o.side === 'A' && (!coin || o.coin === coin))
  const orderCount = () => model.actions.filter((a) => a === 'order').length
  return { runner, model, read, client, entry, clientFor, clock, market, catalog, fill, approve, bids, asks, orderCount, make }
}

test('lost device: owner recovers testnet orders and revokes the old signer without the runner', async () => {
  const { runner, model, read, client, entry, clientFor, make } = await harness()
  const old = runner.wallet.address
  await assert.rejects(runner.start({ dedicated: true, markets: [id] }), /approval/)
  await runner.issue()
  await client.approveAgent({ agentAddress: old, agentName: nameFor(old) })
  await assert.rejects(runner.start({ dedicated: true, markets: [id] }), /approval/)
  await client.approveBuilderFee({ builder, maxFeeRate: '0.01%' })
  await runner.start({ dedicated: true, markets: [id] })
  assert.deepEqual(model.actions.slice(-2), ['scheduleCancel', 'order'])
  const before = await inspectRecovery(owner, target, read)
  assert.equal(before.orders.length, 2)
  // No method on the "lost" runner is called during second-device recovery.
  await revokeDevice(owner, before.agentRows[0], client, read)
  const rescue = await authorizeRecovery(owner, client, read)
  for (const order of before.orders) await cancelRecoveryOrder(owner, target, order, clientFor(rescue.wallet), read)
  await revokeDevice(owner, { address: rescue.wallet.address, name: nameFor(rescue.wallet.address) }, client, read)
  const after = await inspectRecovery(owner, target, read)
  assert.equal(after.agentRows.length, 0)
  assert.equal(after.orders.length, 0)
  assert.equal(model.cap, 10)
  const restarted = make({ entry, journal: runner.journal })
  await restarted.load()
  assert.equal(restarted.wallet.address, old)
  await assert.rejects(restarted.start({ dedicated: true, markets: [id] }))
  await assert.rejects(restarted.issue(), /already presented/)
  assert.equal(model.actions.filter((a) => a === 'order').length, 1)
})

test('preview shows each market, its sizes, opening debit and worst one-leg loss, and durations fit the agent', async () => {
  const { runner, model, approve, clock } = await harness()
  approve()
  model.until = clock.now() + 6 * 60000
  const preview = await runner.preview([id])
  // 0 is until stopped, bounded by the agent's own expiry.
  assert.deepEqual(preview.durations, [0, 1, 5])
  const [row] = preview.markets
  assert.equal(row.id, id)
  assert.equal(row.bids.length, 2)
  const shares = row.bids[0].shares
  assert.equal(row.bids[1].shares, shares)
  const leg = row.bids[0].px * shares * (1 + fee / 100000)
  assert.ok(Math.abs(row.worstOneLegLossUsd - leg) < 1e-6)
  assert.ok(Math.abs(row.debitUsd - (row.bids[0].px + row.bids[1].px) * shares * (1 + fee / 100000)) < 1e-6)
  assert.equal(Object.hasOwn(preview.settings, 'fractionFor'), false)
  assert.equal(JSON.stringify(preview).includes('fraction'), false)
  for (const minutes of [-1, 3, 15, Infinity]) {
    await assert.rejects(runner.start({ dedicated: true, minutes, markets: [id] }))
    assert.equal(model.actions.length, 0)
  }
  await runner.start({ dedicated: true, minutes: 1, markets: [id] })
  assert.ok(model.deadlines.at(-1) <= runner.run.endsAt)
  // The session ends with nothing held: bids are withdrawn and the run ends cleanly.
  runner.run.endsAt = clock.now()
  await runner.tick()
  assert.equal(model.orders.length, 0)
  assert.equal(runner.run, null)
  assert.match(runner.notice, /Session ended/)
})

test('status and preview expose user settings only, never pricing internals', async () => {
  const { runner, approve } = await harness()
  approve()
  await runner.start({ dedicated: true, markets: [id] })
  const status = await runner.status()
  assert.deepEqual(Object.keys(status.settings).sort(), [
    'budgetUsd',
    'dailyLossStopUsd',
    'depthPct',
    'hourlyLossStopUsd',
    'hours',
    'marketCount',
    'maxHeldPerLegUsd',
    'perSideUsd',
  ])
  const text = JSON.stringify(status)
  for (const word of ['fraction', 'familyWeight', 'othersScore', 'value'])
    assert.equal(text.includes(word), false, word)
  assert.equal(status.deskMarkets[0].state, 'quoting')
  assert.ok(status.requests.actionsLastHour >= 3)
  assert.equal(status.loss.markedLossUsd, 0)
  // Settings cannot change during a run.
  assert.throws(() => runner.savePreferencesFrom({ budgetUsd: 500 }), (e) => e.status === 409)
})

test('a full bid fill: no re-bid on that leg, one Alo sell at or above breakeven, ledger saved before the sell', async () => {
  const { runner, model, fill, approve, bids, asks, clock } = await harness()
  approve()
  const log = []
  const save = runner.journal.saveLedger.bind(runner.journal)
  runner.journal.saveLedger = (ledger) => {
    log.push({ kind: 'save', shares: ledger.positions['7010']?.shares ?? 0 })
    return save(ledger)
  }
  await runner.start({ dedicated: true, markets: [id] })
  const yesBid = bids(yesCoin)[0]
  fill(yesBid.cloid)
  const placedBefore = model.placed.length
  const realOrder = runner.client.order.bind(runner.client)
  runner.client.order = (...args) => {
    log.push({ kind: 'order', sells: args[0].orders.filter((o) => !o.b).length })
    return realOrder(...args)
  }
  await runner.tick()
  assert.ok(runner.run)
  const sells = asks(yesCoin)
  assert.equal(sells.length, 1)
  assert.equal(Number(sells[0].sz), Number(yesBid.origSz))
  const pos = runner.ledger.positions['7010']
  assert.equal(pos.shares, Number(yesBid.origSz))
  assert.ok(Number(sells[0].limitPx) >= breakevenPx(pos, runner.feeRates().sellMaker))
  assert.equal(model.placed.slice(placedBefore).find((o) => o.side === 'A').tif, 'Alo')
  assert.equal(bids(yesCoin).length, 0)
  const sellAt = log.findIndex((x) => x.kind === 'order' && x.sells)
  assert.ok(log.slice(0, sellAt).some((x) => x.kind === 'save' && x.shares === pos.shares))
  // A fill counts as a trade through: the other leg's bid waits for calm, then returns. The held leg never re-bids.
  assert.equal(bids(noCoin).length, 0)
  clock.offset += policy.guards.calmMs + 1000
  await runner.tick()
  assert.equal(bids(noCoin).length, 1)
  assert.equal(bids(yesCoin).length, 0)
  assert.equal(asks(yesCoin).length, 1)
})

test('a partial fill makes the exit size equal the filled shares', async () => {
  const { runner, fill, approve, bids, asks } = await harness()
  approve()
  await runner.start({ dedicated: true, markets: [id] })
  const yesBid = bids(yesCoin)[0]
  fill(yesBid.cloid, 30)
  await runner.tick()
  assert.equal(bids(yesCoin).length, 0, 'the partly filled bid is withdrawn')
  assert.equal(asks(yesCoin).length, 1)
  assert.equal(Number(asks(yesCoin)[0].sz), 30)
  assert.equal(runner.ledger.positions['7010'].shares, 30)
})

test('an exit fill returns the ledger to zero and the leg re-bids only after calm', async () => {
  const { runner, model, fill, approve, bids, asks, clock } = await harness()
  approve()
  await runner.start({ dedicated: true, markets: [id] })
  fill(bids(yesCoin)[0].cloid)
  await runner.tick()
  const exit = asks(yesCoin)[0]
  fill(exit.cloid)
  await runner.tick()
  assert.deepEqual(runner.ledger.positions, {})
  assert.ok(runner.ledger.realizedUsd > 0)
  assert.equal(model.balances.some((b) => b.coin === '+7010'), false)
  assert.equal(bids(yesCoin).length, 0)
  clock.offset += 30e3
  await runner.tick()
  assert.equal(bids(yesCoin).length, 0)
  clock.offset += policy.guards.calmMs
  await runner.tick()
  assert.equal(bids(yesCoin).length, 1)
})

test('repeated fills reach the action budget: bids stop, the run goes on exit only and never passes the allowance', async () => {
  const tight = { ...policy, requests: { ...policy.requests, maxOrderActionsPerHour: 30 } }
  const { runner, fill, approve, bids, asks, clock, model } = await harness({ runnerPolicy: tight })
  approve()
  await runner.start({ dedicated: true, minutes: 120, markets: [id] })
  let rounds = 0
  while (runner.run && runner.run.bidBlock?.code !== 'actions' && rounds < 60) {
    rounds++
    const bid = bids(yesCoin)[0]
    const ask = asks(yesCoin)[0]
    if (ask) fill(ask.cloid)
    else if (bid) fill(bid.cloid)
    clock.offset += policy.guards.calmMs + 1000
    await runner.tick()
    assert.ok(runner.actions.snapshot(clock.now()).actionsLastHour <= 30)
  }
  assert.ok(runner.run, 'the action budget never stops the run')
  assert.equal(runner.run.bidBlock.code, 'actions')
  assert.match(runner.notice, /allowance/)
  assert.ok(rounds < 60)
  assert.ok(model.placed.length <= 30)
  await runner.tick()
  assert.equal(bids().length, 0, 'no bid rests in exit only')
  if (runner.ledger.positions['7010']) assert.equal(asks(yesCoin).length, 1, 'held shares keep their exit')
})

test('exit only keeps a valid exit resting from the reserve, and still honours the cutoff and the timer', async () => {
  const start = Date.now() + 4 * 3600e3
  const journal = new RunJournal()
  journal.saveLedger({ ...emptyLedger(Date.now()), positions: { 7010: { shares: 100, cost: 49.8 } } })
  const { runner, model, approve, asks, bids, clock } = await harness({ start, journal })
  model.balances.push({ coin: '+7010', total: '100', hold: '0' })
  approve()
  await runner.start({ dedicated: true, minutes: 240, markets: [id] })
  assert.equal(asks(yesCoin).length, 1)
  assert.equal(bids(noCoin).length, 1)
  // Something else used every action the bids may have. Then the price moves, so the bid has to be withdrawn.
  const snap = runner.actions.snapshot(clock.now())
  runner.actions.spend('order', snap.entriesLeft, clock.now(), { entry: true })
  model.tops[yesCoin] = ['0.501', '0.503']
  model.tops[noCoin] = ['0.497', '0.499']
  clock.offset += 10000
  await runner.tick()
  assert.ok(runner.run)
  assert.equal(runner.run.bidBlock.code, 'actions')
  assert.equal(bids().length, 0, 'the bid is withdrawn from the reserve')
  assert.equal(asks(yesCoin).length, 1, 'the exit stays offered')
  assert.ok(Number(asks(yesCoin)[0].limitPx) > 0.501)
  // The exit is refreshed from the reserve when the plan moves it.
  model.tops[yesCoin] = ['0.6', '0.62']
  model.tops[noCoin] = ['0.38', '0.4']
  for (let i = 0; i < 12; i++) {
    clock.offset += 10000
    await runner.tick()
  }
  assert.equal(asks(yesCoin).length, 1)
  assert.ok(Number(asks(yesCoin)[0].limitPx) > 0.6)
  assert.equal(bids().length, 0)
  const after = runner.actions.snapshot(clock.now())
  assert.ok(after.actionsLastHour <= after.perHour)
  const cutoff = quoteCutoff(start, undefined)
  for (const d of model.deadlines) assert.ok(d <= cutoff)
  // Near the cutoff exit only withdraws everything like any run; nothing is placed at or after it.
  clock.offset = cutoff - 29000 - Date.now()
  await runner.tick()
  assert.equal(model.orders.length, 0)
  const placed = model.placed.length
  clock.offset = start - 59000 - Date.now()
  await runner.tick()
  assert.equal(model.placed.length, placed)
})

test('an exit the exchange refuses backs off per leg instead of looping into the action budget', async () => {
  const { runner, model, approve, clock, fill, bids, asks } = await harness()
  approve()
  await runner.start({ dedicated: true, minutes: 240, markets: [id] })
  fill(bids(yesCoin)[0].cloid)
  model.rejectSells = true
  let sellAttempts = 0
  const order = runner.client.order.bind(runner.client)
  runner.client.order = (args, opts) => {
    sellAttempts += args.orders.filter((o) => !o.b).length
    return order(args, opts)
  }
  for (let t = 0; t < 1800 / 8; t++) {
    clock.offset += 8000
    await runner.tick()
  }
  assert.ok(runner.run)
  assert.equal(runner.run.bidBlock, null, 'refusals alone never use up the budget')
  // 60 s, then 120 s, 240 s and so on: a handful of tries in half an hour, not one per tick.
  assert.ok(sellAttempts >= 3 && sellAttempts <= 7, String(sellAttempts))
  assert.ok(runner.actions.snapshot(clock.now()).actionsLastHour < 120)
  assert.match((await runner.status()).deskMarkets[0].reason ?? '', /refused/)
  // Once the exchange accepts it again the exit rests, within the longest wait.
  model.rejectSells = false
  for (let t = 0; t < 900 / 8 + 2 && !asks(yesCoin).length; t++) {
    clock.offset += 8000
    await runner.tick()
  }
  assert.equal(asks(yesCoin).length, 1)
})

test('a stale book pulls the bids and does not stop the run', async () => {
  const { runner, model, approve, bids } = await harness()
  approve()
  await runner.start({ dedicated: true, markets: [id] })
  assert.equal(bids().length, 2)
  model.bookAge = 10000
  await runner.tick()
  assert.ok(runner.run)
  assert.equal(bids().length, 0)
  assert.equal((await runner.status()).deskMarkets[0].state, 'pulled')
  model.bookAge = 0
  await runner.tick()
  assert.equal(bids().length, 2)
})

test('a transient read failure pauses with backoff and drops to exit only after ten in a row', async () => {
  const { runner, read, approve, bids, clock } = await harness()
  approve()
  await runner.start({ dedicated: true, minutes: 120, markets: [id] })
  const view = read.accountView
  read.accountView = async () => {
    throw Error('Hyperliquid testnet could not verify frontendOpenOrders (429).')
  }
  await runner.tick()
  assert.ok(runner.run)
  assert.equal(bids().length, 0, 'known bids are withdrawn')
  assert.equal(runner.run.backoffUntil - clock.now() <= 7000, true)
  for (let i = 0; i < 8; i++) {
    clock.offset += 61000
    await runner.tick()
    assert.ok(runner.run)
  }
  read.accountView = view
  clock.offset += 61000
  await runner.tick()
  assert.equal(runner.run.failures, 0)
  read.accountView = async () => {
    throw Error('timeout')
  }
  for (let i = 0; i < 10; i++) {
    clock.offset += 61000
    await runner.tick()
  }
  assert.ok(runner.run)
  assert.equal(runner.run.bidBlock.code, 'errors')
  assert.match(runner.run.bidBlock.message, /Ten checks/)
  read.accountView = view
  clock.offset += 61000
  await runner.tick()
  assert.ok(runner.run)
  assert.equal(bids().length, 0, 'no new bids after ten failed checks')
})

test('a foreign order is a hard stop and is left untouched', async () => {
  const { runner, model, approve } = await harness()
  approve()
  await runner.start({ dedicated: true, markets: [id] })
  model.orders.push({ coin: '#7010', cloid: '0x00000000000000000000000000000000', sz: '10', origSz: '10', limitPx: '0.51', oid: 999, side: 'A' })
  await assert.rejects(runner.tick(), /dedicated/)
  assert.equal(runner.run, null)
  assert.deepEqual(
    model.orders.map((o) => o.oid),
    [999]
  )
})

test('the disconnect timer re-arms about every two minutes, not every tick', async () => {
  const { runner, model, approve, clock } = await harness()
  approve()
  await runner.start({ dedicated: true, markets: [id] })
  const arms = () => model.actions.filter((a) => a === 'scheduleCancel').length
  assert.equal(arms(), 1)
  assert.ok(model.deadlines[0] - clock.now() <= policy.dms.deadlineMs)
  for (let i = 0; i < 10; i++) {
    clock.offset += 10000
    await runner.tick()
  }
  assert.equal(arms(), 1)
  clock.offset += 30000
  await runner.tick()
  assert.equal(arms(), 2)
  assert.ok(model.deadlines.at(-1) > model.deadlines[0])
})

test('the disconnect deadline never passes the earliest cutoff of a market with resting orders', async () => {
  const start = Date.now() + 15 * 60000 // closed to bids, before the force stage: the exit rests
  const journal = new RunJournal()
  journal.saveLedger({ ...emptyLedger(Date.now()), positions: { 7010: { shares: 100, cost: 49.8 } } })
  const { runner, model, approve, asks, clock } = await harness({ start, journal })
  model.balances.push({ coin: '+7010', total: '100', hold: '0' })
  approve()
  await runner.start({ dedicated: true, markets: [id] })
  assert.equal(asks().length, 1)
  assert.equal(model.placed.filter((o) => o.side === 'B').length, 0, 'no bids inside the entry close')
  const cutoff = quoteCutoff(start, undefined)
  for (const d of model.deadlines) assert.ok(d <= cutoff)
  // Thirty seconds before the cutoff everything is withdrawn; nothing is placed at or after start minus 60 s.
  clock.offset = cutoff - 29000 - Date.now()
  await runner.tick()
  assert.equal(model.orders.length, 0)
  clock.offset = start - 59000 - Date.now()
  const placed = model.placed.length
  await runner.tick()
  assert.equal(model.placed.length, placed)
  assert.ok(model.placed.every((o) => o.at < start - 60000))
})

test('a restart with a matching ledger resumes; one with a mismatch blocks', async () => {
  const shares = { 7010: { shares: 100, cost: 49.8 } }
  {
    const journal = new RunJournal()
    journal.saveLedger({ ...emptyLedger(Date.now()), positions: shares })
    const { runner, model, approve, asks, bids } = await harness({ journal })
    model.balances.push({ coin: '+7010', total: '100', hold: '0' })
    approve()
    await runner.start({ dedicated: true, markets: [id] })
    assert.equal(asks(yesCoin).length, 1)
    assert.equal(bids(yesCoin).length, 0)
    assert.equal(bids(noCoin).length, 1)
  }
  {
    const journal = new RunJournal()
    journal.saveLedger({ ...emptyLedger(Date.now()), positions: shares })
    const { runner, model, approve } = await harness({ journal })
    model.balances.push({ coin: '+7010', total: '120', hold: '0' })
    approve()
    await assert.rejects(runner.start({ dedicated: true, markets: [id] }), /holds outcome shares/)
    assert.equal(model.actions.length, 0)
  }
  {
    // Shares nobody recorded block too.
    const { runner, model, approve } = await harness()
    model.balances.push({ coin: '+7011', total: '3', hold: '0' })
    approve()
    await assert.rejects(runner.start({ dedicated: true, markets: [id] }), /holds outcome shares/)
  }
})

test('a ledger and venue mismatch during a run is a hard stop', async () => {
  const { runner, model, approve } = await harness()
  approve()
  await runner.start({ dedicated: true, markets: [id] })
  model.balances.push({ coin: '+7011', total: '7', hold: '0' })
  await assert.rejects(runner.tick(), /position record/)
  assert.equal(runner.run, null)
  assert.equal(model.orders.length, 0)
})

test('the builder fee is zero only for a wallet passed in feeWaived', async () => {
  for (const [waived, expectFee] of [
    [[owner.toUpperCase().replace('0X', '0x')], 0],
    [['0x000000000000000000000000000000000000dead'], fee],
    [[], fee],
  ]) {
    const { runner, approve, orderCount } = await harness({ feeWaived: waived, expectFee })
    approve()
    await runner.start({ dedicated: true, markets: [id] })
    assert.equal((await runner.status()).fee, expectFee)
    assert.equal(orderCount(), 1)
  }
})

test('picking markets automatically accounts for every market with a plain reason', async () => {
  const { runner, approve } = await harness()
  approve()
  const preview = await runner.preview('auto')
  const ids = [...preview.markets.map((m) => m.id), ...preview.excluded.map((m) => m.id)]
  assert.deepEqual(ids, [id])
  for (const m of preview.excluded) assert.match(m.reason, /\s/)
  await assert.rejects(runner.start({ dedicated: true, markets: [id, id] }), /Choose/)
  await assert.rejects(runner.start({ dedicated: true, markets: Array.from({ length: 13 }, (_, i) => i + 1) }))
})

test('budgets too small for the exchange minimum skip the market with a clear reason', async () => {
  const { runner, approve, model } = await harness({ prefs: { budgetUsd: 50, perSideUsd: 27, markets: 3 } })
  approve()
  const preview = await runner.preview([id])
  assert.equal(preview.markets[0].bids.length, 0)
  assert.match(preview.markets[0].reason, /smallest order/)
  await runner.start({ dedicated: true, markets: [id] })
  assert.equal(model.orders.length, 0)
  assert.match((await runner.status()).deskMarkets[0].reason, /smallest order/)
})

test('run receipt survives restart and reconciles missed acknowledgements without duplicating fees', async () => {
  const { runner, model, fill, approve, make, clock } = await harness()
  approve()
  await runner.start({ dedicated: true, markets: [id] })
  const rid = runner.run.receiptId
  const order = model.orders.find((o) => o.coin === yesCoin)
  const time = Date.now()
  const base = { coin: order.coin, oid: order.oid, time, side: 'B', px: order.limitPx, feeToken: 'USDC' }
  const rows = [
    { ...base, tid: 21, sz: '4', fee: '0.03', builderFee: '0.01' },
    { ...base, tid: 22, sz: '1', fee: '0.02', cloid: order.cloid },
    { ...base, tid: 23, sz: '10', fee: '0.1', oid: 900, cloid: 'unrelated' },
  ]
  const restarted = make({ journal: runner.journal })
  await restarted.load()
  assert.equal(restarted.pendingStop, rid)
  await assert.rejects(restarted.start({ dedicated: true, markets: [id] }), /Verify cancellation/)
  fill(order.cloid, 5)
  clock.offset += 5000
  await restarted.cancel()
  // The fill that happened while the runner was down is in the ledger after the verified stop.
  assert.equal(restarted.ledger.positions['7010'].shares, 5)
  assert.deepEqual(restarted.ledger.pending, {})
  const lookup = async (type, params) => {
    assert.equal(params.user, target)
    if (type === 'userFillsByTime') return rows
    assert.equal(params.oid, order.cloid)
    return { order: { order } }
  }
  for (let i = 0; i < 2; i++) {
    const receipt = await restarted.journal.refresh(rid, target, lookup)
    assert.equal(receipt.sides.length, 1)
    assert.equal(receipt.sides[0].shares, 5)
    assert.equal(receipt.fills.length, 2)
    assert.equal(receipt.fees[0].total, 0.05)
    assert.equal(receipt.fees[0].builder, 0.01)
    assert.deepEqual(receipt.endInventory, [{ coin: '+7010', total: '5' }])
    assert.equal(receipt.warning, null)
  }
  await assert.rejects(
    restarted.journal.refresh(rid, target, async () => {
      throw Error('offline')
    }),
    /offline/
  )
  assert.equal(restarted.journal.receipt(rid).fills.length, 2)
  assert.equal(model.actions.filter((a) => a === 'order').length, 1)
})

// ---- review 2026-11-21 ---------------------------------------------------------------------------------------------

const roomy = (over = {}) => ({
  ...policy,
  rank: { ...policy.rank, subsetShare: 1 },
  requests: { ...policy.requests, maxOrderActionsPerHour: 5000, actionsPerMarketPerHour: 600, ...over },
})

test('held shares count against the budget: across re-ranks held cost plus resting bids never pass it', async () => {
  const ids = [701, 702, 703, 704, 705, 706]
  const budget = 120
  const { runner, model, approve, bids, clock, fill } = await harness({
    ids,
    runnerPolicy: roomy(),
    prefs: { budgetUsd: budget, markets: 3 },
  })
  approve()
  await runner.start({ dedicated: true, minutes: 480, markets: 'auto' })
  const rate = runner.feeRates().buy
  const committed = () => {
    const held = Object.values(runner.ledger.positions).reduce((n, p) => n + p.cost, 0)
    const resting = bids().reduce((n, o) => n + Number(o.limitPx) * Number(o.sz) * (1 + rate), 0)
    return { held, total: held + resting }
  }
  const touched = new Set()
  let reranks = 0
  let rankedAt = runner.run.rankedAt
  for (let i = 0; i < 60; i++) {
    const open = bids()
    if (open.length) {
      const o = open[i % open.length]
      touched.add(Math.floor(Number(o.coin.slice(1)) / 10))
      fill(o.cloid)
    }
    // Markets we already hold get crowded, so each re-rank moves the bids to fresh markets.
    model.depth = {}
    for (const legId of Object.keys(runner.ledger.positions)) {
      const m = Math.floor(Number(legId) / 10)
      model.depth['#' + m * 10] = model.depth['#' + (m * 10 + 1)] = '500000'
    }
    clock.offset += policy.guards.calmMs + 1000
    await runner.tick()
    assert.ok(runner.run)
    if (runner.run.rankedAt !== rankedAt) reranks++
    rankedAt = runner.run.rankedAt
    assert.ok(committed().total <= budget + 1e-6, `held ${committed().held} plus bids ${committed().total}`)
  }
  assert.ok(reranks >= 5)
  assert.ok(committed().held > budget / 2, 'the budget really was used by held shares')
  assert.equal(model.orders.filter((o) => o.side === 'B').length, bids().length)
})

test('both legs held: the two exits rest at prices that sum to more than 1', async () => {
  const { runner, approve, bids, asks, fill } = await harness()
  approve()
  await runner.start({ dedicated: true, markets: [id] })
  for (const b of bids()) fill(b.cloid)
  await runner.tick()
  const [yes] = asks(yesCoin)
  const [no] = asks(noCoin)
  assert.ok(yes && no)
  assert.ok(Math.round((Number(yes.limitPx) + Number(no.limitPx)) * 1e5) > 1e5, yes.limitPx + ' + ' + no.limitPx)
  for (const o of [yes, no]) assert.ok(Number(o.limitPx) >= breakevenPx(runner.ledger.positions[o.coin.slice(1)], runner.feeRates().sellMaker))
})

test('the action budget lives on the runner: a stop and start, or a restart, does not reset it', async () => {
  const store = memoryActionStore()
  const { runner, approve, clock, make, entry } = await harness({ actionStore: store })
  approve()
  await runner.start({ dedicated: true, markets: [id] })
  const used = runner.actions.snapshot(clock.now()).actionsLastHour
  assert.ok(used >= 3)
  await runner.cancel()
  await runner.start({ dedicated: true, markets: [id] })
  const again = runner.actions.snapshot(clock.now()).actionsLastHour
  assert.ok(again >= used + 3, 'the second start adds to the first')
  await runner.cancel()
  // A new process inside the hour reads the saved count.
  const restarted = make({ entry, journal: runner.journal })
  await restarted.load()
  assert.equal(restarted.actions.snapshot(clock.now()).actionsLastHour, again)
  // An hour later it has drained.
  assert.equal(restarted.actions.snapshot(clock.now() + 3600e3 + 1).actionsLastHour, 0)
  // A saved count that cannot be read blocks new bids for the hour, not exits.
  const broken = make({ actionStore: { load: () => null, save: () => {} } })
  const snap = broken.actions.snapshot(clock.now())
  assert.equal(snap.entriesLeft, 0)
  assert.ok(snap.left > 0)
  assert.match(broken.notice, /could not be read/)
})

test('up to six markets share the hourly ceiling: the allowance is sized per active market and never above it', async () => {
  {
    // Reference policy: 6 markets at most, one ceiling of 240 actions an hour for all of them.
    const ids = [701, 702, 703, 704, 705, 706, 707]
    const { runner, approve, clock } = await harness({ ids, prefs: { budgetUsd: 2000, markets: 6 } })
    approve()
    assert.equal(runner.marketCap(), 6)
    assert.equal((await runner.status()).maxMarkets, 6)
    await assert.rejects(runner.start({ dedicated: true, markets: ids }), /1 to 6/)
    await runner.start({ dedicated: true, markets: ids.slice(0, 6) })
    assert.equal(runner.actions.snapshot(clock.now()).perHour, policy.requests.maxOrderActionsPerHour)
  }
  {
    const { runner, approve, clock } = await harness({
      ids: [701, 702, 703],
      prefs: { budgetUsd: 2000, markets: 3 },
      runnerPolicy: roomy({ maxOrderActionsPerHour: 1000, actionsPerMarketPerHour: 100 }),
    })
    approve()
    await runner.start({ dedicated: true, markets: [701, 702, 703] })
    assert.equal(runner.actions.snapshot(clock.now()).perHour, 300)
  }
})

test('a request that timed out but landed learns its order id from the book, so the bid can be withdrawn', async () => {
  const { runner, read, approve, bids, clock } = await harness()
  approve()
  const order = runner.client.order.bind(runner.client)
  let lose = true
  runner.client.order = async (args, opts) => {
    const result = await order(args, opts)
    if (lose) {
      lose = false
      throw Object.assign(Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
    }
    return result
  }
  await runner.start({ dedicated: true, markets: [id] })
  assert.equal(bids().length, 2)
  assert.ok(Object.values(runner.ledger.pending).every((p) => p.unacked && !p.oid))
  clock.offset += 8000
  await runner.tick()
  const pending = Object.values(runner.ledger.pending).filter((p) => p.side === 'B')
  assert.equal(pending.length, 2)
  for (const p of pending) assert.ok(Number.isSafeInteger(p.oid) && !p.unacked)
  read.accountView = async () => {
    throw Error('Hyperliquid testnet could not verify frontendOpenOrders (429).')
  }
  clock.offset += 8000
  await runner.tick()
  assert.equal(bids().length, 0, 'withdrawn by order id during the pause')
})

test('only network, timeout, 429 and 5xx errors are transient; a bug or SDK validation error is not', async () => {
  const http = (status) => Object.assign(Error(status ? status + ' x' : 'Unknown HTTP request error'), {
    name: 'HttpRequestError',
    response: status ? { status } : undefined,
  })
  for (const e of [
    http(429),
    http(502),
    http(),
    Object.assign(Error('t'), { name: 'TimeoutError' }),
    new TypeError('fetch failed'),
    Error('Runner read budget reached. Cancellation capacity is reserved.'),
    Error('Hyperliquid testnet could not verify l2Book (503).'),
  ])
    assert.equal(isTransient(e), true, e.message)
  for (const e of [
    http(400),
    new TypeError('Cannot read properties of undefined'),
    Object.assign(Error('Invalid order'), { name: 'ValidationError' }),
    Object.assign(Error('bad'), { name: 'FormatError' }),
    Error('Exchange action budget reached'),
  ])
    assert.equal(isTransient(e), false, e.message)

  const { runner, approve, read, clock, bids } = await harness()
  approve()
  await runner.start({ dedicated: true, minutes: 60, markets: [id] })
  {
    // A validation error from the SDK blocks bids at once instead of ten rounds of short backoff.
    const order = runner.client.order.bind(runner.client)
    runner.client.order = () => {
      throw Object.assign(Error('Invalid input'), { name: 'ValidationError' })
    }
    for (const b of bids()) await runner.client.cancel({ cancels: [{ a: 100000000 + Number(b.coin.slice(1)), o: b.oid }] }, runner.opts)
    clock.offset += 8000
    await runner.tick()
    assert.ok(runner.run)
    assert.equal(runner.run.bidBlock.code, 'errors')
    assert.match(runner.run.bidBlock.message, /Invalid input/)
    assert.ok(runner.run.backoffUntil - clock.now() >= 55e3, 'retried after a minute')
    runner.client.order = order
  }
  clock.offset += 61000
  await runner.tick()
  assert.equal(runner.run.unclassified, 0, 'a good tick clears the count')
  assert.equal(runner.run.bidBlock, null)
  // Repeated unexpected failures never stop the run: only integrity failures stop selling.
  const markets = read.markets
  read.markets = async () => {
    throw new TypeError('catalog is not iterable')
  }
  for (let i = 0; i < 3; i++) {
    clock.offset += 61000
    await runner.tick()
    assert.ok(runner.run)
    assert.equal(runner.run.bidBlock.code, 'errors')
  }
  read.markets = markets
})

test('account blips get a couple of re-reads before they count; a lagging cancel readback too', async () => {
  const { runner, read, approve, bids, clock, model } = await harness()
  approve()
  await runner.start({ dedicated: true, minutes: 60, markets: [id] })
  const view = read.accountView
  let blips = 2
  read.accountView = async (...a) => {
    if (blips-- > 0) throw Error('Incomplete account information.')
    return view(...a)
  }
  clock.offset += 8000
  await runner.tick()
  assert.ok(runner.run)
  assert.equal(runner.run.bidBlock, null)
  assert.equal(bids().length, 2)
  // The cancel readback still says open the first time it is read.
  const info = read.info
  let lag = 1
  read.info = async (type, p) => {
    if (type === 'orderStatus' && lag-- > 0) return { status: 'order', order: { status: 'open', order: {} } }
    return info(type, p)
  }
  model.bookAge = 10000
  clock.offset += 8000
  await runner.tick()
  assert.ok(runner.run)
  assert.equal(bids().length, 0)
  read.info = info
  model.bookAge = 0
  // Three in a row is a hard stop, which cancels everything.
  blips = 3
  clock.offset += 8000
  await assert.rejects(runner.tick(), /Incomplete account information/)
  assert.equal(runner.run, null)
  assert.equal(model.orders.length, 0)
})

test('market id 0 is a valid market', async () => {
  const { runner, approve } = await harness({ ids: [0] })
  approve()
  assert.deepEqual(runner.manualIds([0], { marketCount: 1 }), [0])
  const preview = await runner.preview([0])
  assert.equal(preview.markets[0].id, 0)
  assert.equal(preview.markets[0].bids.length, 2)
  assert.throws(() => runner.manualIds([-1], { marketCount: 1 }))
})

test('an unreadable saved position record refuses to start with a plain message', async () => {
  const journal = new RunJournal()
  journal.loadLedger = () => {
    throw Error('Saved ledger row is not a valid ledger.')
  }
  const { runner, model, approve } = await harness({ journal })
  approve()
  await assert.rejects(runner.start({ dedicated: true, markets: [id] }), /position record saved on this device cannot be read/)
  assert.equal(model.actions.length, 0)
})

test('a start without the current risk acknowledgement is refused before anything is sent', async () => {
  const { runner, model, approve } = await harness({ prefs: { acknowledged: null } })
  approve()
  await assert.rejects(runner.start({ dedicated: true, markets: [id] }), /risk statement/)
  assert.equal(model.actions.length, 0)
  const old = await harness({ prefs: { acknowledged: { version: 'risk-0', at: ack.at } } })
  old.approve()
  await assert.rejects(old.runner.start({ dedicated: true, markets: [id] }), /risk statement/)
})

test('buys carry the builder fee only; sells add the exchange fee of their side', async () => {
  const { runner } = await harness()
  const rates = runner.feeRates()
  assert.equal(rates.buy, fee / 100000)
  assert.ok(rates.sellMaker > rates.buy && rates.sellTaker > rates.sellMaker)
})

test('mainnet: off in this build; with the switch on in a test, the arming must verify for the mainnet agent itself', async () => {
  const { runner } = await harness()
  await assert.rejects(runner.arm({}), /not enabled in this build/)
  await assert.rejects(runner.start({ dedicated: true, markets: [id], network: 'mainnet' }), /not enabled in this build/)
  assert.match(runner.armingView().reason, /not enabled/)

  const { armingMessage, armingPhrase, statementVersion } = await import('../../lib/mm/arming.mjs')
  const { exchangeClientFor } = await import('./exchange-client.mjs')
  let mainnetSecret = null
  const on = await harness()
  const armed = on.make({
    entries: { mainnet: { getPassword: async () => mainnetSecret, setPassword: async (v) => (mainnetSecret = v) } },
    journals: { mainnet: new RunJournal() },
    mainnetSwitch: true,
    device: 'test',
  })
  await armed.load()
  // Loading the runner makes no mainnet key; the user starting mainnet setup does.
  assert.equal(mainnetSecret, null)
  assert.equal(armed.profiles.mainnet, undefined)
  const { mainnetAgent } = await armed.prepareMainnet()
  const agent = armed.profiles.mainnet.wallet.address
  assert.equal(mainnetAgent, agent)
  assert.notEqual(agent, armed.wallet.address, 'a separate mainnet agent key')
  const issuedAt = Date.now()
  const fields = {
    owner,
    target,
    agent,
    device: 'test',
    issuedAt,
    expiresAt: issuedAt + 3600e3,
    phrase: armingPhrase(target),
    statementVersion,
  }
  const forged = { ...fields, agent: account().address, signature: await ownerKey.signMessage({ message: armingMessage({ ...fields, agent: account().address }) }) }
  assert.equal((await armed.arm(forged)).arming.verified, false, 'an arming for another agent does not verify')
  const record = { ...fields, signature: await ownerKey.signMessage({ message: armingMessage(fields) }) }
  const result = await armed.arm(record)
  assert.equal(result.arming.verified, true)
  assert.equal(armed.arming.agent, agent)
  // The exchange client accepts exactly that arming for the mainnet agent, with a fake mainnet transport only.
  const transport = { isTestnet: false, request: async () => ({ status: 'ok', response: { type: 'default' } }) }
  assert.ok(exchangeClientFor({ network: 'mainnet', wallet: armed.profiles.mainnet.wallet, arming: armed.armingForClient(), transport }))
  assert.throws(() => exchangeClientFor({ network: 'mainnet', wallet: armed.wallet, arming: armed.armingForClient(), transport }))
  assert.throws(() => exchangeClientFor({ network: 'mainnet', wallet: armed.profiles.mainnet.wallet, arming: armed.armingForClient() }), /switched off/)
  await armed.disarm()
  assert.equal(armed.arming, null)
})

test('the runner shuts down on console close and hang-up like on SIGTERM', () => {
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) assert.ok(shutdownSignals.includes(sig), sig)
})

test('every detected fill reaches the daily view at once, matches the ledger, and is never counted twice', async () => {
  const { runner, fill, approve, bids, asks, make, entry } = await harness()
  approve()
  const journal = runner.journal
  const fills = () => journal.db.prepare('SELECT COUNT(*) AS n FROM fills').get().n
  const close = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-6, what + ': ' + a + ' vs ' + b)
  await runner.start({ dedicated: true, markets: [id] })
  fill(bids(yesCoin)[0].cloid)
  await runner.tick()
  assert.equal(fills(), 1, 'the bid fill is booked when the engine sees it, with no receipt refresh')
  const beforeExit = journal.loadLedger()
  fill(asks(yesCoin)[0].cloid)
  await runner.tick()
  assert.deepEqual(runner.ledger.positions, {})
  const realized = runner.ledger.realizedUsd
  assert.ok(realized !== 0)
  const row = journal.dailyRows().at(-1)
  // Trading result is cash in and out; fees are apart; net is what the ledger realized.
  close(row.netUsd, realized, 'net')
  close(row.tradingUsd - row.feesUsd, realized, 'trading result less fees')
  assert.ok(row.feesUsd > 0)
  assert.equal(fills(), 2)
  await runner.cancel()

  // A restart reads the same journal and adds nothing.
  const restarted = make({ entry, journal })
  await restarted.load()
  await restarted.start({ dedicated: true, markets: [id] })
  await restarted.tick()
  await restarted.cancel()
  assert.equal(fills(), 2)
  assert.deepEqual(journal.dailyRows().at(-1), row)

  // A crash after the journal write and before the ledger commit: the next start sees the exit fill again, under
  // the same key, so the daily view is unchanged while the ledger catches up.
  journal.saveLedger(beforeExit)
  const again = make({ entry, journal })
  await again.load()
  await again.start({ dedicated: true, markets: [id] })
  close(again.ledger.realizedUsd, realized, 'ledger after the re-read')
  await again.cancel()
  assert.equal(fills(), 2)
  assert.deepEqual(journal.dailyRows().at(-1), row)
})

test('a receipt refresh replaces the engine rows of an order once the exchange rows cover them', () => {
  const journal = new RunJournal()
  const run = journal.begin({ id, label: 'x', agent: '0x0', budget: 100, started: Date.now(), endsAt: Date.now() + 1 })
  journal.record(run, [{ c: '0xaa', a: 100007010, b: true }])
  const at = Date.now()
  journal.recordEngineFills([{ cloid: '0xaa', filledTotal: 10, sz: 10, px: 0.5, oid: 7, time: at, fee: 0.001, builderFee: 0.0005 }])
  journal.recordEngineFills([{ cloid: '0xaa', filledTotal: 10, sz: 10, px: 0.5, oid: 7, time: at, fee: 0.001, builderFee: 0.0005 }])
  // An order this journal never recorded is skipped, not an error.
  journal.recordEngineFills([{ cloid: '0xbb', filledTotal: 1, sz: 1, px: 0.5, oid: 8, time: at, fee: 0, builderFee: 0 }])
  const total = () => journal.dailyFills().reduce((n, f) => n + f.sz, 0)
  assert.equal(total(), 10)
  const put = journal.db.prepare("INSERT INTO fills VALUES('0xaa',?,7,?,'0.5',?,'0.001','USDC','0.0005')")
  put.run(1, at, '4')
  assert.equal(total(), 10, 'a partial exchange record leaves the engine rows in use')
  put.run(2, at, '6')
  assert.equal(total(), 10, 'complete exchange rows take over')
  assert.equal(journal.dailyFills().length, 2)
})

test('loading the runner makes no mainnet key; starting mainnet setup does, once', async () => {
  let mainnetSecret = null
  let writes = 0
  const on = await harness()
  const runner = on.make({
    entries: {
      mainnet: { getPassword: async () => mainnetSecret, setPassword: async (v) => ((mainnetSecret = v), writes++) },
    },
    journals: { mainnet: new RunJournal() },
  })
  await runner.load()
  assert.equal(writes, 0)
  assert.equal((await runner.status()).mainnetAgent, null)
  const first = await runner.prepareMainnet()
  const second = await runner.prepareMainnet()
  assert.equal(writes, 1)
  assert.equal(first.mainnetAgent, second.mainnetAgent)
  assert.notEqual(first.mainnetAgent, runner.wallet.address)
  assert.equal((await runner.status()).mainnetAgent, first.mainnetAgent)
  // A later load opens the saved key and makes no new one.
  const reloaded = on.make({
    entries: { mainnet: { getPassword: async () => mainnetSecret, setPassword: async () => writes++ } },
    journals: { mainnet: new RunJournal() },
  })
  await reloaded.load()
  assert.equal(writes, 1)
  assert.equal(reloaded.profiles.mainnet.wallet.address, first.mainnetAgent)
})
