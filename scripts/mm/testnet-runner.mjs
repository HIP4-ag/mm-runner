// The runner server. Two ways to run it:
//
//   Developer, on this computer (testnet by default):
//     node scripts/mm/testnet-runner.mjs <owner address> [subaccount address] [--state-dir <dir>]
//     Binds 127.0.0.1:5315, keeps the agent key in the OS keyring, pairs with a one-time code from /pair.
//
//   Hosted, on the user's own Railway service (mainnet only):
//     node scripts/mm/testnet-runner.mjs --headless
//     Binds 0.0.0.0:$PORT. Reads MM_OWNER (main address), optional MM_TARGET (subaccount), MM_AGENT_KEY (the agent
//     key, read once and removed from the environment) and MM_STATE_DIR (the volume). Accepts requests only from the
//     origins in the allowlist below, and pairs only with a signature from the MM_OWNER wallet.
//
// Mainnet orders stay off in this build (lib/mm/network.mjs). A hosted runner still starts, pairs, shows settings,
// preview and status, and answers start and arm with a plain "not enabled" message.
// Nothing here logs a key or an environment value.
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { accessSync, constants as fsConstants, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { verifyMessage } from 'viem'
import { RunJournal } from './run-journal.mjs'
import { addressOf } from '../../lib/mm/testnet.mjs'
import { TestnetRunner, tickDelayMs, shutdownSignals } from './testnet-engine.mjs'
import { loadOperatorConfig, operatorFileIn } from './local-config.mjs'
import { loadPolicy } from './policy/index.mjs'
import { fileActionStore } from './request-budget.mjs'
import { loadPreferences, preferencesFileIn, savePreferences } from './preferences.mjs'
import { consumeAlertEnv, createAlertNotifier } from './alerts.mjs'
import {
  acquireLock,
  armingFileStore,
  bootGuard,
  envAgentEntry,
  profileStore,
  resolveStateDir,
} from './state-dir.mjs'

/** The only page origins a runner answers. Fixed in code: no variable can add one. */
export const allowedOrigins = Object.freeze({
  local: Object.freeze(['http://127.0.0.1:5004', 'http://localhost:5004']),
  headless: Object.freeze(['http://localhost:5004', 'https://hip4.ag']),
})
export const localHost = '127.0.0.1:5315'
const challengeMs = 120000
const sessionMs = 12 * 3600000
// Pairing limits on a public address: challenges and pair attempts per minute, and outstanding challenges.
const challengesPerMinute = 10
const pairsPerMinute = 10
const maxPendingChallenges = 5
const clientCode = /^[A-Za-z0-9_-]{8,64}$/

function window(limit, ms, now) {
  const hits = []
  return () => {
    const t = now()
    while (hits.length && hits[0] <= t - ms) hits.shift()
    if (hits.length >= limit) return false
    hits.push(t)
    return true
  }
}

/**
 * The request handler and the stop routine, without a socket, so tests can drive them directly.
 * handle({ method, url, headers, body }) resolves to { status, headers, body }.
 */
export function createRunnerApp({
  runner,
  owner,
  target,
  device,
  headless = false,
  host = localHost,
  journal = () => runner.journal,
  policy = runner.policy,
  now = Date.now,
  random = () => randomBytes(24).toString('hex'),
  verify = verifyMessage,
  log = console,
  exit = (code) => process.exit(code),
  onStop = () => {},
  guard = null,
  lock = null,
  stopTimeoutMs = 25000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  const origins = new Set(headless ? allowedOrigins.headless : allowedOrigins.local)
  const state = { lastCycleAt: now(), session: null, challenge: null, challenges: new Map() }
  const allowChallenge = window(challengesPerMinute, 60e3, now)
  const allowPair = window(pairsPerMinute, 60e3, now)
  const base = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
  const json = (status, data, extra = {}) => ({
    status,
    headers: { ...base, 'Content-Type': 'application/json', ...extra },
    body: JSON.stringify(data),
  })
  const text = (status, body) => ({
    status,
    headers: {
      ...base,
      'Content-Type': 'text/plain; charset=utf-8',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    },
    body,
  })
  // The first line names the network this runner trades, so a mainnet pairing never reads as a testnet one.
  const message = (code, expires) =>
    [
      'Pair hip4.ag ' + (runner.network === 'mainnet' ? 'mainnet' : 'testnet') + ' runner',
      device,
      'Owner ' + owner,
      'Trading account ' + target,
      'Agent ' + runner.wallet.address,
      'Code ' + code,
      'Expires ' + new Date(expires).toISOString(),
    ].join('\n')
  const intervalMs = () => tickDelayMs(runner.last?.markets?.length || 1, 0)

  function health() {
    const body = runner.wallet ? runner.health() : { ok: false, running: false }
    const stalled = now() - state.lastCycleAt > 3 * intervalMs()
    return {
      status: stalled ? 503 : 200,
      body: { ...body, safeMode: !!body.safeMode, status: stalled ? 'stalled' : body.needsReview ? 'needs review' : 'ok' },
    }
  }

  async function handle({ method = 'GET', url = '/', headers = {}, body = '' } = {}) {
    if (!headless && headers.host !== host) return json(403, { error: 'Invalid runner host.' })
    const origin = headers.origin
    const allowed = typeof origin === 'string' && origins.has(origin)
    const cors = allowed ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}
    if (method === 'GET' && url === '/health') {
      const h = health()
      return json(h.status, h.body, cors)
    }
    if (!runner.wallet) return json(503, { error: 'Opening the runner credential store.' }, cors)
    if (url === '/pair' && method === 'GET' && !origin) {
      if (headless)
        return text(
          200,
          'This hosted runner pairs only with a signature from its owner wallet ' +
            owner +
            '.\nThere is no code to read here. On the hip4.ag page, type a code of your own (8 to 64 letters or digits),\nthen sign the pairing message with that wallet.\n'
        )
      const code = random()
      const expires = now() + challengeMs
      state.challenge = { code, expires, message: message(code, expires) }
      return text(200, 'One-time pairing code · expires in two minutes\n\n' + code)
    }
    if (!allowed)
      return json(403, { error: headless ? 'This runner answers the hip4.ag page only.' : 'Use the local dashboard on port 5004.' })
    if (method === 'OPTIONS')
      return {
        status: 204,
        headers: { ...base, ...cors, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Authorization, Content-Type' },
        body: '',
      }
    const reply = (status, data) => json(status, data, cors)
    try {
      const data = method === 'POST' ? parse(body) : {}
      if (method === 'POST' && url === '/challenge') {
        if (!allowChallenge()) return reply(429, { error: 'Too many pairing requests. Wait a minute.' })
        if (headless) {
          // The code is the page's own nonce, not a secret: the owner wallet's signature is what pairs.
          if (!clientCode.test(String(data.code ?? ''))) return reply(400, { error: 'Type a code of 8 to 64 letters or digits.' })
          const expires = now() + challengeMs
          for (const [c, ch] of state.challenges) if (ch.expires < now()) state.challenges.delete(c)
          while (state.challenges.size >= maxPendingChallenges) state.challenges.delete(state.challenges.keys().next().value)
          state.challenges.set(data.code, { code: data.code, expires, message: message(data.code, expires) })
        }
        const pending = headless ? state.challenges.get(data.code) : state.challenge
        if (!pending || pending.code !== data.code || pending.expires < now())
          return reply(403, { error: 'Get a fresh pairing code.' })
        return reply(200, { message: pending.message, owner, target, agent: runner.wallet.address, device })
      }
      if (method === 'POST' && url === '/pair') {
        if (!allowPair()) return reply(429, { error: 'Too many pairing attempts. Wait a minute.' })
        const pending = headless ? state.challenges.get(data.code) : state.challenge
        if (!pending || pending.code !== data.code || pending.expires < now())
          return reply(403, { error: 'Get a fresh pairing code.' })
        let ok = false
        try {
          ok = await verify({ address: owner, message: pending.message, signature: data.signature })
        } catch {
          ok = false
        }
        if (!ok || pending.expires < now()) return reply(403, { error: 'Owner signature required.' })
        if (headless) state.challenges.delete(data.code)
        else state.challenge = null
        state.session = { token: random(), expires: now() + sessionMs }
        return reply(200, state.session)
      }
      const session = state.session
      if (!session || session.expires < now() || headers.authorization !== 'Bearer ' + session.token)
        return reply(401, { error: 'Pair the owner wallet with this runner.' })
      if (method === 'GET' && url === '/status')
        return reply(200, { ...(await runner.status()), device, headless })
      const history = /^\/runs(?:\?before=([1-9]\d{0,14}))?$/.exec(url)
      if (method === 'GET' && history) return reply(200, journal().list(history[1] ? Number(history[1]) : undefined))
      const receipt = /^\/runs\/([1-9]\d{0,14})(\/refresh)?$/.exec(url)
      if (receipt && method === 'GET' && !receipt[2]) return reply(200, journal().receipt(Number(receipt[1])))
      if (receipt && method === 'POST' && receipt[2]) {
        if (runner.run) throw Error('Refresh fills after quoting stops.')
        return reply(200, await journal().refresh(Number(receipt[1]), target, runner.read.info))
      }
      const preview = /^\/preview(?:\?markets=(\d{1,15}(?:,\d{1,15}){0,11}))?$/.exec(url)
      if (method === 'GET' && preview)
        return reply(200, await runner.preview(preview[1] ? preview[1].split(',').map(Number) : 'auto'))
      if (url === '/preferences' && method === 'GET') return reply(200, runner.preferencesView())
      if (url === '/preferences' && method === 'POST') {
        if (runner.run) return reply(409, { error: 'Stop the current run before changing settings.' })
        return reply(200, await runner.serial(() => runner.savePreferencesFrom(data)))
      }
      if (method !== 'POST') return reply(404, { error: 'Unknown runner action.' })
      const result = await runner.serial(async () => {
        if (url === '/issue') return runner.issue()
        if (url === '/rotate') return runner.rotate()
        if (url === '/stop') return runner.cancel()
        if (url === '/stop-all') return runner.stopAll()
        if (url === '/kill') return runner.kill()
        if (url === '/resume') return runner.resume()
        if (url === '/start') return runner.start(data)
        if (url === '/arm') return runner.arm(data.record)
        if (url === '/disarm') return runner.disarm()
        if (url === '/mainnet/setup') return runner.prepareMainnet()
        throw Object.assign(Error('Unknown runner action.'), { status: 404 })
      })
      if (url === '/arm' || url === '/disarm' || url === '/mainnet/setup') return reply(200, result)
      return reply(200, { ok: true })
    } catch (e) {
      return reply(e.status === 409 ? 409 : e.status === 404 ? 404 : 400, { error: e.message })
    }
  }

  let stopping = null
  // One stop routine for a signal and for a crash: cancel every owned order, verify, clear the disconnect timer, exit.
  // A signal is a clean stop (exit 0, not counted by the crash-loop guard); a crash exits 1 and counts.
  // If the cancel cannot finish in time the process still exits; the disconnect timer cancels what is left.
  function stop(reason, { code, clean }) {
    stopping ??= (async () => {
      const deadline = setTimer(() => exit(code), stopTimeoutMs)
      deadline?.unref?.()
      try {
        onStop()
      } catch {}
      try {
        if (runner.wallet) await runner.serial(() => runner.shutdown(reason))
      } catch (e) {
        log.error('Check remaining orders on the exchange: ' + e.message)
      }
      try {
        runner.closeFeeds()
      } catch {}
      if (clean) guard?.markClean()
      lock?.release()
      clearTimer(deadline)
      exit(code)
    })()
    return stopping
  }
  /** A handled stop (signal): cancel every owned order, verify, clear the disconnect timer, exit 0. */
  const shutdown = (sig) => stop('Stopped by ' + sig, { code: 0, clean: true })
  /** An uncaught exception or unhandled rejection: the same cancel path, then exit 1. */
  const fatal = (e) => {
    log.error('Stopping after an unexpected error: ' + (e?.message ?? String(e)))
    return stop('Stopped after an unexpected error', { code: 1, clean: false })
  }
  return { handle, shutdown, fatal, health, state }
}

/**
 * Process handlers, installed before the server listens. In a container Node is process 1: the kernel gives it no
 * default action for SIGTERM and there is no init, so without these a stop signal would be ignored until the platform
 * kills the process. The runner starts no child processes, so there is nothing to reap.
 */
export function installProcessHandlers(app, proc = process, signals = shutdownSignals) {
  for (const sig of signals)
    try {
      proc.on(sig, () => app.shutdown(sig))
    } catch {
      // A signal this platform does not have (SIGBREAK outside Windows) is skipped.
    }
  proc.on('uncaughtException', (e) => app.fatal(e))
  proc.on('unhandledRejection', (e) => app.fatal(e))
}

function parse(text) {
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw Error('The request body is not valid JSON.')
  }
}

async function readBody(req) {
  let text = ''
  for await (const chunk of req) {
    if (text.length + chunk.length > 4096) throw Error('Request too large.')
    text += chunk
  }
  return text
}

/** Positional arguments, with --state-dir and its value and every other flag left out. */
const positionals = (argv) => {
  const out = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--state-dir') i++
    else if (!String(argv[i]).startsWith('--')) out.push(argv[i])
  }
  return out
}

