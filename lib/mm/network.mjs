// Which Hyperliquid network a run talks to. Browser-safe: plain data and two small functions, no Node imports.
// The runner takes the network from a /start request, never from an environment variable or a file.
export const networks = Object.freeze({
  testnet: Object.freeze({
    name: 'testnet',
    isTestnet: true,
    infoUrl: 'https://api.hyperliquid-testnet.xyz/info',
    exchangeUrl: 'https://api.hyperliquid-testnet.xyz/exchange',
    wsUrl: 'wss://api.hyperliquid-testnet.xyz/ws',
    campaigns: null,
  }),
  mainnet: Object.freeze({
    name: 'mainnet',
    isTestnet: false,
    infoUrl: 'https://api.hyperliquid.xyz/info',
    exchangeUrl: 'https://api.hyperliquid.xyz/exchange',
    wsUrl: 'wss://api.hyperliquid.xyz/ws',
    campaigns: 'https://api.monarch.fast/marina/outcome-markets/current-incentives',
  }),
})

// Orders on mainnet stay off until a reviewed code change flips this, after the owner says so in words.
export const mainnetOrdersEnabled = false

/** The network record for 'testnet' or 'mainnet'. A record from `networks` is returned as it is. Anything else throws. */
export function networkOf(name) {
  const key = typeof name === 'object' && name !== null ? name.name : name
  if (key !== 'testnet' && key !== 'mainnet') throw Error('Choose testnet or mainnet.')
  return networks[key]
}
