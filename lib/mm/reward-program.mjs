// The reward operator's public program data (Monarch / Marina, "Outcome Liquidity Rewards"). Pure functions only.
// Nothing here is a result of this tool. Amounts in the feed are fixed 6-decimal USDC strings.
export const REWARD_FEED_URL = 'https://api.monarch.fast/marina/outcome-markets/current-incentives'
export const REWARD_PAYOUTS_URL = 'https://api.monarch.fast/marina/outcome-markets/payouts'
export const REWARD_DOCS_URL = 'https://docs.monarch.fast/outcome-liquidity-rewards'
export const REWARD_ELIGIBILITY_URL = 'https://docs.monarch.fast/outcome-liquidity-rewards#reward-eligibility'

const num = (value) => {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
const time = (value) => {
  const ms = Date.parse(value ?? '')
  return Number.isFinite(ms) ? ms : null
}

// The feed publishes weights as "40"/"50"/"10"; the docs show "0.4"/"0.5"/"0.1". Both become whole percents.
export function normalizeSplit(weights) {
  const quote = num(weights?.quote)
  const makerFills = num(weights?.maker_fill)
  const takerFills = num(weights?.taker_fill)
  if (quote === null || makerFills === null || takerFills === null) return null
  const total = quote + makerFills + takerFills
  if (!(total > 0)) return null
  const pct = (x) => Math.round((x / total) * 1000) / 10
  return { quote: pct(quote), makerFills: pct(makerFills), takerFills: pct(takerFills) }
}

// A grouped market carries total_reward_amount_usdc (equal to the sum of its outcome budgets). A standalone
// outcome carries reward_amount_usdc on the market itself.
export function marketReward(market) {
  const total = num(market?.total_reward_amount_usdc)
  if (total !== null) return total
  if (Array.isArray(market?.outcomes) && market.outcomes.length) {
    return market.outcomes.reduce((sum, o) => sum + (num(o?.reward_amount_usdc) ?? 0), 0)
  }
  return num(market?.reward_amount_usdc) ?? 0
}

function periodOf(market) {
  const epoch = Array.isArray(market?.epochs) ? market.epochs[0] : null
  return {
    start: time(market?.incentive_start_time ?? epoch?.incentive_start_time),
    end: time(market?.incentive_end_time ?? epoch?.incentive_end_time),
  }
}

export function toCampaign(market, asOf) {
  const { start, end } = periodOf(market)
  const reward = marketReward(market)
  const id = market?.market_id ?? null
  const rawOutcomeId =
    market?.hyperliquid_outcome_id ??
    (Array.isArray(market?.outcomes) ? market.outcomes.find((o) => Number.isSafeInteger(o?.hyperliquid_outcome_id))?.hyperliquid_outcome_id : null)
  const outcomeId = Number.isSafeInteger(rawOutcomeId) && rawOutcomeId >= 0 ? rawOutcomeId : null
  const live = market?.incentive_status === 'incentivized' && (end === null || asOf === null || end > asOf)
  return {
    live,
    campaign: {
      id,
      outcomeId,
      name: String(market?.market_name ?? ''),
      rewardUsd: reward,
      endsAt: end,
      spreadCents: num(market?.scoring_params?.baseline_total_spread_cents),
      quotable: Boolean(id) && live && reward > 0 && (start === null || asOf === null || start <= asOf),
    },
  }
}

function commonSplit(markets) {
  const counts = new Map()
  for (const m of markets) {
    const s = normalizeSplit(m?.scoring_params?.component_weights)
    if (!s) continue
    const key = JSON.stringify(s)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  let best = null
  for (const [key, count] of counts) if (!best || count > best.count) best = { key, count }
  return best ? JSON.parse(best.key) : null
}

// feed: the current-incentives response. extra: optional figures from other endpoints, each null when unknown:
// { distributedUsd, monthlyRewardsUsd, activeMakers }. Returns null when the feed has no markets list.
export function buildRewardProgram(feed, extra = {}) {
  if (!feed || !Array.isArray(feed.markets)) return null
  const asOf = time(feed.as_of)
  const live = feed.markets.map((m) => toCampaign(m, asOf)).filter((x) => x.live)
  const campaigns = live
    .map((x) => x.campaign)
    .sort((a, b) => (a.endsAt ?? Infinity) - (b.endsAt ?? Infinity) || b.rewardUsd - a.rewardUsd || a.name.localeCompare(b.name))
  const liveRewardsUsd = Math.round(campaigns.reduce((sum, c) => sum + c.rewardUsd, 0) * 1e6) / 1e6
  return {
    asOf,
    liveCampaigns: campaigns.length,
    liveRewardsUsd,
    monthlyRewardsUsd: num(extra?.monthlyRewardsUsd),
    distributedUsd: num(extra?.distributedUsd),
    activeMakers: num(extra?.activeMakers),
    split: commonSplit(feed.markets.filter((m) => m?.incentive_status === 'incentivized')),
    campaigns,
  }
}

export const distributedFrom = (payouts) => num(payouts?.total_distributed_rewards_usdc)

// Browser or server fetch. The feed is required; the cumulative total is optional and never blocks the panel.
export async function loadRewardProgram(fetchImpl = fetch, timeoutMs = 8000) {
  const get = async (url) => {
    const response = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) throw new Error('Reward data request failed.')
    return response.json()
  }
  const [feed, payouts] = await Promise.allSettled([get(REWARD_FEED_URL), get(REWARD_PAYOUTS_URL)])
  if (feed.status !== 'fulfilled') throw new Error('Reward data is not available right now.')
  const program = buildRewardProgram(feed.value, { distributedUsd: payouts.status === 'fulfilled' ? distributedFrom(payouts.value) : null })
  if (!program) throw new Error('Reward data is not available right now.')
  return program
}
