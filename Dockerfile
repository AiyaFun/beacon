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
# 「运行设置」页的「最近更新」直接读它（2026-09-06）：standalone 只追踪 import 得到的文件，fs 读的进不来
COPY --from=builder /app/CHANGELOG.md ./CHANGELOG.md
# 主动推送脚本（2026-09-17）：部署后要在容器里跑 `npx tsx scripts/seo-push.ts --apply`。
# 首次上线时它不在镜像里，只能先 docker cp 进去——而 /app/scripts 目录当时还不存在，
# nextjs 用户又没有 /app 的写权限，于是得先 `docker exec -u root` 建目录。
# 与其每次重演这套，不如把它打进镜像。只带这一个脚本：其余 scripts/ 是开发/运维专用，
# 进运行镜像既没用又多一份暴露面。
COPY --from=builder /app/scripts/seo-push.ts ./scripts/seo-push.ts
# 插件解析器（2026-09-04）。桌面客户端执行器从 /api/ingest/executor 现取这些脚本去驱动
# 本机 Chrome —— 运行阶段是逐个 COPY 的白名单，extension/ 一直没进来，于是那个端点在生产
# 恒返回「这个安装包里没有带插件解析器文件」。真机撞到：任务领走了、浏览器起来了，卡在取脚本。
# 只拷 content/（解析器本体）与 tools/（配方执行器 recipe-run.js，2026-09-16 起桌面客户端按配方采也从
# 服务端现取它），插件的其余部分（manifest、sw.js、图标）服务端用不到。
COPY --from=builder /app/extension/content ./extension/content
COPY --from=builder /app/extension/tools ./extension/tools

USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
CMD ["node", "server.js"]
