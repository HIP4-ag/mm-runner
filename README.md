# hip4.ag market maker runner

A small program that rests bids on Hyperliquid HIP-4 outcome markets with your own settings, sells any shares a fill
leaves behind, and sells what is left before each game starts. It runs on your own Railway service (the product) or
on your own computer (a developer tool).

It is a rewards tool with real loss risk. Rewards are not promised, may be zero, are shared among everyone quoting,
and can be smaller than trading losses. The reward operator decides what counts as organic activity and may pay
nothing. No setting is recommended: every value is yours to choose inside fixed limits.

Mainnet orders are switched off in this build (`mainnetOrdersEnabled` in `lib/mm/network.mjs`). With the switch off,
a hosted runner starts, pairs, shows settings, preview and status, and refuses Start and Arm with a plain message.

## What it does

- **Bids.** One post-only bid per side on each market you choose, behind the best bid and never at it, at the depth
  you set inside the reward band. It never trades to make volume. A sell exists only to exit shares a fill left.
- **After a fill.** No new bid on that side. The shares are offered at cost plus fees. From an hour before the start
  the offer moves toward a floor, never below it.
- **Before the start.** New bids stop at your bid stop, and in any case 20 minutes before the start (60 for soccer and
  esports). At 6 minutes (15) it sells what is held with an immediate order at the best bid, and at 2 minutes (5) at a
  floor of half a trusted recent price. It sells only into a two-sided book with a tight spread, never below the
  floor and never more than it holds. If the book is empty or broken it sells nothing and shows "Sell by hand before
  the start". Resting orders are cancelled 90 seconds before the start; nothing is sent from one minute before it.
  Nothing is ever quoted in play.
- **Stops that keep selling.** "Stop bidding, keep selling", your daily and hourly loss stops, the hourly action
  allowance, the exchange's per-address limit, rate limits (429), repeated errors, the end of the session, your
  quoting hours, a reward rollover and a lost price feed all stop new bids only. Held shares are still offered and
  sold before the start.
- **Stops that stop everything.** A position record that does not match the account, a foreign order on the
  account, an order status the exchange cannot confirm, a lost agent or builder approval, or a disconnect timer that
  cannot be armed. Every order is cancelled and every held leg shows a hold.
- **Requests.** Books come from the websocket feed, subscribed strictly to currently selected and inventory-held markets only (never the whole catalog), with REST reads only as a fallback. Every exchange action is
  counted against an hourly allowance, cancels go in batches of at most 200, and a rate limit backs off
  without ever ending the run.
- **Sizing & weights.** Users choose their own per-side size ($27 to $250, neutral default $30 so whole-share rounding clears Monarch's $50 combined in-band notional floor), sport family weights (0 to 3, neutral default 1), and selection weights (reward pool, time to start, band width).
- **Fees.** Every order carries the builder code. Buys pay the builder fee; sells pay the exchange fee and the
  builder fee. The fee you pay is shown on the page.

## Hosted on Railway

See [HOSTING.md](HOSTING.md): what you set (use **Asia-Southeast / Singapore** for ~70 ms latency to Hyperliquid Tokyo and fund a dedicated subaccount via `MM_TARGET`), what the agent key can and cannot do, how to stop, and
what a restart does. `Dockerfile` is the deploy image definition.

```
node scripts/mm/testnet-runner.mjs --headless
```

reads `MM_OWNER`, `MM_AGENT_KEY` (read once, then removed from the environment), optional `MM_TARGET` and
`MM_STATE_DIR`, and binds `0.0.0.0:$PORT`. A hosted runner is mainnet only and answers the hip4.ag page only.

## First run

There is no practice step for users, so keep the first run small: the smallest size per side, one market, a short
session. Watch the first fill and its exit before changing anything.

## Developer: run it on this computer

Use Node 24 or later and install with `npm ci --legacy-peer-deps`. The local runner defaults to Hyperliquid testnet.

```powershell
npm run mm:testnet -- <owner address> [subaccount address] [--state-dir <dir>]
```

It binds 127.0.0.1:5315, keeps one agent key per network in the operating system credential store, and pairs with a
one-time code from `http://127.0.0.1:5315/pair` signed by the owner wallet. Run the page on port 5004:

```powershell
node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port 5004
```

State lives in `~/.hip4-ag/mm` (or `--state-dir` / `MM_STATE_DIR`): `preferences.json`, `operator.json`, and one
folder per network with the journal (`<owner>-<target>.sqlite`), the action count and, for mainnet, `arming.json`.
A lock file allows one runner process per account and state folder.

The paper runner (`npm run mm:paper`) is a dry run for one market with no exchange path.

## Tests

```powershell
node --test scripts/mm/*.test.mjs
npx jest tests/mm
```

Every engine test runs against a fake venue in simulated time with real SDK signing. No test sends anything to a
network, and the exchange client refuses a real mainnet transport while the switch is off or under a test run.