export async function main(argv = process.argv.slice(2), env = process.env, log = console) {
  const headless = argv.includes('--headless')
  const stateDir = resolveStateDir({ argv, env })
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  try {
    accessSync(stateDir, fsConstants.W_OK)
  } catch {
    // The container runs as a non-root user; a volume it cannot write is a setup problem, said plainly.
    log.error('The state folder ' + stateDir + ' is not writable by the runner. Check the volume permissions.')
    process.exitCode = 1
    return null
  }
  let owner, target
  try {
    const args = positionals(argv)
    owner = addressOf(String(headless ? (env.MM_OWNER ?? '') : (args[0] ?? '')).trim())
    target = addressOf(String(headless ? env.MM_TARGET || owner : args[1] || owner).trim())
  } catch {
    log.error(
      headless
        ? 'Set MM_OWNER to your main wallet address (and MM_TARGET to a subaccount, if you use one).'
        : 'Usage: npm run mm:testnet -- <owner address> [subaccount address] [--state-dir <dir>]'
    )
    process.exitCode = 1
    return null
  }
  const network = headless ? 'mainnet' : 'testnet'
  const netDir = join(stateDir, network)
  mkdirSync(netDir, { recursive: true, mode: 0o700 })
  const lock = acquireLock(stateDir, { name: 'runner-' + owner + '-' + target })
  const guard = bootGuard(stateDir)
  if (guard.safeMode) log.warn('Safe mode: the runner restarted several times in ten minutes. Only selling runs.')
  let entries
  if (headless) {
    let entry
    try {
      entry = envAgentEntry(env, { name: 'MM_AGENT_KEY', store: profileStore(netDir) })
    } catch (e) {
      log.error(e.message)
    }
    if (!entry) {
      log.error('Set MM_AGENT_KEY to the agent key you approved on the hip4.ag page.')
      lock.release()
      process.exitCode = 1
      return null
    }
    entries = { mainnet: entry }
  } else {
    // The keyring is loaded only for the developer runner; a hosted runner never has one.
    const { AsyncEntry } = await import('@napi-rs/keyring')
    entries = {
      testnet: new AsyncEntry('hip4.ag-mm-testnet', owner + '-' + target),
      mainnet: new AsyncEntry('hip4.ag-mm-mainnet', owner + '-' + target),
    }
  }
  const journalIn = (net) => {
    const dir = join(stateDir, net)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    return new RunJournal(join(dir, owner + '-' + target + '.sqlite'))
  }
  const journals = headless ? { mainnet: journalIn('mainnet') } : { testnet: journalIn('testnet'), mainnet: journalIn('mainnet') }
  // Refuses to start on an invalid policy or operator config rather than quoting with the wrong rules or fee.
  const policy = loadPolicy()
  const { feeWaived } = loadOperatorConfig({ env, file: operatorFileIn(stateDir), allowEnv: !headless })
  const alertConfig = headless ? consumeAlertEnv(env) : consumeAlertEnv({ ...env })
  const alerts = createAlertNotifier({ config: alertConfig, network })
  const prefsFile = preferencesFileIn(stateDir)
  const device = headless ? 'hosted runner' : hostname()
  const runner = new TestnetRunner({
    owner,
    target,
    entries,
    journals,
    feeWaived,
    policy,
    network,
    networks: headless ? ['mainnet'] : ['testnet', 'mainnet'],
    preferences: {
      load: () => loadPreferences(prefsFile, policy),
      save: (prefs) => savePreferences(prefsFile, prefs, policy),
    },
    // The hour's exchange actions survive a restart, so stopping and starting never resets the budget.
    actionStore: fileActionStore(join(netDir, owner + '-' + target + '.actions.json')),
    armingStore: armingFileStore(join(stateDir, 'mainnet')),
    device,
    safeMode: guard.safeMode,
    log: (event) => log.log('feed ' + JSON.stringify(event)),
  })
  let timer = null
  let server = null
  const app = createRunnerApp({
    runner,
    owner,
    target,
    device,
    headless,
    log,
    guard,
    lock,
    onStop: () => {
      clearTimeout(timer)
      server?.close()
    },
  })
  // Ctrl+C, a kill, a hang-up and, on Windows, closing the console window (SIGHUP, with about 10 s to finish) or
  // Ctrl+Break all cancel this runner's orders before the process exits 0. A crash runs the same cancel and exits 1.
  // The disconnect timer covers a hard kill. Installed before the server listens, so no signal arrives unhandled.
  installProcessHandlers(app)
  server = createServer(async (req, res) => {
    let body = ''
    try {
      body = req.method === 'POST' ? await readBody(req) : ''
    } catch (e) {
      res.writeHead(413, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: e.message }))
    }
    const out = await app.handle({ method: req.method, url: req.url, headers: req.headers, body })
    res.writeHead(out.status, out.headers)
    res.end(out.body)
  })
  const port = headless ? Number(env.PORT) || 5315 : 5315
  const bind = headless ? '0.0.0.0' : '127.0.0.1'
  // Bind first: a second process must never use this signer's nonce stream.
  server.listen(port, bind, async () => {
    try {
      await runner.load()
    } catch (e) {
      log.error('Could not open the runner credential store: ' + e.message)
      server.close()
      lock.release()
      process.exitCode = 1
      return
    }
    log.log((headless ? 'Hosted runner' : 'Testnet runner') + ' ready on ' + bind + ':' + port + ' · ' + device + ' · agent ' + runner.wallet.address)
    if (headless) {
      if (guard.safeMode) {
        alerts.notify('safe-mode', 'safe-mode', '[hip4.ag MM] Runner started in safe mode after repeated restarts. New bids are paused; selling continues. https://hip4.ag/mm')
      }
      try {
        const r = await runner.serial(() => runner.resumeFromState())
        log.log(r.resumed ? 'Resumed the saved run after reconciling.' : 'Not resumed: ' + r.reason)
      } catch (e) {
        runner.needsReview = 'The restart check failed: ' + e.message
        log.error(runner.needsReview)
        alerts.inspect({ holds: runner.last?.holds, bidBlock: runner.last?.bidBlock, needsReview: runner.needsReview })
      }
    }
    async function cycle() {
      app.state.lastCycleAt = Date.now()
      lock.touch()
      try {
        if (runner.run) {
          await runner.serial(() => runner.tick())
          alerts.inspect({ holds: runner.last?.holds, bidBlock: runner.last?.bidBlock, needsReview: runner.needsReview })
        }
      } catch (e) {
        log.warn('Quotes paused: ' + e.message)
      }
      timer = setTimeout(cycle, delay())
    }
    // Scales with the markets in play: (22 + 4N) info weight per tick at 600 a minute, never under 7 s, jittered.
    const delay = () => tickDelayMs(runner.last?.markets?.length || 1, policy.requests.jitter)
    timer = setTimeout(cycle, delay())
  })
  return { app, runner, server }
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invoked) main()
