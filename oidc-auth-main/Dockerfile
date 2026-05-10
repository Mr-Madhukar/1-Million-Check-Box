# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:18-alpine AS builder

# Install pnpm
RUN npm install -g pnpm

WORKDIR /app

# Copy dependency manifests first (layer cache)
COPY package.json pnpm-lock.yaml ./

# Install ALL deps (including devDeps needed for tsc)
RUN pnpm install --frozen-lockfile

# Copy source
COPY . .

# Compile TypeScript → dist/
RUN pnpm exec tsc --project tsconfig.json

# ── Stage 2: Production image ─────────────────────────────────────────────────
FROM node:18-alpine

RUN npm install -g pnpm

WORKDIR /app

# Copy only what's needed to run
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# Copy compiled output and required runtime assets
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/drizzle.config.js ./drizzle.config.js
COPY --from=builder /app/cert ./cert
COPY --from=builder /app/public ./public

EXPOSE 8000

# Run DB migration then start server
CMD ["npm", "run", "start:prod"]
