# The hosted runner for "Deploy on your own Railway". Build context: the repository root.
#   docker build -f scripts/mm/hosting/Dockerfile .
# The root .dockerignore keeps env files, journals, state folders, node_modules and git out of the build context.
# It runs only the runner (scripts/mm and lib/mm), never the website. Railway variables it reads:
#   MM_OWNER       your main wallet address (required)
#   MM_AGENT_KEY   the agent key approved on the hip4.ag page (required; read once, then removed from the environment)
#   MM_TARGET             a dedicated subaccount address, strongly recommended (optional)
#   MM_WEBHOOK_URL        optional HTTPS Discord/Telegram webhook URL for hold & loss-stop alerts (read once, wiped)
#   MM_TELEGRAM_CHAT_ID   optional chat id when MM_WEBHOOK_URL is a Telegram sendMessage endpoint
#   MM_STATE_DIR          where state is kept; /data, the mounted volume (set below)
#   PORT                  set by Railway
FROM node:24-slim

ENV NODE_ENV=production \
    MM_STATE_DIR=/data \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

# Only the two libraries the runner needs, at the versions the repository locks.
RUN npm init -y >/dev/null \
 && npm install --omit=dev --no-audit --no-fund @nktkas/hyperliquid@0.33.3 viem@2.55.10 \
 && npm cache clean --force

# Only the runner code. No env file, journal or state is copied: none is in the build context, and these two
# folders hold code only.
COPY lib/mm ./lib/mm
COPY scripts/mm ./scripts/mm
RUN rm -f scripts/mm/*.test.mjs scripts/mm/*.md && rm -rf scripts/mm/hosting \
 && mkdir -p /data && chown node:node /data

# The runner runs as the image's unprivileged "node" user, never as root. The state folder must be writable by it;
# the runner says so plainly at start if it is not.
USER node

# Node is process 1 and handles SIGTERM itself: it cancels every runner order, verifies, clears the disconnect
# timer and exits 0. An uncaught error runs the same cancel and exits 1. The runner starts no child processes.
CMD ["node", "scripts/mm/testnet-runner.mjs", "--headless"]
