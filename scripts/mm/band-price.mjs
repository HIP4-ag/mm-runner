// Band-fraction bid pricing. Pure functions, no network.
// Prices are numbers in (0,1). Leg 0 is YES, leg 1 is NO (the NO token price). The scoring band is expressed on the
// YES price: low = logistic(logit(mid) - width), high = logistic(logit(mid) + width).

export const tick = 1e-5
const edge = 1e-9
const margin = 1e-12
// A bid never rests closer to the mid than 15% of the band half-width, nor further than 60%: the depth hard range.
export const fractionRange = [0.15, 0.6]

const fixed = (price) => Number(price.toFixed(5))

export const logit = (p) => Math.log(p / (1 - p))
export const logistic = (x) => 1 / (1 + Math.exp(-x))
export const floorTick = (p) => fixed(Math.floor(p / tick + edge) * tick)
export const ceilTick = (p) => fixed(Math.ceil(p / tick - edge) * tick)

/** Half-width of the scoring band in logit units. Same formula as campaign-bands.mjs bandSnapshot. */
export const bandWidth = ({ spreadCents, multiplier = 1 }) => logit(0.5 + spreadCents / 200) * multiplier

/** At most +-1c at any mid, which matches today's testnet band check. */
export const testnetWidth = bandWidth({ spreadCents: 2 })

/**
 * The two post-only bids one market gets at a fraction of the band half-width, or the reasons a leg is skipped.
 * legs: [{ bestBid, bestAsk }, { bestBid, bestAsk }] in each leg's own price. For paper, derive legs[1] from the YES
 * book: { bestBid: 1 - yesAsk, bestAsk: 1 - yesBid }.
 * Returns { prices: [yes|null, no|null], skipped: [{ leg, code, message }], low, high } with low and high on the YES price.
 */
export function bandFractionBids({ mid, width, fraction, legs, tick: step = tick }) {
  if (!(fraction >= fractionRange[0] && fraction <= fractionRange[1]))
    throw Error(`Band fraction must be between ${fractionRange[0]} and ${fractionRange[1]}.`)
  if (!(mid > 0 && mid < 1) || !(width > 0)) throw Error('A midpoint inside (0,1) and a positive band width are required.')

  const low = logistic(logit(mid) - width)
  const high = logistic(logit(mid) + width)
  const targets = [
    floorTick(logistic(logit(mid) - fraction * width)),
    floorTick(1 - logistic(logit(mid) + fraction * width)),
  ]
  const prices = [null, null]
  const skipped = []

  targets.forEach((target, leg) => {
    const { bestBid, bestAsk } = legs[leg] ?? {}
    let price = target
    // Always behind the touch.
    if (Number.isFinite(bestBid) && target >= bestBid - margin) price = floorTick(bestBid - step)
    // The YES-equivalent of this price must be strictly inside the band.
    const yesSide = leg === 0 ? price : 1 - price
    if (!(price > 0 && yesSide > low + margin && yesSide < high - margin)) {
      skipped.push({ leg, code: 'touch', message: 'The price behind the best bid falls outside the scoring band.' })
      return
    }
    if (Number.isFinite(bestAsk) && !(price < bestAsk - margin)) {
      skipped.push({ leg, code: 'cross', message: 'The price would not rest below the best ask.' })
      return
    }
    prices[leg] = price
  })

  return { prices, skipped, low, high }
}

/**
 * Logit distance of a resting bid from the mid, as a fraction of the band half-width.
 * leg 0: YES bid price. leg 1: NO bid price (its YES-equivalent is 1 - px).
 */
export function slotFraction(px, leg, { mid, width }) {
  const distance = leg === 0 ? logit(mid) - logit(px) : logit(1 - px) - logit(mid)
  return distance / width
}
