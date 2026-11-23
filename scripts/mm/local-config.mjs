import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { addressOf } from '../../lib/mm/testnet.mjs'

// Operator settings that belong to this machine and never to the repo. Today that is only the list of owner wallets
// whose orders carry no builder fee. It is empty unless the operator sets it.
export const operatorFileIn = (stateDir) => join(String(stateDir), 'operator.json')
export const operatorFile = operatorFileIn(join(homedir(), '.hip4-ag', 'mm'))

const entries = (list, source) =>
  list.map((value, i) => {
    try {
      return addressOf(String(value).trim())
    } catch {
      throw Error(`Fee-waived wallet ${i + 1} in ${source} is not a valid address.`)
    }
  })

/**
 * Returns { feeWaived: string[] }: the union of MM_FEE_WAIVED (comma-separated) and operator.json's feeWaived,
 * each checked and lowercased. A missing file or variable adds nothing. Any invalid entry throws, so the runner
 * refuses to start rather than silently charging or waiving the wrong wallet.
 * allowEnv false ignores MM_FEE_WAIVED: a hosted runner reads the waiver list from its state folder only, so a
 * deploy template variable can never switch the builder fee off.
 */
export function loadOperatorConfig({ env = process.env, file = operatorFile, allowEnv = true } = {}) {
  const found = []
  const raw = allowEnv ? env?.MM_FEE_WAIVED : undefined
  if (typeof raw === 'string' && raw.trim()) {
    const parts = raw.split(',').map((s) => s.trim())
    if (parts.some((s) => !s)) throw Error('MM_FEE_WAIVED has an empty entry.')
    found.push(...entries(parts, 'MM_FEE_WAIVED'))
  }
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (e) {
    if (e?.code !== 'ENOENT') throw Error('The operator config file could not be read: ' + e.message)
  }
  if (text !== undefined) {
    let data
    try {
      data = JSON.parse(text)
    } catch {
      throw Error('The operator config file is not valid JSON.')
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('The operator config must be an object.')
    for (const key of Object.keys(data))
      if (key !== 'feeWaived') throw Error(`The operator config has an unknown setting: ${key}.`)
    if (data.feeWaived !== undefined) {
      if (!Array.isArray(data.feeWaived) || data.feeWaived.some((v) => typeof v !== 'string'))
        throw Error('feeWaived in the operator config must be a list of addresses.')
      found.push(...entries(data.feeWaived, 'the operator config'))
    }
  }
  return { feeWaived: [...new Set(found)] }
}
