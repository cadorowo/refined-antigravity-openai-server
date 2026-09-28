# Multi-stage Dockerfile for refined-antigravity-openai-server
# Uses official Node.js 22 Debian-slim runtime
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Enable corepack and activate specified pnpm version
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

# Copy dependency manifests
COPY package.json pnpm-lock.yaml tsconfig.json tsconfig.build.json ./

# Install all dependencies (including devDependencies for build)
RUN pnpm install --frozen-lockfile

# Copy source code and entrypoints
COPY src/ ./src/
COPY bin/ ./bin/

# Build TypeScript to dist
RUN pnpm build

# Prune devDependencies to keep image lean
RUN pnpm prune --prod

# Production stage
FROM node:22-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production \
    REFINED_AGY_HOST=0.0.0.0 \
    REFINED_AGY_PORT=8787

# Copy production artifacts from builder
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Use non-root node user provided by the base image
USER node

# Expose default HTTP port
EXPOSE 8787

# Healthcheck validating liveness via GET /healthz
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.REFINED_AGY_PORT || 8787) + '/healthz').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Start companion server
CMD ["node", "dist/bin/server.js"]
