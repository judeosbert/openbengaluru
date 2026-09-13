# simo-player on Railway: one container serves the built app AND the
# simulation API (node server.js honours Railway's injected $PORT).
# SUMO comes from Debian's repo (findSumo() falls back to bare `sumo`
# on PATH) — bookworm's package is older than a local Eclipse SUMO but
# runs the pack_run pipeline fine.
FROM node:20-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends sumo \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY . .
RUN npm run build

# Set AFTER npm ci so devDependencies (vite) stay installed for the build.
ENV NODE_ENV=production

CMD ["node", "server.js"]
