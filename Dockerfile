# 烽火台生产镜像（Next.js standalone + Prisma）。多阶段构建。
FROM node:20-slim AS base
# zip：构建期 npm run build → scripts/pack-extension.ts 用它打包采集助手 zip（slim 镜像默认没有）。
RUN apt-get update -y && apt-get install -y openssl ca-certificates zip && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ── 依赖 ──
FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci

# ── 构建 ──
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# 用 Postgres schema 生成 client
RUN cp prisma/schema.postgres.prisma prisma/schema.prisma && npx prisma generate
RUN npm run build

# ── 运行 ──
FROM base AS runner
ENV NODE_ENV=production
ENV BEACON_ENV=prod
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

# Next standalone 产物
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# 完整 node_modules（worker 需要 tsx + bullmq + ioredis 等）
COPY --from=deps /app/node_modules ./node_modules
# Prisma 生成产物覆盖 deps 的原始版本
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
# Worker 源码 + 依赖的 lib
COPY --from=builder /app/worker.ts ./
COPY --from=builder /app/lib ./lib
COPY --from=builder /app/tsconfig.json ./
COPY --from=builder /app/prisma ./prisma

USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
CMD ["node", "server.js"]
