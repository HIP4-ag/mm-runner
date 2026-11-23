import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadOperatorConfig, operatorFileIn } from './local-config.mjs'

const a = '0x000000000000000000000000000000000000dead'
const b = '0x000000000000000000000000000000000000beef'
const dir = mkdtempSync(join(tmpdir(), 'mm-operator-'))
const fileWith = (name, data) => {
  const file = join(dir, name)
  writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data))
  return file
}
const missing = join(dir, 'missing.json')

test('a missing file and no variable waive nobody', () => {
  assert.deepEqual(loadOperatorConfig({ env: {}, file: missing }), { feeWaived: [] })
  assert.deepEqual(loadOperatorConfig({ env: { MM_FEE_WAIVED: '  ' }, file: missing }), { feeWaived: [] })
})

test('the variable and the file are merged, lowercased and de-duplicated', () => {
  const file = fileWith('both.json', { feeWaived: [b.toUpperCase().replace('0X', '0x'), a] })
  const { feeWaived } = loadOperatorConfig({ env: { MM_FEE_WAIVED: ` ${a.toUpperCase().replace('0X', '0x')} ` }, file })
  assert.deepEqual(feeWaived.sort(), [a, b].sort())
  assert.deepEqual(loadOperatorConfig({ env: { MM_FEE_WAIVED: a + ',' + b }, file: missing }).feeWaived, [a, b])
})

test('a hosted runner ignores the variable and reads the file in its state folder', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'mm-state-'))
  writeFileSync(operatorFileIn(stateDir), JSON.stringify({ feeWaived: [b] }))
  const { feeWaived } = loadOperatorConfig({ env: { MM_FEE_WAIVED: a }, file: operatorFileIn(stateDir), allowEnv: false })
  assert.deepEqual(feeWaived, [b])
  assert.deepEqual(loadOperatorConfig({ env: { MM_FEE_WAIVED: a }, file: missing, allowEnv: false }), { feeWaived: [] })
})

test('an invalid entry anywhere refuses to load', () => {
  for (const env of [{ MM_FEE_WAIVED: '0x1234' }, { MM_FEE_WAIVED: a + ',' }, { MM_FEE_WAIVED: '0x' + '0'.repeat(40) }])
    assert.throws(() => loadOperatorConfig({ env, file: missing }))
  for (const data of [{ feeWaived: ['nope'] }, { feeWaived: a }, { feeWaived: [a], extra: 1 }, [a], 'not json'])
    assert.throws(() => loadOperatorConfig({ env: {}, file: fileWith('bad.json', data) }))
})
