// The hosted runner pieces: shutdown, resume after a restart, the crash-loop guard, the lock, the env key that is never
// shown, and pairing on a public address. A fake venue only; no socket is opened and no port is bound.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { ExchangeClient } from '@nktkas/hyperliquid'
import { TestnetRunner } from './testnet-engine.mjs'
import { createRunnerApp, allowedOrigins, localHost, installProcessHandlers } from './testnet-runner.mjs'
import { RunJournal } from './run-journal.mjs'
import { acquireLock, bootGuard, envAgentEntry, profileStore, resolveStateDir } from './state-dir.mjs'
import { nameFor, fee } from '../../lib/mm/testnet.mjs'
import { loadPolicy } from './policy/index.mjs'
import { validatePreferences } from './preferences.mjs'

const policy = loadPolicy()
const ownerKey = privateKeyToAccount(generatePrivateKey())
const owner = ownerKey.address.toLowerCase()
const target = privateKeyToAccount(generatePrivateKey()).address.toLowerCase()
const id = 701
const ack = { version: 'risk-1', at: '2026-11-21T00:00:00.000Z' }
const tmp = (name) => mkdtempSync(join(tmpdir(), 'mm-' + name + '-'))

function venue() {
  const clock = { offset: 0, now: () => Date.now() + clock.offset }
  const start = clock.now() + 5 * 3600e3
  const model = { cap: fee, slots: [], orders: [], history: new Map(), balances: [{ coin: 'USDC', total: '5000', hold: '0' }], actions: [], nextOid: 1 }
  const book = (coin) => ({ coin, time: clock.now(), levels: [[{ px: '0.499', sz: '5000' }], [{ px: '0.501', sz: '5000' }]] })
  const record = (o, status) => {
    const entry = { status, order: { ...o } }
    model.history.set(o.oid, entry)
    model.history.set(o.cloid, entry)
  }
  const read = {
    targets: async () => [owner, target],
    markets: async () => [{ id, start, label: 'A vs B', questionName: 'template:sportsContestResult', description: 'participantA:A|participantB:B' }],
    accountView: async () => structuredClone({ orders: model.orders, balances: model.balances }),
    permissions: async (o, a) => ({ cap: model.cap, builderReady: true, approved: model.slots.includes(a.toLowerCase()), occupied: false }),
    readBooks: async (ids) => new Map(ids.map((m) => [m, [book('#' + m * 10), book('#' + (m * 10 + 1))]])),
    info: async (type, p) => {
      if (type === 'orderStatus') {
        const h = model.history.get(p.oid)
        return h ? { status: 'order', order: structuredClone(h) } : { status: 'unknownOid' }
      }
      if (type === 'l2Book') return book(p.coin)
      throw Error('unexpected read ' + type)
    },
  }
  const clientFor = (wallet) =>
    new ExchangeClient({
      wallet,
      signatureChainId: '0xa4b1',
      transport: {
        isTestnet: true,
        request: async (endpoint, payload) => {
          const a = payload.action
          model.actions.push(a.type === 'scheduleCancel' ? (a.time ? 'arm' : 'disarm') : a.type)
          if (a.type === 'order') {
            const statuses = a.orders.map((o) => {
              const row = { coin: '#' + (o.a - 100000000), cloid: o.c, limitPx: o.p, sz: o.s, origSz: o.s, oid: model.nextOid++, side: o.b ? 'B' : 'A' }
              model.orders.push(row)
              record(row, 'open')
              return { resting: { oid: row.oid } }
            })
            return { status: 'ok', response: { type: 'order', data: { statuses } } }
          }
          if (a.type === 'cancel')
            for (const c of a.cancels) {
              const row = model.orders.find((o) => o.oid === c.o)
              if (row) {
                model.orders = model.orders.filter((o) => o !== row)
                record(row, 'canceled')
              }
            }
          return { status: 'ok', response: { type: 'default' } }
        },
      },
    })
  let stored = validatePreferences({ acknowledged: ack, budgetUsd: 2000 }, { policy, strict: true }).prefs
  const preferences = {
    load: () => validatePreferences(stored, { policy }),
    save: (p) => ((stored = validatePreferences(p, { policy, strict: true }).prefs), { prefs: stored, warnings: [] }),
  }
  let secret = null
  const memoryEntry = { getPassword: async () => secret, setPassword: async (v) => (secret = v) }
  const make = async (over = {}) => {
    const runner = new TestnetRunner({ owner, target, entry: memoryEntry, read, clientFor, policy, preferences, now: clock.now, sleep: async (ms) => void (clock.offset += ms), ...over })
    await runner.load()
    if (!model.slots.includes(runner.wallet.address.toLowerCase())) model.slots.push(runner.wallet.address.toLowerCase())
    return runner
  }
  return { model, clock, make, read }
}

