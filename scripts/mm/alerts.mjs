// Optional operator alerts for high-signal safety events: "Sell by hand" holds, loss stops, reconciliation halts,
// and crash-loop safe mode. Never logs or exposes the webhook URL, never throws into the trading loop, and deduplicates
// alerts so a persistent hold does not spam the user.

const DEFAULT_COOLDOWN_MS = 5 * 60_000
const MAX_PER_HOUR = 12
const SEND_TIMEOUT_MS = 4000

const isDiscord = (url) => /^https:\/\/(?:(?:ptb|canary)\.)?(?:discord\.com|discordapp\.com)\/api\/webhooks\//i.test(url)
const isTelegram = (url) => /^https:\/\/api\.telegram\.org\/bot[^/]+\/sendMessage(?:\?|$)/i.test(url)

export function parseAlertConfig(env = process.env) {
  const rawUrl = String(env?.MM_WEBHOOK_URL ?? '').trim()
  const chatId = String(env?.MM_TELEGRAM_CHAT_ID ?? '').trim()
  if (!rawUrl) return null
  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null
  return { url: rawUrl, chatId: chatId || null }
}

/** Remove alert secrets from process.env after reading once (matches MM_AGENT_KEY handling). */
export function consumeAlertEnv(env = process.env) {
  const cfg = parseAlertConfig(env)
  if (env && 'MM_WEBHOOK_URL' in env) delete env.MM_WEBHOOK_URL
  if (env && 'MM_TELEGRAM_CHAT_ID' in env) delete env.MM_TELEGRAM_CHAT_ID
  return cfg
}

export function formatPayload(config, { event, text, at, network }) {
  if (isDiscord(config.url)) return { content: text }
  if (isTelegram(config.url)) {
    const body = { text }
    if (config.chatId) body.chat_id = config.chatId
    return body
  }
  return { text, event, at, network }
}

const marketLink = (marketId) =>
  Number.isSafeInteger(marketId) && marketId >= 0 ? ` https://hip4.ag/hip4/${marketId}` : ''

export function createAlertNotifier({
  config = null,
  fetchImpl = fetch,
  now = Date.now,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  maxPerHour = MAX_PER_HOUR,
  network = 'mainnet',
} = {}) {
  const seen = new Map()
  const sentAt = []
  let activeHoldKeys = new Set()
  let lastBlockCode = null
  let lastReview = null

  async function notify(key, event, text) {
    if (!config?.url) return false
    const t = now()
    while (sentAt.length && sentAt[0] <= t - 3600_000) sentAt.shift()
    if (sentAt.length >= maxPerHour) return false
    const prev = seen.get(key)
    if (prev !== undefined && t - prev < cooldownMs) return false
    seen.set(key, t)
    sentAt.push(t)
    try {
      const payload = formatPayload(config, { event, text, at: new Date(t).toISOString(), network })
      const res = await fetchImpl(config.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      })
      return Boolean(res?.ok)
    } catch {
      return false
    }
  }

  /** Inspect live runner state after a tick or restart and send alerts for new safety events. */
  async function inspect(state) {
    if (!config?.url || !state) return []
    const fired = []
    const holds = Array.isArray(state.holds) ? state.holds : []
    const nextHoldKeys = new Set()
    for (const h of holds) {
      const id = h.marketId ?? h.id ?? h.coin ?? h.legIdx ?? 'unknown'
      const key = `hold:${id}:${h.code ?? ''}`
      nextHoldKeys.add(key)
      if (!activeHoldKeys.has(key)) {
        const label = h.label ?? h.coin ?? `Market ${id}`
        const msg = `[hip4.ag MM] SELL BY HAND: ${label} - ${h.message ?? 'Cannot sell safely.'}${marketLink(h.marketId ?? h.id)}`
        if (await notify(key, 'hold', msg)) fired.push(key)
      }
    }
    activeHoldKeys = nextHoldKeys

    const blockCode = state.bidBlock?.code ?? null
    if ((blockCode === 'loss-day' || blockCode === 'loss-hour') && blockCode !== lastBlockCode) {
      const key = `block:${blockCode}`
      const msg = `[hip4.ag MM] Loss stop triggered (${blockCode}): ${state.bidBlock.message ?? 'New bids paused; exits continue.'}`
      if (await notify(key, 'loss-stop', msg)) fired.push(key)
    }
    lastBlockCode = blockCode

    const review = state.needsReview ?? null
    if (review && review !== lastReview) {
      const key = `review:${review}`
      const msg = `[hip4.ag MM] Runner needs review (orders paused): ${review} https://hip4.ag/mm`
      if (await notify(key, 'hard-stop', msg)) fired.push(key)
    }
    lastReview = review

    return fired
  }

  return {
    enabled: Boolean(config?.url),
    notify,
    inspect,
  }
}
