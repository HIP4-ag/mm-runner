import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { builder, fee, feeFor, quoteEstimate } from '../../lib/mm/testnet.mjs'

const waived = '0x000000000000000000000000000000000000dead'

test('a waived owner wallet quotes with no builder fee, in any letter case', () => {
  assert.equal(feeFor(waived, [waived]), 0)
  assert.equal(feeFor(waived.toUpperCase().replace('0X', '0x'), [waived]), 0)
})

test('with the default list every owner wallet pays the standard fee', () => {
  assert.equal(feeFor(waived), fee)
  assert.equal(feeFor('0x000000000000000000000000000000000000beef', [waived]), fee)
  assert.equal(feeFor(undefined), fee)
  assert.equal(feeFor(''), fee)
  assert.equal(feeFor(undefined, [waived]), fee)
  assert.equal(feeFor('', [waived]), fee)
})

test('the shared testnet module carries no waived wallet address', () => {
  const source = readFileSync(new URL('../../lib/mm/testnet.mjs', import.meta.url), 'utf8')
  const addresses = source.match(/0x[0-9a-f]{40}/gi) ?? []
  // The only address left is the public builder.
  assert.deepEqual([...new Set(addresses.map((a) => a.toLowerCase()))], [builder])
})

test('the estimate reserves the fee the owner will actually be charged', () => {
  const orders = [
    { p: '0.5', s: '100' },
    { p: '0.5', s: '100' },
  ]
  assert.equal(quoteEstimate(orders, 0).builderFee, 0)
  assert.equal(quoteEstimate(orders, 0).debit, 100)
  assert.ok(quoteEstimate(orders).builderFee > 0)
})
