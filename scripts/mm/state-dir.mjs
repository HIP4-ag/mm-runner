// Where the runner keeps its state, and the guards around it: one process per state dir and account, a crash-loop
// guard, and the agent key read from the environment exactly once. Nothing here logs a key or an env value.
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

const crashWindowMs = 10 * 60e3
const crashLimit = 3
const lockFreshMs = 60e3
const keyPattern = /^0x[0-9a-fA-F]{64}$/

/** The state dir: --state-dir <dir> (or --state-dir=<dir>), else MM_STATE_DIR, else ~/.hip4-ag/mm. Absolute. */
export function resolveStateDir({ argv = process.argv, env = process.env } = {}) {
  let dir = null
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i])
    if (arg === '--state-dir' && argv[i + 1]) dir = String(argv[i + 1])
    else if (arg.startsWith('--state-dir=')) dir = arg.slice('--state-dir='.length)
  }
  dir ??= typeof env?.MM_STATE_DIR === 'string' && env.MM_STATE_DIR.trim() ? env.MM_STATE_DIR.trim() : null
  dir ??= join(homedir(), '.hip4-ag', 'mm')
  return isAbsolute(dir) ? dir : resolve(dir)
}

const writeAtomic = (file, text) => {
  const temp = file + '.' + process.pid + '.tmp'
  writeFileSync(temp, text, { mode: 0o600 })
  renameSync(temp, file)
}
const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** True while a process with this pid runs on this machine. */
export function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e?.code === 'EPERM'
  }
}

/**
 * Take the lock for one account in a state dir: <dir>/<name>.lock holding { pid, host, agent, at }.
 * Refused while a live process holds it: the same host with a live pid other than ours, or another host whose lock
 * was touched within a minute (a shared volume). A dead holder's lock is taken over. Returns { file, touch, release }.
 */
export function acquireLock(dir, { agent = '', name = 'runner', pid = process.pid, host = hostname(), now = Date.now, alive = pidAlive } = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, name + '.lock')
  const mine = () => JSON.stringify({ pid, host, agent: String(agent), at: now() })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx', 0o600)
      writeSync(fd, mine())
      closeSync(fd)
      break
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e
      const held = readJson(file)
      const sameHost = held?.host === host
      const live = sameHost
        ? held.pid !== pid && alive(held.pid)
        : Number.isFinite(held?.at) && now() - held.at < lockFreshMs
      if (live) throw Error('Another runner process already uses this state folder and account. Stop it first.')
      // A dead or stale holder: take it over.
      try {
        unlinkSync(file)
      } catch {}
      if (attempt) throw Error('The runner lock could not be taken.')
    }
  }
  return {
    file,
    touch() {
      try {
        writeAtomic(file, mine())
      } catch {}
    },
    release() {
      try {
        if (readJson(file)?.pid === pid) unlinkSync(file)
      } catch {}
    },
  }
}

/**
 * The crash-loop guard. Every boot is recorded as unclean until markClean() is called on a handled stop. When at least
 * three earlier boots inside the last ten minutes ended unclean, this boot runs in safe mode: no new bids, only the
 * selling of shares already held, until a clean restart. Returns { safeMode, unclean, markClean }.
 */
export function bootGuard(dir, now = Date.now()) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, 'boots.json')
  const saved = readJson(file)
  const boots = (Array.isArray(saved?.boots) ? saved.boots : []).filter(
    (b) => Number.isFinite(b?.at) && b.at > now - crashWindowMs && b.at <= now
  )
  const unclean = boots.filter((b) => b.clean !== true).length
  const self = { at: now, clean: false }
  writeAtomic(file, JSON.stringify({ boots: [...boots, self] }))
  return {
    safeMode: unclean >= crashLimit,
    unclean,
    markClean() {
      const current = readJson(file)
      const list = Array.isArray(current?.boots) ? current.boots : []
      for (const b of list) if (b.at === self.at && b.clean === false) b.clean = true
      try {
        writeAtomic(file, JSON.stringify({ boots: list }))
      } catch {}
    },
  }
}

/**
 * Non-secret profile fields of an env-held agent (issued, expires, deadline) in <dir>/profile.json. The key itself is
 * never written here.
 */
export function profileStore(dir) {
  const file = join(dir, 'profile.json')
  const pick = (p) => ({
    issued: p?.issued === true,
    expires: Number.isFinite(p?.expires) ? p.expires : 0,
    deadline: Number.isFinite(p?.deadline) ? p.deadline : 0,
  })
  return {
    load: () => pick(readJson(file)),
    save(fields) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeAtomic(file, JSON.stringify(pick(fields)))
    },
  }
}

/**
 * The agent key from the environment (MM_AGENT_KEY by default), read once and deleted from the environment so no
 * child process or later read can see it. Returns an entry with getPassword and setPassword like a keyring entry, or
 * null when the variable is not set. A malformed key throws without repeating it.
 */
export function envAgentEntry(env = process.env, { name = 'MM_AGENT_KEY', store } = {}) {
  const raw = env[name]
  delete env[name]
  if (raw === undefined || raw === '') return null
  const key = String(raw).trim()
  if (!keyPattern.test(key)) throw Error(name + ' must be a 0x-prefixed 64 character hex private key.')
  const fields = store ?? { load: () => ({ issued: false, expires: 0, deadline: 0 }), save: () => {} }
  return {
    fromEnv: true,
    async getPassword() {
      return JSON.stringify({ ...fields.load(), key })
    },
    async setPassword(json) {
      const next = JSON.parse(json)
      if (next?.key !== key)
        throw Error('This runner uses the agent key from its environment. Change the key there, not here.')
      fields.save(next)
    },
  }
}

/** A small JSON file store for the mainnet arming record (<dir>/arming.json). The record is checked on every load. */
export function armingFileStore(dir) {
  const file = join(dir, 'arming.json')
  return {
    load: () => readJson(file),
    save(record) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeAtomic(file, JSON.stringify(record))
    },
    clear() {
      try {
        unlinkSync(file)
      } catch {}
    },
  }
}
