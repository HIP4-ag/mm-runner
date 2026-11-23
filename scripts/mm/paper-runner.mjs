import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { budgets, frameAt, planQuotes } from './paper-policy.mjs'
import { campaignFeed, campaignInputs, inspectCampaign, mainnetCatalog } from './campaign-bands.mjs'
import { campaignTransition } from './campaign-watch.mjs'
import { budgetChoices, frontendApproved, planRewardQuotes, rewardBudgets, rewardTick } from './reward-plan.mjs'
import { fee } from '../../lib/mm/testnet.mjs'
import { loadPolicy } from './policy/index.mjs'
import { loadPreferences, preferencesFile, preferencesView, savePreferences } from './preferences.mjs'

// A dry run for one market: it reads the public feed and the live book and shows the bids the plan would rest.
// Nothing is sent to any exchange. There is no ranking and no portfolio view; the market is chosen by hand.
//
// Local rehearsal only: treat hip4.ag as a whitelisted reward frontend so the rest of the checks can be exercised.
// The status and every snapshot say so. Without it every reward plan is blocked (see reward-plan.mjs).
const assumed = !frontendApproved && process.env.MM_ASSUME_REWARD_FRONTEND === '1'
const approved = frontendApproved || assumed
const feeRate = fee / 100000
const policy = loadPolicy()

// The band fraction is the user's own depth setting (depthPct, as a fraction), or the plan's neutral default when no
// settings can be read.
function depthFraction() {
  try {
    return policy.settingsFor(loadPreferences(preferencesFile, policy).prefs).depthFraction
  } catch {
    return undefined
  }
}

const host = '127.0.0.1:5314'
const dashboardOrigins = new Set(['http://localhost:5004', 'http://127.0.0.1:5004'])
const token = randomBytes(24).toString('hex')
const agent = privateKeyToAccount(generatePrivateKey())
let budget = null
let generation = 0
let frame = 0
let snapshot = null
let timer
let reward = null // { id, outcome, name, budget, states } while a paper reward run is on

// A paper reward run: every three seconds re-read the campaign and its live YES book and keep the two bids only
// while the plan still verifies. When the reward window turns over (00:00 UTC) the bids are held for up to 120 seconds
// instead of being pulled at once (campaign-watch.mjs). Nothing is sent to the exchange.
async function rewardLoop(run) {
  if (run !== generation || !reward) return
  const now = Date.now()
  let next = null
  try {
    const { data, asOf } = await campaignFeed()
    next = { entries: mainnetCatalog({ feed: data, now }), asOf }
  } catch {
    // An unreadable feed is a hold for a while and then an end: campaignTransition decides which.
  }
  reward.states = campaignTransition({ prev: reward.states, next, now, policy })
  const watched = reward.states.get(reward.outcome)
  let result
  if (watched?.state === 'hold') {
    result = {
      quotes: snapshot?.quotes ?? [],
      held: 'The reward window is rolling over. Bids are held for up to 120 seconds.',
      plan: null,
      rollover: { since: watched.since },
    }
  } else if (watched?.state !== 'active') {
    result = { quotes: [], held: 'This reward window is not open.', plan: null }
  } else {
    try {
      const input = await campaignInputs(reward.id)
      result = rewardTick({ ...input, now: Date.now(), budget: reward.budget, feeRate, approved, fraction: depthFraction() })
    } catch (e) {
      result = { quotes: [], held: e.message || 'Eligibility could not be verified.', plan: null }
    }
  }
  if (run !== generation) return
  snapshot = {
    reward: true,
    // The quotes held through a rollover are already in cents.
    quotes: result.rollover ? result.quotes : result.quotes.map((q) => ({ ...q, price: Math.round(q.price * 1e7) / 1e5 })),
    held: result.held,
    band: result.plan?.band ?? null,
    depth: result.plan?.depth ?? 0,
    rollover: result.rollover ?? null,
    observedAt: Date.now(),
  }
  timer = setTimeout(() => rewardLoop(run), 3000)
}

async function tick(run) {
  if (run !== generation || budget === null) return
  const observedAt = Date.now()
  const book = frameAt(frame++)
  const quotes = planQuotes(book, budget, observedAt, Date.now())
  const message = JSON.stringify({ mode: 'paper', run, book, budget, quotes, observedAt })
  try {
    // A plain message receipt cannot be submitted as a Hyperliquid exchange action.
    const signature = await agent.signMessage({ message })
    if (run !== generation) return
    snapshot = { book, quotes, observedAt, receipt: { message, signature } }
    timer = setTimeout(() => tick(run), 3000)
  } catch {
    if (run === generation) stop()
  }
}

