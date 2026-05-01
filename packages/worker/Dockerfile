FROM node:20-bookworm-slim AS base
ENV PNPM_HOME=/root/.local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl ca-certificates git curl python3 python-is-python3 \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY prisma ./prisma
COPY packages/shared/package.json ./packages/shared/
COPY packages/web/package.json ./packages/web/
COPY packages/worker/package.json ./packages/worker/
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app /app
COPY . .
RUN pnpm prisma generate
RUN pnpm --filter @renews/shared build
RUN pnpm --filter @renews/worker build

FROM base AS runtime
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml /app/tsconfig.base.json ./
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/packages/worker ./packages/worker
# Install patchright Chromium + system deps for the Playwright MCP server.
# patchright ships a Chromium fork that strips CDP-level headless-detection
# signals (Runtime.enable leak, HeadlessChrome marker) — needed because stock
# headless Chromium hits Cloudflare interstitials on most price-comparison
# sites. --with-deps pulls the apt packages Chromium needs;
# PLAYWRIGHT_BROWSERS_PATH keeps the binary out of the user homedir. The
# resulting binary path is resolved at runtime by
# pipeline/research.ts#resolvePatchrightChromium and passed to @playwright/mcp
# via --executable-path.
RUN PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    node /app/packages/worker/node_modules/patchright/cli.js install --with-deps chromium \
  && rm -rf /var/lib/apt/lists/*
COPY packages/worker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "packages/worker/dist/index.js"]
