// Every clock time a user sees is US Eastern. Intl does the daylight saving rules, so nothing here guesses an offset.
const zone = 'America/New_York'
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function parts(ms, options) {
  const out = {}
  for (const p of new Intl.DateTimeFormat('en-US', { timeZone: zone, ...options }).formatToParts(ms)) out[p.type] = p.value
  return out
}
const valid = (ms) => ms !== null && ms !== undefined && ms !== '' && Number.isFinite(Number(ms))
const hour12 = (ms) => {
  const p = parts(Number(ms), { hour: 'numeric', minute: '2-digit', hourCycle: 'h12' })
  return { hour: p.hour, minute: p.minute, period: String(p.dayPeriod).toUpperCase() }
}
const monthDay = (ms) => {
  const p = parts(Number(ms), { month: 'numeric', day: 'numeric' })
  return `${MONTHS[Number(p.month) - 1]} ${Number(p.day)}`
}

/** "7:30 PM ET" */
export function easternTime(ms) {
  if (!valid(ms)) return ''
  const t = hour12(ms)
  return `${t.hour}:${t.minute} ${t.period} ET`
}

/** "Nov 20, 7:30 PM ET" */
export function easternDateTime(ms) {
  if (!valid(ms)) return ''
  return `${monthDay(ms)}, ${easternTime(ms)}`
}

/** "19:30 ET", for deadlines. */
export function easternClock(ms) {
  if (!valid(ms)) return ''
  const p = parts(Number(ms), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  return `${p.hour}:${p.minute} ET`
}

const dayPattern = /^\d{4}-\d{2}-\d{2}$/
const hourLabel = (ms) => {
  const t = hour12(ms)
  return `${t.hour} ${t.period}`
}

/** A UTC day, with the Eastern hours it covers: "Nov 20 (7 PM Nov 19 to 7 PM Nov 20 ET)". */
export function earningDayLabel(day) {
  if (!dayPattern.test(day)) return String(day ?? '')
  const start = Date.parse(day + 'T00:00:00Z')
  if (!Number.isFinite(start)) return String(day)
  const end = start + 86400000
  const [, month, date] = day.split('-')
  return `${MONTHS[Number(month) - 1]} ${Number(date)} (${hourLabel(start)} ${monthDay(start)} to ${hourLabel(end)} ${monthDay(end)} ET)`
}
