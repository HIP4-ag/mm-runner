// Reads the user's OWN reward score. One wallet only: the one passed in. Nothing here looks at any other wallet,
// ranks anyone or keeps a leaderboard. The result is an estimate (a share of the pool), never a payment.
//
// The score response shape is read defensively: a row is used only when it names a market and carries either a
// ready share or a wallet score and a total. Anything else is skipped, not guessed.
const scores = 'https://api.monarch.fast/marina/outcome-markets/scores'

const finite = (x) => (x !== null && x !== undefined && x !== '' && Number.isFinite(Number(x)) ? Number(x) : null)

function shareOf(row) {
  const ready = finite(row.share ?? row.score_share ?? row.wallet_share)
  if (ready !== null) return ready >= 0 && ready <= 1 ? ready : null
  const own = finite(row.wallet_score ?? row.user_score ?? row.score)
  const total = finite(row.total_score ?? row.market_total_score)
  return own !== null && total !== null && total > 0 ? Math.min(1, Math.max(0, own / total)) : null
}

/**
 * Estimated reward for one wallet across the markets it quoted today.
 * Returns { status: 'estimated', usd, markets: [{ id, share, poolUsd, usd }], skipped }.
 * `usd` is null when no market gave a usable share and pool, so the page shows "not available", never zero.
 */
export async function readOwnScores({ marketIds, wallet, fetch: fetcher = globalThis.fetch, timeoutMs = 5000 }) {
  if (!/^0x[\da-f]{40}$/i.test(wallet ?? '')) throw Error('A wallet address is required.')
  const ids = [...new Set((marketIds ?? []).filter((id) => Number.isSafeInteger(id) && id >= 0))]
  if (!ids.length) return { status: 'estimated', usd: null, markets: [], skipped: 0 }
  const url = new URL(scores)
  url.searchParams.set('wallet', wallet.toLowerCase())
  url.searchParams.set('market_ids', ids.map((id) => 'O' + id).join(','))
  const response = await fetcher(url, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw Error('The reward score feed is unavailable.')
  const body = await response.json()
  const rows = [body?.scores, body?.markets, body?.rows, body?.data, Array.isArray(body) ? body : null].find(Array.isArray) ?? []
  const wanted = new Set(ids)
  const markets = []
  let skipped = 0
  for (const row of rows) {
    const id = Number.isSafeInteger(row?.hyperliquid_outcome_id) ? row.hyperliquid_outcome_id : Number(String(row?.market_id ?? '').replace(/^O/, ''))
    const share = shareOf(row ?? {})
    const poolUsd = finite(row?.pool_usd ?? row?.daily_pool_usd ?? row?.reward_pool_usd)
    if (!wanted.has(id) || share === null || poolUsd === null || poolUsd < 0) {
      skipped++
      continue
    }
    markets.push({ id, share, poolUsd, usd: Math.round(share * poolUsd * 1e6) / 1e6 })
  }
  const usd = markets.length ? Math.round(markets.reduce((sum, m) => sum + m.usd, 0) * 1e6) / 1e6 : null
  return { status: 'estimated', usd, markets, skipped }
}
