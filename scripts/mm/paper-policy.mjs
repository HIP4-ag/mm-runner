// Deterministic synthetic YES/NO book. All prices are integer cents per share.
// These bands and depth requirements are rehearsal inputs, never venue eligibility data.
const frames = [
  { bid: 48, ask: 52, low: 45, high: 55 },
  { bid: 49, ask: 53, low: 46, high: 56 },
  { bid: 50, ask: 54, low: 47, high: 57 },
  { bid: 43, ask: 55, low: 47, high: 56 },
  { bid: 49, ask: 53, low: 46, high: 56 },
]

export const budgets = [25, 50, 100]
export const frameAt = (index) => frames[index % frames.length]

export function planQuotes(book, budget, observedAt, now) {
  if (!budgets.includes(budget)) throw new Error('Choose an available paper budget.')
  if (!Number.isFinite(observedAt) || now < observedAt || now - observedAt > 6000) return []
  if (!book || ![book.low, book.bid, book.ask, book.high].every(Number.isInteger)) return []
  const { low, bid, ask, high } = book
  if (low < 1 || high > 99 || low > bid || bid >= ask || ask > high) return []

  // Buying NO at the complement of the YES ask quotes the other side using cash.
  const prices = [bid, 100 - ask]
  const shares = Math.floor((budget * 100) / (prices[0] + prices[1]))
  if (prices.some((price) => price * shares < 1000)) return []
  return prices.map((price, i) => ({ side: i === 0 ? 'YES' : 'NO', price, shares }))
}
