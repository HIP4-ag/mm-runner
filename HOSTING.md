# Running the market maker on your own Railway

This runner places and cancels orders on Hyperliquid HIP-4 outcome markets for you, on your own Railway account.
It is a rewards tool with real loss risk. Rewards are not promised, may be zero, are shared with everyone quoting,
and can be smaller than your trading losses. The reward operator decides what counts as organic activity and may
pay nothing. Every setting is your own choice; none is recommended.

Mainnet orders are switched off in this build. Until a later release turns them on, the runner starts, pairs, shows
your settings, preview and status, and answers Start and Arm with "mainnet orders are not enabled in this build".

## What you do

1. On the hip4.ag page, read the risk statement and tick the acknowledgement.
2. Connect your main wallet and approve a new agent key. The page shows the key once. Copy it.
3. Press Deploy on Railway. The deploy link pre-fills `MM_OWNER` (and `MM_TARGET` if you picked a subaccount), `railway.json` pins **Asia-Southeast (Singapore / `asia-southeast1-eqsg3a`)** for ~70 ms latency to Hyperliquid Tokyo (vs 450 to 550 ms from US regions), and the template attaches the `/data` volume with `RAILWAY_RUN_UID=0`. Variables:
   - `MM_OWNER`: your main wallet address (pre-filled by the deploy button).
   - `RAILWAY_RUN_UID`: set to `0`. Railway mounts the state volume for the root user, and the runner must be able to write to it. The template sets this for you.
   - `MM_AGENT_KEY`: the agent key from step 2 (paste manually; never passed in URLs).
   - `MM_TARGET` (strongly recommended): the address of a **dedicated Hyperliquid subaccount** funded only with the capital you are willing to risk for market making. Running from a dedicated subaccount ring-fences your main account balance from quoting losses or stuck inventory.
   - `MM_WEBHOOK_URL` (optional): HTTPS Discord webhook URL, Telegram Bot `sendMessage` URL (pair with `MM_TELEGRAM_CHAT_ID`), or generic JSON webhook URL. Sends deduplicated phone alerts if a market enters `"Sell by hand before the start"`, hits a loss stop, or needs review. Read once and wiped from the environment like `MM_AGENT_KEY`.
   Attach one small volume at `/data` (the template does).
   Railway bills your account for the service, about $5 a month.
4. Copy the service's public URL from Railway and paste it into the page once.
5. On the page, type a pairing code of your own and sign the pairing message with your main wallet. The runner
   pairs only with that wallet's signature. It shows no code to anyone.
6. Set your strategy, check the preview (opening cost and worst one-leg loss), and start.

## First run

There is no practice network in the product, so make the first run small:

- the smallest size the exchange accepts per side, one market, a short session;
- watch the first fill: the runner stops bidding on that side and offers the shares back at cost plus fees;
- watch the exit: the offer fills, or before the game it is sold at or above a floor, or the page tells you to sell
  by hand;
- only then change sizes or add markets.

## What the agent key can and cannot do

- It can place and cancel orders on your account, including the subaccount you set.
- It cannot withdraw or transfer funds.
- It sits in your own Railway variables. Anyone with access to your Railway account can trade your account with it.
- hip4.ag never holds it.
- Revoke it any time from the API page of the Hyperliquid app. A revoked key can do nothing.

## How to stop

- "Stop bidding, keep selling" on the page: no new bids; held shares are still offered and sold before the game.
- "Stop everything" on the page: every order is cancelled, including the offers for shares you hold. You then sell
  those by hand.
- Removing or pausing the service in Railway: Railway sends a stop signal. The runner cancels every one of its orders,
  checks that none rest, clears the exchange's disconnect timer and exits.
- An unexpected error inside the runner runs the same cancel before the process exits, and counts as a crash.
- If the process dies without a clean stop, the exchange's disconnect timer cancels resting orders within five
  minutes. Shares you hold stay in the account.

## What a restart does

On every start the runner cancels all of its own orders, settles fills that happened while it was down and checks
its position record against the account.

- If they match, it resumes the saved run.
- If they do not match, it bids nothing and sells nothing, shows a hold for every leg you hold, and the health check
  says "needs review". Sell by hand or contact support.
- After three crashes inside ten minutes it starts in safe mode: no new bids, only selling what is held, until a clean
  restart.

## Health

`GET /health` needs no login and shows no address, key or setting: whether a run is going, whether bids are stopped,
how many holds there are, when the loop last ran, and whether the price feed is connected.
