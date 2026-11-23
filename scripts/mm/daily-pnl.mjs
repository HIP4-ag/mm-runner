// One row per UTC day: reward, trading result, fees and net. Pure: no I/O, so the same rows come out of the journal,
// the status endpoint and the tests.
//
// A day is a UTC day. A reward dated D pays for the day before it, so it is booked to D-1.
// Trading result = cash from fills (sells in, buys out) + the change in the marked value of the shares held.
// Fees are kept apart: net = reward + trading result - fees.

const round8 = (x) => Math.round(x * 1e8) / 1e8
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0)
const dayPattern = /^\d{4}-\d{2}-\d{2}$/

export const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10)

/** The earning day a reward dated `dated` (a UTC day, 'YYYY-MM-DD') belongs to: the day before. */
export function earningDayFor(dated) {
  if (!dayPattern.test(dated)) throw Error('A reward date must look like 2026-11-21.')
  return dayOf(Date.parse(dated + 'T00:00:00Z') - 86400000)
}

function marksByDay(dayMarks) {
  const out = new Map()
  const rows = dayMarks instanceof Map ? [...dayMarks].map(([day, v]) => ({ day, ...v })) : Array.isArray(dayMarks) ? dayMarks : Object.entries(dayMarks ?? {}).map(([day, v]) => ({ day, ...v }))
  for (const row of rows) if (dayPattern.test(row?.day)) out.set(row.day, { positions: row.positions ?? {}, marks: row.marks ?? {} })
  return out
}

function rewardsByDay(rewards) {
  const out = new Map()
  for (const r of rewards ?? []) {
    const day = r.earningDay ?? (r.dated ? earningDayFor(r.dated) : null)
    if (!dayPattern.test(day) || !Number.isFinite(Number(r.usd))) continue
    const status = r.status === 'paid' ? 'paid' : 'estimated'
    const current = out.get(day)
    // A paid figure is never replaced by an estimate. Otherwise the later row wins.
    if (current?.status === 'paid' && status !== 'paid') continue
    out.set(day, { usd: Number(r.usd), status })
  }
  return out
}

const valueOf = (positions, marks) => {
  let total = 0
  for (const [coin, shares] of Object.entries(positions)) total += num(shares) * num(marks[coin])
  return total
}

/**
 * fills: [{ time, coin, side: 'B' | 'A', px, sz, fee, builderFee }]
 * dayMarks: { 'YYYY-MM-DD': { positions: { coin: shares }, marks: { coin: price } } }, the end-of-day state. A
 *   coin that settled on that day is marked at its settlement price, and its payout comes in as a settlement.
 * rewards: [{ earningDay } or { dated }, usd, status: 'estimated' | 'paid' }]
 * settlements: [{ time, usd }] cash paid out when a held coin settled.
 * Days with fills but no saved marks are marked at the last fill price of each coin, and say so in `marked`.
 */
export function dailyRows({ fills = [], dayMarks = {}, rewards = [], settlements = [] } = {}) {
  const marks = marksByDay(dayMarks)
  const paid = rewardsByDay(rewards)
  const fillsOn = new Map()
  const cashOn = new Map()
  const add = (map, day, row) => map.set(day, [...(map.get(day) ?? []), row])
  for (const f of fills) if (Number.isFinite(f?.time)) add(fillsOn, dayOf(f.time), f)
  for (const s of settlements) if (Number.isFinite(s?.time)) add(cashOn, dayOf(s.time), s)
  const days = [...new Set([...fillsOn.keys(), ...cashOn.keys(), ...marks.keys(), ...paid.keys()])].sort()

  let before = 0
  let held = {}
  let lastMark = {}
  let running = 0
  return days.map((day) => {
    let cash = 0
    let fees = 0
    const traded = {}
    for (const f of [...(fillsOn.get(day) ?? [])].sort((a, b) => a.time - b.time)) {
      const value = num(f.px) * num(f.sz)
      const sign = f.side === 'A' ? 1 : -1
      cash += sign * value
      fees += num(f.fee) + num(f.builderFee)
      held[f.coin] = num(held[f.coin]) - sign * num(f.sz)
      traded[f.coin] = num(f.px)
    }
    for (const s of cashOn.get(day) ?? []) cash += num(s.usd)

    let after
    let source
    const saved = marks.get(day)
    if (saved) {
      held = { ...saved.positions }
      lastMark = { ...lastMark, ...saved.marks }
      after = valueOf(held, lastMark)
      source = 'marks'
    } else if (fillsOn.has(day) || cashOn.has(day)) {
      lastMark = { ...lastMark, ...traded }
      after = valueOf(held, lastMark)
      source = 'fills'
    } else {
      after = before
      source = 'none'
    }
    const trading = round8(cash + after - before)
    before = after
    const reward = paid.get(day)
    const feesUsd = round8(fees)
    const net = round8((reward?.usd ?? 0) + trading - feesUsd)
    running = round8(running + net)
    return {
      day,
      rewardUsd: reward ? round8(reward.usd) : null,
      rewardStatus: reward?.status ?? 'none',
      tradingUsd: trading,
      feesUsd,
      netUsd: net,
      runningNetUsd: running,
      marked: source,
    }
  })
}
