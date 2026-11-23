// Exchange action accounting. This is the backstop that turns any fill-driven or bug-driven order loop into a stop:
// every exchange action is counted before it is sent, and nothing goes out once an hour's allowance is used.
//
// Part of the allowance is reserved up front for exits, cancels and the disconnect timer. New bids (entries) may only
// use the rest, so a bid loop can never take the actions an exit needs. The budget lives on the runner, not on a run,
// and can be saved with timestamps so a restart inside the hour carries on where it stopped.
import { readFileSync, writeFileSync, renameSync } from 'node:fs'

const hourMs = 3600e3
const dayMs = 86400e3

export const budgetReached = 'Exchange action budget reached'

const validEvent = (e) => Number.isSafeInteger(e?.at) && Number.isSafeInteger(e?.n) && e.n > 0

/**
 * perHour is the allowance for the trailing hour; setPerHour changes it (the runner sizes it per active market).
 * reserve is the share of the allowance only exits, cancels and the disconnect timer may use (0 to 0.9).
 * events: earlier spends [{ at, n }] to carry over, for example from a saved file. onSpend(events) runs after every
 * recorded spend. Costs: `order` n (one per order in the batch), `cancel` n, `scheduleCancel` 1. spend throws before
 * recording when the action would go over the allowance, so the caller never sends it. A bid spend
 * ({ priority: 'bid' }, or the older { entry: true }) is also refused once it would reach into the reserve; an exit
 * spend ({ priority: 'exit' }, the default) and cancels may use it.
 * reserveActions is the reserve as a count of actions (policy.requests.exitActionReserve); the larger of it and the
 * share given by `reserve` applies.
 */
export function createActionBudget({
  perHour,
  now = Date.now(),
  reserve = 0,
  reserveActions = 0,
  events: carried = [],
  onSpend,
} = {}) {
  const checkLimit = (n) => {
    if (!(Number.isSafeInteger(n) && n > 0)) throw Error('A positive hourly action budget is required.')
    return n
  }
  let limit = checkLimit(perHour)
  if (!(Number.isFinite(reserve) && reserve >= 0 && reserve <= 0.9)) throw Error('The exit reserve must be 0 to 0.9.')
  const events = (Array.isArray(carried) ? carried : [])
    .filter(validEvent)
    // A saved time in the future (clock change) counts as now, which keeps it in the window longer, never shorter.
    .map((e) => ({ at: Math.min(e.at, now), n: e.n }))
    .sort((a, b) => a.at - b.at)
  const startedAt = events.length ? Math.min(now, events[0].at) : now
  let total = 0
  const prune = (t) => {
    while (events.length && events[0].at <= t - hourMs) events.shift()
  }
  const lastHour = (t) => {
    prune(t)
    return events.reduce((sum, e) => sum + e.n, 0)
  }
  if (!(Number.isSafeInteger(reserveActions) && reserveActions >= 0))
    throw Error('The exit reserve count must be a whole number.')
  const reserved = () => Math.min(limit, Math.max(Math.ceil(limit * reserve), reserveActions))
  const entryLimit = () => limit - reserved()
  const cost = (kind, n) => {
    if (kind === 'scheduleCancel') return 1
    if (kind !== 'order' && kind !== 'cancel') throw Error('Unknown exchange action: ' + kind)
    if (!(Number.isSafeInteger(n) && n >= 0)) throw Error('Invalid action count.')
    return n
  }
  function snapshot(t = Date.now()) {
    const used = lastHour(t)
    const window = Math.min(hourMs, Math.max(60e3, t - startedAt))
    return {
      actionsLastHour: used,
      perHour: limit,
      reserved: reserved(),
      left: Math.max(0, limit - used),
      entriesLeft: Math.max(0, entryLimit() - used),
      total,
      projectedPerDay: Math.round((used * dayMs) / window),
    }
  }
  // priority 'bid' is the same as the older { entry: true }. Anything but 'bid' or 'exit' is a bug in the caller.
  const isBid = ({ entry = false, priority } = {}) => {
    if (priority !== undefined && priority !== 'bid' && priority !== 'exit')
      throw Error('Unknown action priority: ' + priority)
    return priority === 'bid' || (priority === undefined && entry === true)
  }
  /** True when `n` actions of this kind fit right now. */
  function can(kind, n = 1, t = Date.now(), options = {}) {
    const c = cost(kind, n)
    return lastHour(t) + c <= (isBid(options) ? entryLimit() : limit)
  }
  function spend(kind, n = 1, t = Date.now(), options = {}) {
    const c = cost(kind, n)
    const bid = isBid(options)
    if (c === 0) return snapshot(t)
    if (lastHour(t) + c > (bid ? entryLimit() : limit)) throw Error(budgetReached)
    events.push({ at: t, n: c })
    total += c
    onSpend?.(events.map((e) => ({ ...e })))
    return snapshot(t)
  }
  function setPerHour(n) {
    limit = checkLimit(n)
  }
  return { spend, can, snapshot, setPerHour, events: () => events.map((e) => ({ ...e })) }
}

