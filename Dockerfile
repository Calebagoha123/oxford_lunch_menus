# syntax=docker/dockerfile:1

# ---- deps: install production dependencies (incl. the platform sharp binary) ----
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime ----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production

# tini gives us a real init as PID 1: correct signal forwarding (so
# `docker stop` shuts the bot down cleanly) and zombie reaping.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Run unprivileged. The state dirs are created (and owned by node) so they exist
# and are writable even before the host bind-mounts overlay them at runtime.
RUN mkdir -p data auth_info_baileys && chown -R node:node /app
USER node

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "index.js"]