test('the shutdown handler, called directly, cancels everything, clears the timer and resolves with exit 0', async () => {
  const v = venue()
  const runner = await v.make()
  await runner.start({ dedicated: true, minutes: 60, markets: [id] })
  assert.equal(v.model.orders.length, 2)
  let code = null
  let cleaned = false
  const app = createRunnerApp({
    runner,
    owner,
    target,
    device: 'test',
    exit: (c) => (code = c),
    guard: { markClean: () => (cleaned = true) },
    log: { log() {}, warn() {}, error() {} },
  })
  await app.shutdown('SIGTERM')
  assert.equal(code, 0)
  assert.equal(v.model.orders.length, 0)
  assert.ok(v.model.actions.includes('disarm'), 'the disconnect timer is cleared')
  assert.equal(runner.run, null)
  assert.ok(cleaned, 'a handled stop is a clean boot')
  // The saved run stays for a hosted restart to reconcile and resume.
  assert.equal(runner.journal.loadState('run').network, 'testnet')
})

test('resumeFromState cancels stale owned orders before any placement, then resumes', async () => {
  const v = venue()
  const journal = new RunJournal()
  const crashed = await v.make({ journal })
  await crashed.start({ dedicated: true, minutes: 60, markets: [id] })
  assert.equal(v.model.orders.length, 2, 'orders left resting by a process that died')
  v.model.actions.length = 0
  const restarted = await v.make({ journal })
  const result = await restarted.resumeFromState()
  assert.equal(result.resumed, true)
  const firstCancel = v.model.actions.indexOf('cancel')
  const firstOrder = v.model.actions.indexOf('order')
  assert.ok(firstCancel >= 0 && firstCancel < firstOrder, v.model.actions.join(','))
  assert.ok(restarted.run)
  assert.equal(v.model.orders.length, 2, 'quoting again after reconciling')
})

test('a mismatch after a restart leaves the runner selling nothing and bidding nothing, with holds and needs review', async () => {
  const v = venue()
  const journal = new RunJournal()
  const crashed = await v.make({ journal })
  await crashed.start({ dedicated: true, minutes: 60, markets: [id] })
  v.model.balances.push({ coin: '+7010', total: '40', hold: '0' }) // shares nobody recorded
  const restarted = await v.make({ journal })
  const result = await restarted.resumeFromState()
  assert.equal(result.resumed, false)
  assert.equal(restarted.run, null)
  assert.equal(v.model.orders.length, 0)
  assert.match(restarted.needsReview, /does not match/)
  assert.equal(restarted.holds[0].coin, '+7010')
  assert.match(restarted.holds[0].message, /Sell by hand/)
  const app = createRunnerApp({ runner: restarted, owner, target, device: 'test' })
  const h = await app.handle({ url: '/health', headers: { host: localHost } })
  const body = JSON.parse(h.body)
  assert.equal(body.ok, false)
  assert.equal(body.status, 'needs review')
})

test('the crash-loop guard switches to safe mode after three unclean boots in ten minutes; safe mode places no bids', async () => {
  const dir = tmp('boots')
  const t = Date.now()
  for (let i = 0; i < 3; i++) assert.equal(bootGuard(dir, t + i * 1000).safeMode, false)
  assert.equal(bootGuard(dir, t + 4000).safeMode, true)
  // Boots older than ten minutes no longer count, and a clean stop is not a crash.
  const later = bootGuard(dir, t + 11 * 60e3)
  assert.equal(later.safeMode, false)
  later.markClean()
  const clean = tmp('boots-clean')
  for (let i = 0; i < 4; i++) bootGuard(clean, t + i).markClean()
  assert.equal(bootGuard(clean, t + 10).safeMode, false)

  const v = venue()
  const runner = await v.make({ safeMode: true })
  await runner.start({ dedicated: true, minutes: 60, markets: [id] })
  assert.equal(runner.run.bidBlock.code, 'safe-mode')
  assert.equal(v.model.orders.length, 0)
  assert.throws(() => runner.resume(), /Safe mode/)
})

