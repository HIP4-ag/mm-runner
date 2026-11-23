// Mainnet arming. Browser safe: no Node imports. The owner wallet signs the message below, and the runner checks it
// again with verifyArming before any mainnet order. The record is never trusted on its own.
export const statementVersion = 'risk-1'
export const maxArmingMs = 7 * 86400e3
const skewMs = 5 * 60e3

const lower = (value) => String(value ?? '').toLowerCase()

/** What the owner types. Ends with the last four characters of the trading account. */
export const armingPhrase = (target) => 'MAINNET ' + String(target ?? '').slice(-4).toUpperCase()

/** The exact text the owner wallet signs. */
export function armingMessage({ owner, target, agent, device, issuedAt, expiresAt, phrase, statementVersion: version }) {
  return [
    'Arm hip4.ag mainnet runner',
    'Statement ' + version,
    'Owner ' + lower(owner),
    'Trading account ' + lower(target),
    'Agent ' + lower(agent),
    'Device ' + String(device ?? ''),
    'Phrase ' + phrase,
    'Issued ' + new Date(issuedAt).toISOString(),
    'Expires ' + new Date(expiresAt).toISOString(),
  ].join('\n')
}

/**
 * Check an arming record. `verify` is viem's verifyMessage (or any function with the same shape), passed in so this
 * file stays browser safe. Returns { verified, reason, expiresAt }. Any change to the record breaks the signature.
 */
export async function verifyArming({ record, owner, target, agent, device, now = Date.now(), verify }) {
  const expiresAt = Number.isFinite(record?.expiresAt) ? record.expiresAt : null
  const no = (reason) => ({ verified: false, reason, expiresAt })
  if (!record || typeof record !== 'object') return no('Mainnet is not armed.')
  if (record.statementVersion !== statementVersion) return no('The risk statement has changed. Arm again.')
  if (lower(record.owner) !== lower(owner)) return no('This arming belongs to a different owner wallet.')
  if (lower(record.target) !== lower(target)) return no('This arming is for a different trading account.')
  if (lower(record.agent) !== lower(agent)) return no('This arming is for a different agent key.')
  if (device !== undefined && record.device !== device) return no('This arming is for a different device.')
  if (record.phrase !== armingPhrase(target)) return no('The typed phrase does not match this account.')
  const { issuedAt } = record
  if (!Number.isFinite(issuedAt) || !Number.isFinite(record.expiresAt) || record.expiresAt <= issuedAt)
    return no('The arming window is not valid.')
  if (record.expiresAt - issuedAt > maxArmingMs) return no('The arming window is longer than the allowed 7 days.')
  if (issuedAt > now + skewMs) return no('The arming time is in the future.')
  if (now >= record.expiresAt) return no('The arming has expired. Arm again.')
  if (typeof record.signature !== 'string' || typeof verify !== 'function') return no('The arming is not signed.')
  let ok = false
  try {
    ok = await verify({ address: owner, message: armingMessage(record), signature: record.signature })
  } catch {
    ok = false
  }
  return ok ? { verified: true, reason: null, expiresAt } : no('The owner signature does not match.')
}
