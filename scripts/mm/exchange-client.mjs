// The one place that builds an exchange client. It makes an accidental mainnet order impossible: a mainnet client
// with a real transport needs the code switch on, a verified arming for this exact agent, and a process that is not a
// test run. A fake transport (tests, dry runs) still needs the arming and must say it is not testnet.
import { ExchangeClient, HttpTransport, WebSocketTransport } from '@nktkas/hyperliquid'
import { mainnetOrdersEnabled, networkOf } from '../../lib/mm/network.mjs'

const realTransport = (transport) => transport instanceof HttpTransport || transport instanceof WebSocketTransport
const fakeTransport = (transport) => !realTransport(transport) && typeof transport?.request === 'function'

/**
 * Arming that covers this agent: { verified: true, agent, expiresAt }, where `agent` is the agent address the owner's
 * signature was verified for (the verifyArming result plus the address it was checked against).
 */
function armed(arming, wallet, now) {
  const agent = String(arming?.agent ?? '').toLowerCase()
  return (
    arming?.verified === true &&
    /^0x[\da-f]{40}$/.test(agent) &&
    agent === String(wallet?.address ?? '').toLowerCase() &&
    Number.isFinite(arming.expiresAt) &&
    arming.expiresAt > now
  )
}

/**
 * exchangeClientFor({ network, wallet, arming, transport, now }) -> ExchangeClient.
 * testnet: the SDK's HttpTransport for testnet, or an injected transport that is not a mainnet one.
 * mainnet, real transport (none given, or an SDK Http/WebSocket transport): throws unless mainnetOrdersEnabled is on,
 *   the arming is verified for this wallet and unexpired, and NODE_TEST_CONTEXT is unset.
 * mainnet, fake transport (a plain object with `request` and isTestnet === false): needs the verified arming only.
 */
export function exchangeClientFor({ network, wallet, arming, transport, now = Date.now() } = {}) {
  const net = networkOf(network)
  if (!wallet?.address) throw Error('An agent wallet is required.')
  if (net.isTestnet) {
    if (transport === undefined)
      return new ExchangeClient({ transport: new HttpTransport({ isTestnet: true, timeout: 6000 }), wallet })
    if (!(realTransport(transport) || fakeTransport(transport))) throw Error('Unsupported transport.')
    if (transport.isTestnet === false) throw Error('A mainnet transport cannot be used on testnet.')
    return new ExchangeClient({ transport, wallet })
  }
  const real = transport === undefined || realTransport(transport)
  if (real) {
    if (!mainnetOrdersEnabled) throw Error('Mainnet orders are switched off in this build.')
    if (process.env.NODE_TEST_CONTEXT) throw Error('Mainnet orders are never sent from a test run.')
  } else if (!fakeTransport(transport)) throw Error('Unsupported transport.')
  else if (transport.isTestnet !== false) throw Error('A mainnet client needs a transport that signs for mainnet.')
  if (!armed(arming, wallet, now)) throw Error('Mainnet needs a verified, unexpired arming for this agent.')
  return new ExchangeClient({
    transport: transport === undefined ? new HttpTransport({ isTestnet: false, timeout: 6000 }) : transport,
    wallet,
  })
}
