FROM node:24-bookworm-slim AS deps

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable \
  && corepack pnpm install --frozen-lockfile

FROM deps AS build

COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
COPY migrations ./migrations
RUN corepack pnpm typecheck

FROM node:24-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
COPY tsconfig.json ./

RUN mkdir -p /app/.data /app/data/agentcash-homes \
  && chown -R node:node /app

USER node

EXPOSE 3000 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HEALTH_PORT||3001)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["corepack", "pnpm", "start"]
