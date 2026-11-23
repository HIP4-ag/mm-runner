import test from 'node:test'
import assert from 'node:assert/strict'
import { consumeAlertEnv, createAlertNotifier, formatPayload, parseAlertConfig } from './alerts.mjs'

test('parseAlertConfig accepts https webhooks only and rejects http or invalid URLs', () => {
  assert.equal(parseAlertConfig({}), null)
  assert.equal(parseAlertConfig({ MM_WEBHOOK_URL: 'http://example.com/hook' }), null)
  assert.equal(parseAlertConfig({ MM_WEBHOOK_URL: 'not-a-url' }), null)
  assert.deepEqual(
    parseAlertConfig({ MM_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/abc' }),
    { url: 'https://discord.com/api/webhooks/1/abc', chatId: null }
  )
  const env = { MM_WEBHOOK_URL: 'https://api.telegram.org/bot123:xyz/sendMessage', MM_TELEGRAM_CHAT_ID: '42' }
  assert.deepEqual(consumeAlertEnv(env), {
    url: 'https://api.telegram.org/bot123:xyz/sendMessage',
    chatId: '42',
  })
  assert.equal('MM_WEBHOOK_URL' in env, false)
  assert.equal('MM_TELEGRAM_CHAT_ID' in env, false)
})

test('formatPayload shapes Discord, Telegram, and generic webhook payloads', () => {
  const evt = { event: 'hold', text: 'Sell by hand', at: '2026-11-22T00:00:00.000Z', network: 'mainnet' }
  assert.deepEqual(formatPayload({ url: 'https://discord.com/api/webhooks/1/tok' }, evt), { content: 'Sell by hand' })
  assert.deepEqual(
    formatPayload({ url: 'https://api.telegram.org/bot1:x/sendMessage', chatId: '999' }, evt),
    { chat_id: '999', text: 'Sell by hand' }
  )
  assert.deepEqual(formatPayload({ url: 'https://hooks.slack.com/services/a/b/c' }, evt), evt)
})

test('createAlertNotifier alerts on holds, loss stops, and review halts with deduping and safe failure handling', async () => {
  let t = 1_000_000
  const calls = []
  const notifier = createAlertNotifier({
    config: { url: 'https://discord.com/api/webhooks/1/tok', chatId: null },
    now: () => t,
    cooldownMs: 300_000,
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) })
      return { ok: true }
    },
  })
  const holdState = {
    holds: [{ marketId: 39435, label: 'Heat v Thunder', code: 'book', message: 'Book is one-sided. Sell by hand before the start.' }],
    bidBlock: { code: 'loss-day', message: 'Daily loss stop reached.' },
    needsReview: null,
  }
  const first = await notifier.inspect(holdState)
  assert.equal(first.length, 2)
  assert.match(calls[0].body.content, /SELL BY HAND.*https:\/\/hip4\.ag\/hip4\/39435/)
  assert.match(calls[1].body.content, /Loss stop triggered/)

  // Same persistent hold on next tick does not spam.
  assert.deepEqual(await notifier.inspect(holdState), [])
  assert.equal(calls.length, 2)

  // Review halt fires once.
  const review = await notifier.inspect({ ...holdState, needsReview: 'Position mismatch.' })
  assert.equal(review.length, 1)
  assert.match(calls[2].body.content, /needs review/)

  // Failed webhook never throws into the trading loop.
  const failing = createAlertNotifier({
    config: { url: 'https://hooks.example.com/alert', chatId: null },
    now: () => t,
    fetchImpl: async () => {
      throw new Error('network down')
    },
  })
  assert.equal(await failing.notify('k', 'hold', 'test'), false)
})
