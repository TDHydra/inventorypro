FROM node:20-alpine AS builder
WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy workspace manifests + lockfile from monorepo root
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json ./apps/api/

# Install all deps (workspace-aware, uses root lockfile)
RUN pnpm install --frozen-lockfile --filter api...

# Copy API source and build
COPY apps/api ./apps/api
RUN cd apps/api && pnpm build

# --- Production image ---
FROM node:20-alpine AS runner
WORKDIR /app
RUN npm install -g pnpm

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json ./apps/api/

RUN pnpm install --frozen-lockfile --prod --filter api...

COPY --from=builder /app/apps/api/dist ./apps/api/dist

EXPOSE 3000
CMD ["node", "apps/api/dist/index.js"]
