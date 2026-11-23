import { active, info, accountView, nameFor, prefix, targets, cancelRows, inventory } from './testnet.mjs'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
const readVenue = { info, accountView, targets }
export async function inspectRecovery(owner, target, read = readVenue) {
  const choices = await read.targets(owner)
  if (!choices.includes(target)) throw Error('The selected account is no longer available.')
  const [agents, view] = await Promise.all([read.info('extraAgents', { user: owner }), read.accountView(target)])
  return {
    choices,
    agentRows: agents.filter((a) => a.name === nameFor(a.address) && active(a)),
    orders: view.orders.filter((o) => o.cloid?.startsWith(prefix) && /^#\d+$/.test(o.coin)),
    inventory: inventory(view.balances),
  }
}
export async function revokeDevice(owner, agent, client, read = readVenue) {
  const list = await read.info('extraAgents', { user: owner })
  if (
    !list.some(
      (a) => a.address.toLowerCase() === agent.address.toLowerCase() && a.name === nameFor(agent.address) && active(a)
    )
  )
    throw Error('This device registration has changed.')
  // Reusing the named slot deregisters its old key. Its replacement has no retained secret.
  const replacement = privateKeyToAccount(generatePrivateKey()).address
  await client.approveAgent({
    agentAddress: replacement,
    agentName: agent.name + ' valid_until ' + (Date.now() + 60000),
  })
  for (let i = 0; i < 6; i++) {
    const rows = await read.info('extraAgents', { user: owner })
    if (!rows.some((a) => a.address.toLowerCase() === agent.address.toLowerCase() && active(a))) return
    await new Promise((resolve) => setTimeout(resolve, 750))
  }
  throw Error('Revocation submitted. Refresh until the old device disappears.')
}
export async function cancelRecoveryOrder(owner, target, order, client, read = readVenue) {
  const fresh = await inspectRecovery(owner, target, read)
  const row = fresh.orders.find((r) => r.oid === order.oid && r.cloid === order.cloid)
  if (row) await client.cancel({ cancels: cancelRows([row]) }, target === owner ? {} : { vaultAddress: target })
  if ((await inspectRecovery(owner, target, read)).orders.some((r) => r.oid === order.oid))
    throw Error('Cancellation is awaiting exchange confirmation.')
}

// The owner signs an ordinary approval on their wallet's signing chain. A temporary
// browser-memory agent then signs L1 cancels, including for wallets that reject the
// exchange's L1 phantom-agent domain when signing directly in the owner wallet.
export async function authorizeRecovery(owner, ownerClient, read = readVenue) {
  const wallet = privateKeyToAccount(generatePrivateKey())
  const name = nameFor(wallet.address)
  const until = Date.now() + 120000
  const agents = await read.info('extraAgents', { user: owner })
  if (agents.some((a) => a.name === name && active(a)))
    throw Error('Recovery name is occupied. Retry to generate a fresh key.')
  await ownerClient.approveAgent({ agentAddress: wallet.address, agentName: name + ' valid_until ' + until })
  for (let i = 0; i < 6; i++) {
    const rows = await read.info('extraAgents', { user: owner })
    if (rows.some((a) => a.name === name && a.address.toLowerCase() === wallet.address.toLowerCase() && active(a)))
      return { wallet, until }
    await new Promise((resolve) => setTimeout(resolve, 750))
  }
  throw Error('Recovery approval could not be confirmed. The temporary key expires automatically.')
}
