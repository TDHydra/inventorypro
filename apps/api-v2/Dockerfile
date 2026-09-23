# api-v2 — runs TypeScript directly via tsx (a production dependency).
#
# No build stage: api-v2 deep-imports @invenpro/core as TS SOURCE
# (packages/core has no "exports"/dist — its main IS src/index.ts), so a tsc
# emit would need core compiled too for nothing. tsx resolves and transpiles
# both packages at boot; the migration .sql files ride along inside src/db/.
FROM node:20-alpine
WORKDIR /app
RUN npm install -g pnpm

# Workspace manifests + lockfile from the monorepo root (build context = root).
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api-v2/package.json ./apps/api-v2/
COPY packages/core/package.json ./packages/core/

# Prod deps only. core's devDeps (react, sql.js, …) are skipped — api-v2 only
# imports its manifest modules, which are dependency-free TS.
RUN pnpm install --frozen-lockfile --prod --filter api-v2...

COPY packages/core/src ./packages/core/src
COPY apps/api-v2/src ./apps/api-v2/src
COPY apps/api-v2/tsconfig.json ./apps/api-v2/

EXPOSE 3000
WORKDIR /app/apps/api-v2
CMD ["./node_modules/.bin/tsx", "src/index.ts"]