/**
 * Hourly allowance for the markets in play: perMarket for each, at least one, never above the hard ceiling.
 * Also returns how many markets the ceiling can carry.
 */
export function actionAllowance({ ceiling, perMarket, markets }) {
  const per = Math.max(1, Math.floor(perMarket))
  return {
    perHour: Math.max(1, Math.min(ceiling, per * Math.max(1, markets))),
    maxMarkets: Math.max(1, Math.floor(ceiling / per)),
  }
}

/** Keeps spends for this process only. */
export function memoryActionStore() {
  let saved = []
  return {
    load: () => saved.map((e) => ({ ...e })),
    save: (events) => {
      saved = events.map((e) => ({ ...e }))
    },
  }
}

/**
 * Keeps the last hour of spends in a small JSON file: { savedAt, events: [[at, n], ...] }. load returns [] when the
 * file does not exist and null when it exists but cannot be trusted, so the caller can fail closed.
 */
export function fileActionStore(file) {
  return {
    load(now = Date.now()) {
      let text
      try {
        text = readFileSync(file, 'utf8')
      } catch (e) {
        if (e?.code === 'ENOENT') return []
        return null
      }
      try {
        const data = JSON.parse(text)
        if (!data || !Number.isSafeInteger(data.savedAt) || !Array.isArray(data.events)) return null
        const events = data.events.map(([at, n]) => ({ at, n }))
        if (!events.every(validEvent)) return null
        return events.filter((e) => e.at > now - hourMs)
      } catch {
        return null
      }
    },
    save(events, now = Date.now()) {
      const body = JSON.stringify({ savedAt: now, events: events.map((e) => [e.at, e.n]) })
      // Write then rename, so a crash mid-write never leaves a half file that would read as untrusted.
      writeFileSync(file + '.tmp', body, { mode: 0o600 })
      renameSync(file + '.tmp', file)
    },
  }
}

/**
 * The per-address allowance from an info `userRateLimit` answer: { used, cap, left }. cap is nRequestsCap and left is
 * what remains of it (never negative; the surplus is not counted). Null when the answer is not usable, so the caller
 * can treat the headroom as unknown rather than as plenty.
 */
export function addressHeadroom(response) {
  if (response?.nRequestsUsed == null || response?.nRequestsCap == null) return null
  const used = Number(response.nRequestsUsed)
  const cap = Number(response.nRequestsCap)
  if (!(Number.isFinite(used) && Number.isFinite(cap) && used >= 0 && cap >= 0)) return null
  return { used, cap, left: Math.max(0, cap - used) }
}

/** The hard ceiling on one cancel action. */
export const cancelBatchMax = 200

/** Splits cancel rows into batches of at most `max` (never above 200), in order. An empty list gives no batches. */
export function cancelBatches(rows, max = cancelBatchMax) {
  if (!Array.isArray(rows)) throw Error('Cancel rows must be a list.')
  if (!(Number.isSafeInteger(max) && max >= 1)) throw Error('A batch size of at least 1 is required.')
  const size = Math.min(max, cancelBatchMax)
  const batches = []
  for (let i = 0; i < rows.length; i += size) batches.push(rows.slice(i, i + size))
  return batches
}

const defaultBackoffMs = [7e3, 14e3, 28e3, 60e3]
const maxRetryAfterMs = 5 * 60e3

/**
 * The next pause after a rate limit. state is null for the first one, or the state this returned last time; pass null
 * again after a clean tick. The delay steps up through policy.requests.backoffMs and then stays at the last step, so a
 * 429 never ends the run. A server Retry-After longer than the step is honoured, up to five minutes.
 * Returns { until, state: { step, until } }.
 */
export function nextBackoff(state, { now = Date.now(), retryAfterMs, policy } = {}) {
  const steps = policy?.requests?.backoffMs
  const ladder =
    Array.isArray(steps) && steps.length && steps.every((ms) => Number.isFinite(ms) && ms > 0) ? steps : defaultBackoffMs
  const step = Number.isSafeInteger(state?.step) && state.step >= 0 ? state.step : 0
  const wait = Math.max(
    ladder[Math.min(step, ladder.length - 1)],
    Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? Math.min(retryAfterMs, maxRetryAfterMs) : 0
  )
  const until = now + wait
  return { until, state: { step: step + 1, until } }
}
