// Reward rollover. At 00:00 UTC (and whenever a campaign window turns over) the feed can show a market's window as
// ended for a moment before its successor appears. Pulling bids then would throw away queue place for nothing, so a
// campaign whose window just ended is held: resting bids stay as they are, nothing new is placed, and exits keep
// running. The hold lasts at most `holdMs` (120 s). This file only decides each market's state; the engine acts on it.
//
//   active  quote as usual (after a hold the engine re-plans with force: true: `replan` is set on that one result)
//   hold    leave resting bids alone, place nothing new
//   ended   the window is over for good: pull bids
const ceilingHoldMs = 120e3
const neutralStaleMs = 600e3

const idsOf = (map) => (map instanceof Map ? [...map.keys()] : [])
const fillSet = (events) => {
  const fills = events?.fills
  if (fills === true) return true
  return new Set(Array.isArray(fills) ? fills : fills instanceof Set ? [...fills] : [])
}

/**
 * campaignTransition({ prev, next, now, policy, events }) -> Map<id, { state, row, since, replan? }>
 * row is the catalog entry (campaign-bands mainnetCatalog), whose own `.row` is the feed row.
 *
 * prev    the Map this returned last time (or null the first time)
 * next    what the engine just read: { entries, asOf } where entries come from campaign-bands mainnetCatalog and asOf is
 *         the feed's publish time in ms; a bare array of entries is accepted; null means the feed could not be read
 * policy  reads policy.rollover.holdMs (never above 120 s) and policy.rollover.feedStaleMs (default 10 min)
 * events  { fills: [ids] | true, kill: boolean, lossStop: boolean }: a fill on a market, a kill or a loss stop ends its
 *         hold at once, because the plan around it has changed
 *
 * since   when the state began; for a hold that is the moment the window ended (or the feed was first missing)
 * An entry with no pool (the successor's amount is not there yet) is a hold when the market was active, otherwise it is
 * not listed. A feed older than feedStaleMs makes every market ended.
 */
export function campaignTransition({ prev = null, next, now, policy, events = {} } = {}) {
  const holdMs = Math.min(Number(policy?.rollover?.holdMs) > 0 ? Number(policy.rollover.holdMs) : ceilingHoldMs, ceilingHoldMs)
  const staleMs = Number(policy?.rollover?.feedStaleMs) > 0 ? Number(policy.rollover.feedStaleMs) : neutralStaleMs
  const out = new Map()
  const entries = Array.isArray(next) ? next : Array.isArray(next?.entries) ? next.entries : null
  const asOf = Array.isArray(next) ? NaN : Number(next?.asOf)
  const was = (id) => (prev instanceof Map ? prev.get(id) : undefined)
  const fills = fillSet(events)
  const broken = (id) => events?.kill === true || events?.lossStop === true || fills === true || fills.has(id)

  // Too old to trust: nothing is quoted on it.
  if (entries && Number.isFinite(asOf) && now - asOf > staleMs) {
    for (const id of new Set([...idsOf(prev), ...entries.map((e) => e.id)])) {
      const before = was(id)
      const row = entries.find((e) => e.id === id) ?? before?.row
      out.set(id, { state: 'ended', row: row ?? null, since: before?.state === 'ended' ? before.since : now })
    }
    return out
  }

  const held = (id, row, since) => {
    const sinceAt = Number.isFinite(since) ? Math.min(since, now) : now
    if (broken(id) || now - sinceAt > holdMs) return { state: 'ended', row, since: now - sinceAt > holdMs ? sinceAt + holdMs : now }
    return { state: 'hold', row, since: sinceAt }
  }
  const listed = new Set()

  for (const entry of entries ?? []) {
    listed.add(entry.id)
    const before = was(entry.id)
    const live = before?.state === 'active' || before?.state === 'hold'
    if (entry.pool == null || !(entry.pool > 0)) {
      // The successor row exists but its reward amount does not yet.
      if (live) out.set(entry.id, held(entry.id, entry, before.state === 'hold' ? before.since : now))
      continue
    }
    if (before?.state === 'hold') {
      // The window is back: quote again, and re-plan from scratch.
      out.set(entry.id, { state: 'active', row: entry, since: now, replan: true })
    } else if (before?.state === 'active') out.set(entry.id, { state: 'active', row: entry, since: before.since })
    else out.set(entry.id, { state: 'active', row: entry, since: now })
  }

  for (const id of idsOf(prev)) {
    if (listed.has(id)) continue
    const before = was(id)
    if (before.state === 'ended') continue // dropped: it has been reported once
    const start = Number(before.row?.start)
    const end = Number(before.row?.windowEnd)
    if (Number.isFinite(start) && start <= now) out.set(id, { state: 'ended', row: before.row, since: now })
    else if (before.state === 'hold') out.set(id, held(id, before.row, before.since))
    // The window ended just now (or the feed is unreadable, or the row slipped out for a moment): hold from the moment
    // it ended, or from now when no end is known.
    else out.set(id, held(id, before.row, Number.isFinite(end) && end <= now ? end : now))
  }
  return out
}
