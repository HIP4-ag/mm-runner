import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { sealPolicy } from '../guards.mjs'

// The only way to get the policy. A shipped build may drop a compiled.mjs next to this file; otherwise the
// reference policy loads. The path is fixed on purpose: no env var, no user-supplied path.
const compiled = new URL('./compiled.mjs', import.meta.url)
const source = existsSync(fileURLToPath(compiled)) ? await import('./compiled.mjs') : await import('./reference.mjs')

let checked = null

/**
 * Returns the policy as deep-frozen plain data plus pure functions wrapped in guards.mjs, after every field passes the
 * absolute envelope. Throws, so the runner refuses to start, if any field is missing, NaN or outside it.
 */
export function loadPolicy() {
  if (!checked) checked = sealPolicy(source.Policy ?? source.default)
  return checked
}