test('the agent key from the environment is read once, removed, and never appears in logs, /health or /status', async () => {
  const key = generatePrivateKey()
  const env = { MM_AGENT_KEY: key, OTHER: 'x' }
  const entry = envAgentEntry(env, { store: profileStore(tmp('profile')) })
  assert.equal(env.MM_AGENT_KEY, undefined)
  assert.equal(env.OTHER, 'x')
  assert.throws(() => envAgentEntry({ MM_AGENT_KEY: 'not-a-key' }), (e) => !e.message.includes('not-a-key'))
  const lines = []
  const capture = { log: (...a) => lines.push(a.join(' ')), warn: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')) }
  const original = { log: console.log, warn: console.warn, error: console.error }
  Object.assign(console, capture)
  try {
    const v = venue()
    const runner = await v.make({ entry })
    assert.equal(runner.wallet.address, privateKeyToAccount(key).address)
    await assert.rejects(runner.rotate(), /environment|Stop/)
    const app = createRunnerApp({ runner, owner, target, device: 'test', log: capture, exit: () => {} })
    const origin = allowedOrigins.local[0]
    const headers = { host: localHost, origin }
    const health = await app.handle({ url: '/health', headers })
    await app.handle({ url: '/pair', headers: { host: localHost } })
    const code = app.state.challenge.code
    const challenge = JSON.parse((await app.handle({ method: 'POST', url: '/challenge', headers, body: JSON.stringify({ code }) })).body)
    const signature = await ownerKey.signMessage({ message: challenge.message })
    const session = JSON.parse((await app.handle({ method: 'POST', url: '/pair', headers, body: JSON.stringify({ code, signature }) })).body)
    const status = await app.handle({ url: '/status', headers: { ...headers, authorization: 'Bearer ' + session.token } })
    assert.equal(status.status, 200)
    await runner.start({ dedicated: true, minutes: 60, markets: [id] })
    await app.shutdown('SIGTERM').catch(() => {})
    const hex = key.slice(2).toLowerCase()
    for (const text of [health.body, status.body, ...lines]) assert.equal(String(text).toLowerCase().includes(hex), false)
  } finally {
    Object.assign(console, original)
  }
})

test('a second lock on a live process is refused; a dead holder is taken over', () => {
  const dir = tmp('lock')
  const first = acquireLock(dir, { name: 'runner-a', pid: 111, host: 'h', alive: () => true })
  assert.throws(() => acquireLock(dir, { name: 'runner-a', pid: 222, host: 'h', alive: () => true }), /Another runner/)
  // Another host touched it within a minute (a shared volume): refused too.
  assert.throws(() => acquireLock(dir, { name: 'runner-a', pid: 333, host: 'other', alive: () => false }), /Another runner/)
  const taken = acquireLock(dir, { name: 'runner-a', pid: 222, host: 'h', alive: () => false })
  taken.release()
  first.release()
  // A restarted container often gets the same pid: that is this process, not a rival.
  acquireLock(dir, { name: 'runner-b', pid: 1, host: 'c' })
  acquireLock(dir, { name: 'runner-b', pid: 1, host: 'c' }).release()
})

test('the state dir comes from --state-dir, then MM_STATE_DIR, then the home folder', () => {
  assert.match(resolveStateDir({ argv: ['--state-dir', '/data/x'], env: { MM_STATE_DIR: '/y' } }), /x$/)
  assert.match(resolveStateDir({ argv: ['--state-dir=/data/z'], env: {} }), /z$/)
  assert.match(resolveStateDir({ argv: [], env: { MM_STATE_DIR: '/data' } }), /data$/)
  assert.match(resolveStateDir({ argv: [], env: {} }), /\.hip4-ag[\\/]mm$/)
})

test('headless pairing: no code to read, a signature from the owner wallet only, origins fixed in code, rate limited', async () => {
  const v = venue()
  const mainnetKey = generatePrivateKey()
  const runner = await v.make({
    entry: undefined,
    entries: { mainnet: envAgentEntry({ MM_AGENT_KEY: mainnetKey }) },
    journals: { mainnet: new RunJournal() },
    network: 'mainnet',
    networks: ['mainnet'],
  })
  const app = createRunnerApp({ runner, owner, target, device: 'hosted runner', headless: true })
  const page = await app.handle({ url: '/pair', headers: { host: 'x.up.railway.app' } })
  assert.equal(page.status, 200)
  assert.doesNotMatch(page.body.replace(owner, ''), /[0-9a-f]{24}/, 'no pairing code is shown')
  assert.equal(app.state.challenge, null)
  assert.equal(app.state.challenges.size, 0)
  const origin = 'https://hip4.ag'
  const bad = await app.handle({ method: 'POST', url: '/challenge', headers: { origin: 'https://evil.example' }, body: '{"code":"abcdefgh12"}' })
  assert.equal(bad.status, 403)
  assert.deepEqual([...allowedOrigins.headless], ['http://localhost:5004', 'https://hip4.ag'])
  const headers = { origin }
  const code = 'pagecode1234'
  const ch = JSON.parse((await app.handle({ method: 'POST', url: '/challenge', headers, body: JSON.stringify({ code }) })).body)
  assert.match(ch.message, /Code pagecode1234/)
  const stranger = privateKeyToAccount(generatePrivateKey())
  const wrong = await app.handle({ method: 'POST', url: '/pair', headers, body: JSON.stringify({ code, signature: await stranger.signMessage({ message: ch.message }) }) })
  assert.equal(wrong.status, 403)
  const good = await app.handle({ method: 'POST', url: '/pair', headers, body: JSON.stringify({ code, signature: await ownerKey.signMessage({ message: ch.message }) }) })
  assert.equal(good.status, 200)
  const auth = { ...headers, authorization: 'Bearer ' + JSON.parse(good.body).token }
  // Mainnet orders stay off: settings and status answer, start and arm say so plainly.
  const status = JSON.parse((await app.handle({ url: '/status', headers: auth })).body)
  assert.equal(status.network, 'mainnet')
  assert.equal(status.arming.verified, false)
  assert.match(status.arming.reason, /not enabled/)
  assert.equal((await app.handle({ url: '/preferences', headers: auth })).status, 200)
  for (const [url, body] of [['/start', { dedicated: true, minutes: 15, markets: 'auto', network: 'mainnet' }], ['/arm', { network: 'mainnet', record: {} }]]) {
    const r = await app.handle({ method: 'POST', url, headers: auth, body: JSON.stringify(body) })
    assert.equal(r.status, 400)
    assert.match(JSON.parse(r.body).error, /not enabled in this build/)
  }
  await assert.rejects(runner.start({ dedicated: true, network: 'testnet' }), /does not offer testnet/)
  // Rate limit: at most ten challenges a minute.
  let limited = false
  for (let i = 0; i < 12; i++) {
    const r = await app.handle({ method: 'POST', url: '/challenge', headers, body: JSON.stringify({ code: 'code' + i + 'abcdef' }) })
    if (r.status === 429) limited = true
  }
  assert.ok(limited)
  assert.equal(v.model.actions.length, 0, 'nothing was sent to the exchange')
})

test('the pairing message names the network: mainnet on a hosted runner, testnet on the local one', async () => {
  const v = venue()
  const hosted = await v.make({
    entry: undefined,
    entries: { mainnet: envAgentEntry({ MM_AGENT_KEY: generatePrivateKey() }) },
    journals: { mainnet: new RunJournal() },
    network: 'mainnet',
    networks: ['mainnet'],
  })
  const app = createRunnerApp({ runner: hosted, owner, target, device: 'hosted runner', headless: true })
  const code = 'pagecode1234'
  const ch = JSON.parse(
    (await app.handle({ method: 'POST', url: '/challenge', headers: { origin: 'https://hip4.ag' }, body: JSON.stringify({ code }) })).body
  )
  assert.equal(ch.message.split('\n')[0], 'Pair hip4.ag mainnet runner')
  assert.doesNotMatch(ch.message, /testnet/)

  const local = await v.make()
  const localApp = createRunnerApp({ runner: local, owner, target, device: 'test' })
  await localApp.handle({ url: '/pair', headers: { host: localHost } })
  assert.equal(localApp.state.challenge.message.split('\n')[0], 'Pair hip4.ag testnet runner')
})

test('mainnet setup is its own runner action and returns the new mainnet agent', async () => {
  const v = venue()
  let secret = null
  const runner = await v.make({
    entries: { mainnet: { getPassword: async () => secret, setPassword: async (s) => (secret = s) } },
    journals: { mainnet: new RunJournal() },
  })
  assert.equal(secret, null, 'no mainnet key on load')
  const app = createRunnerApp({ runner, owner, target, device: 'test' })
  const headers = { host: localHost, origin: allowedOrigins.local[0] }
  await app.handle({ url: '/pair', headers: { host: localHost } })
  const code = app.state.challenge.code
  const signature = await ownerKey.signMessage({ message: app.state.challenge.message })
  const session = JSON.parse((await app.handle({ method: 'POST', url: '/pair', headers, body: JSON.stringify({ code, signature }) })).body)
  const auth = { ...headers, authorization: 'Bearer ' + session.token }
  const r = await app.handle({ method: 'POST', url: '/mainnet/setup', headers: auth, body: '{}' })
  assert.equal(r.status, 200)
  const { mainnetAgent } = JSON.parse(r.body)
  assert.equal(mainnetAgent, runner.profiles.mainnet.wallet.address)
  assert.notEqual(mainnetAgent, runner.wallet.address)
  assert.ok(secret)
  assert.equal(v.model.actions.length, 0, 'nothing was sent to the exchange')
})

test('an unhandled rejection or uncaught exception runs the cancel-all path and exits 1; a signal exits 0', async () => {
  for (const event of ['unhandledRejection', 'uncaughtException', 'SIGTERM']) {
    const v = venue()
    const runner = await v.make()
    await runner.start({ dedicated: true, minutes: 60, markets: [id] })
    assert.equal(v.model.orders.length, 2)
    let done
    const exited = new Promise((resolve) => (done = resolve))
    let cleaned = false
    const errors = []
    const app = createRunnerApp({
      runner,
      owner,
      target,
      device: 'test',
      exit: (code) => done(code),
      guard: { markClean: () => (cleaned = true) },
      log: { log() {}, warn() {}, error: (m) => errors.push(m) },
    })
    const proc = new EventEmitter()
    installProcessHandlers(app, proc, ['SIGTERM'])
    proc.emit(event, Error('boom'))
    const code = await exited
    assert.equal(v.model.orders.length, 0, event + ': every runner order is cancelled')
    assert.ok(v.model.actions.includes('disarm'), event + ': the disconnect timer is cleared')
    assert.equal(runner.run, null)
    if (event === 'SIGTERM') {
      assert.equal(code, 0)
      assert.ok(cleaned)
    } else {
      assert.equal(code, 1)
      assert.equal(cleaned, false, 'a crash counts toward the crash-loop guard')
      assert.match(errors[0], /unexpected error: boom/)
    }
  }
})

test('a stop that cannot finish still exits once its deadline passes', async () => {
  const v = venue()
  const runner = await v.make()
  runner.serial = () => new Promise(() => {}) // a cancel that never returns
  const exits = []
  let fire = null
  const app = createRunnerApp({
    runner,
    owner,
    target,
    device: 'test',
    exit: (code) => exits.push(code),
    log: { log() {}, warn() {}, error() {} },
    setTimer: (fn, ms) => {
      assert.ok(ms > 0 && ms <= 25000)
      fire = fn
      return 1
    },
    clearTimer: () => {},
  })
  app.fatal(Error('stuck'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(exits, [])
  fire()
  assert.deepEqual(exits, [1])
})

test('process handlers are installed before the server is created or listens', () => {
  const source = readFileSync(new URL('./testnet-runner.mjs', import.meta.url), 'utf8')
  const main = source.slice(source.indexOf('export async function main'))
  const installed = main.indexOf('installProcessHandlers(app)')
  assert.ok(installed > 0)
  assert.ok(installed < main.indexOf('createServer('))
  assert.ok(installed < main.indexOf('server.listen('))
})

test('the hosting image runs as a non-root user on Node 24 and copies no env file or state', () => {
  const docker = readFileSync(new URL('./hosting/Dockerfile', import.meta.url), 'utf8')
  const lines = docker.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'))
  assert.match(lines.find((l) => l.startsWith('FROM')), /^FROM node:24(-|$)/)
  const user = lines.filter((l) => l.startsWith('USER'))
  assert.deepEqual(user, ['USER node'])
  assert.ok(lines.indexOf('USER node') < lines.findIndex((l) => l.startsWith('CMD')))
  const copies = lines.filter((l) => /^(COPY|ADD)\b/.test(l))
  assert.deepEqual(copies, ['COPY lib/mm ./lib/mm', 'COPY scripts/mm ./scripts/mm'])
  const ignore = readFileSync(new URL('../../.dockerignore', import.meta.url), 'utf8').split('\n').map((l) => l.trim())
  for (const rule of ['node_modules', '.next', '.git', 'worktrees', '.env*', '**/.env*', '*.sqlite', '**/*.sqlite', '.hip4-ag'])
    assert.ok(ignore.includes(rule), rule)
})