function stop() {
  generation++
  clearTimeout(timer)
  budget = null
  reward = null
  snapshot = null
}

function status() {
  return {
    mode: 'paper',
    agent: agent.address,
    budgets,
    budget,
    snapshot,
    reward: reward && { id: reward.id, name: reward.name, budget: reward.budget },
    rewardBudgets,
    rewardFrontend: frontendApproved ? 'approved' : assumed ? 'assumed' : 'unconfirmed',
  }
}

async function body(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > 16384) throw Error('Request too large.')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    throw Error('The request body must be JSON.')
  }
}

const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  const send = (code, data) => {
    res.writeHead(code, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }
  if (req.headers.host !== host) return send(403, { error: 'Local runner only.' })
  if (req.url === '/pair' && req.method === 'GET') {
    if (req.headers.origin && req.headers.origin !== 'http://' + host) return send(403, {})
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    })
    return res.end(
      'Local paper runner pairing code\n\n' +
        token +
        '\n\nPaste this code into the local /mm dashboard. It expires when the runner stops.'
    )
  }
  if (!dashboardOrigins.has(req.headers.origin)) return send(403, { error: 'Open the local dashboard on port 5004.' })
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin)
  res.setHeader('Vary', 'Origin')
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET, POST',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    })
    return res.end()
  }
  if (req.headers.authorization !== 'Bearer ' + token) return send(401, { error: 'Pair with the current runner code.' })
  if (req.method === 'GET' && req.url === '/status') return send(200, status())
  if (req.url === '/preferences' && req.method === 'GET') {
    try {
      return send(200, preferencesView(loadPreferences(preferencesFile, policy), policy))
    } catch {
      return send(500, { error: 'The preferences file could not be read.' })
    }
  }
  if (req.url === '/preferences' && req.method === 'POST') {
    if (budget !== null || reward) return send(409, { error: 'Stop the current run before changing settings.' })
    try {
      return send(200, preferencesView(savePreferences(preferencesFile, await body(req), policy), policy))
    } catch (e) {
      return send(400, { error: e.message })
    }
  }
  const campaign = /^\/campaigns(?:\/(O\d+))?$/.exec(req.url)
  if (req.method === 'GET' && campaign) {
    try {
      return send(200, await inspectCampaign(campaign[1]))
    } catch (e) {
      return send(503, { error: e.message })
    }
  }
  const plans = /^\/reward-plans\/(O\d+)$/.exec(req.url)
  if (req.method === 'GET' && plans) {
    try {
      const input = await campaignInputs(plans[1])
      const now = Date.now()
      const fraction = depthFraction()
      const first = planRewardQuotes({ ...input, now, budget: rewardBudgets[0], feeRate, approved, fraction })
      return send(200, {
        id: plans[1],
        name: input.name,
        band: first.band,
        minBudget: first.minBudget,
        choices: budgetChoices({ ...input, now, feeRate, approved, fraction }),
      })
    } catch (e) {
      return send(503, { error: e.message })
    }
  }
  const rewardStart = /^\/reward\/start\/(O\d+)\/(\d+)$/.exec(req.url)
  if (req.method === 'POST' && rewardStart) {
    if (budget !== null || reward) return send(409, { error: 'Stop the current run first.' })
    let plan
    try {
      const input = await campaignInputs(rewardStart[1])
      plan = planRewardQuotes({
        ...input,
        now: Date.now(),
        budget: Number(rewardStart[2]),
        feeRate,
        approved,
        fraction: depthFraction(),
      })
      if (!plan.ok) return send(409, { error: plan.blockers.map((b) => b.message).join(' ') })
      reward = {
        id: rewardStart[1],
        outcome: Number(rewardStart[1].slice(1)),
        name: input.name,
        budget: Number(rewardStart[2]),
        states: null,
      }
    } catch (e) {
      return send(503, { error: e.message })
    }
    await rewardLoop(++generation)
    return send(200, status())
  }
  if (req.method === 'POST' && req.url === '/stop') {
    stop()
    return send(200, status())
  }
  const start = /^\/start\/(\d+)$/.exec(req.url)
  if (req.method === 'POST' && start) {
    const selected = Number(start[1])
    if (!budgets.includes(selected)) return send(400, { error: 'Unsupported paper budget.' })
    if (budget !== null || reward) return send(409, { error: 'Stop the current run before changing its budget.' })
    budget = selected
    await tick(++generation)
    return send(200, status())
  }
  send(404, { error: 'Unknown runner command.' })
})

server.listen(5314, '127.0.0.1', () =>
  console.log('Paper runner ready. Open http://' + host + '/pair to pair locally.')
)
