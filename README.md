# Beacon / 烽火台

面向创作者和内容团队的 **跨平台内容作战室**。一站式完成热点追踪、竞对监控、AI 选题、智能创作与合规检测，帮助创作者用数据驱动内容决策。

Cross-platform content operations SaaS for creators — trending topics, competitor tracking, AI-powered topic selection, smart writing, and compliance checking in one dashboard.

**在线体验**: [beacon.iyunci.cn](https://beacon.iyunci.cn)

## 这个项目能做什么

烽火台解决创作者日常面临的三个核心问题：**追什么热点、学谁的套路、怎么写得又快又合规**。

- **热榜聚合** — 实时汇聚微博、抖音、B站、知乎、小红书、百度等 20+ 平台热榜，AI 自动聚类去重，一眼看清全网在聊什么
- **竞对监控** — 跨平台追踪竞对账号（抖音、公众号、小红书、B站、YouTube、X），自动抓取新作品并分析数据表现
- **选题引擎** — 12 位 AI 人物智囊团从不同视角评审选题，结合你的人设和账号定位给出切入建议
- **创作工坊** — AI 辅助起稿、一稿多平台改写、人味评分、事实漂移检测，生成内容自动标注 AIGC 标识
- **合规检测** — 四级敏感词库 + 分平台差异规则，发布前一键扫描，避免违规
- **浏览器插件** — 一键收藏灵感素材、自有账号数据回填、竞对作品采集
- **机器人集成** — 飞书群机器人推送热点通知、支持自然语言查询

## 典型使用流程

```
1. 登录 → 绑定你的创作者账号（公众号、抖音、小红书等）
2. 首页「今日概览」查看全网热榜 + 竞对动态 + AI 推荐选题
3. 点进感兴趣的选题 → 智囊团给出多角度切入建议
4. 进入「创作工坊」→ AI 起稿 → 一键改写成各平台风格
5. 「合规检测」扫一遍 → 确认无敏感词 → 复制发布
6. 发布后数据自动回流到「数据看板」→ 分析表现 → 指导下一次选题
```

## Tech Stack

- **Web**: Next.js 15 (App Router), React 19, TypeScript, Tailwind CSS
- **Database**: SQLite (dev) / PostgreSQL + pgvector (prod), Prisma ORM
- **Queue**: BullMQ + Redis (prod) / in-process queue (dev)
- **LLM**: Any OpenAI-compatible endpoint (DeepSeek, Qwen, MiniMax, etc.)
- **Extension**: Chrome Manifest V3

## Quick Start

```bash
# Clone and install
git clone https://github.com/AiyaFun/beacon.git
cd beacon
npm install

# Copy env template — zero config needed for dev
cp .env.example .env

# Initialize database and start
npm run setup
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Dev mode uses mock data for everything — no API keys, no Redis, no Postgres needed.

## Production Deployment

### Prerequisites

- A Linux server (Ubuntu 20.04+ / CentOS 7+ recommended)
- Docker & Docker Compose v2
- A domain name with DNS pointed to your server
- SSL certificate for HTTPS (Let's Encrypt or your own)
- PostgreSQL 15+ with pgvector extension (self-hosted or managed, e.g. Supabase)

### Step 1: Clone and configure

```bash
git clone https://github.com/AiyaFun/beacon.git
cd beacon
cp .env.production.example .env.production
chmod 600 .env.production
```

Edit `.env.production` — the file is heavily commented with explanations for each variable. At minimum, fill in:

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string with `?schema=beacon` |
| `BEACON_MASTER_KEY` | Yes | Encryption key for user API keys. Generate: `openssl rand -base64 48` |
| `BEACON_SMS_VENDOR` | Yes | `"volcengine"` for China SMS, or implement your own provider |
| `BEACON_DEFAULT_LLM_*` | Yes | Any OpenAI-compatible LLM endpoint (DeepSeek, Qwen, MiniMax, etc.) |
| `BEACON_TRUSTED_PROXY_HOPS` | Yes | Number of reverse proxies in front of the app (default `"1"` for the built-in Nginx) |

### Step 2: Initialize database

```bash
# Set Redis password
export REDIS_PASSWORD="$(openssl rand -hex 32)"

# First-time database setup (creates tables, pgvector extension, and RLS policies)
DATABASE_URL="your-connection-string" bash scripts/db-init-supabase.sh
```

### Step 3: Deploy with Docker Compose

```bash
docker compose up -d --build
```

This starts 4 services:
- **proxy** — Nginx reverse proxy (ports 80/443)
- **web** — Next.js app server (internal only, port 3000)
- **worker** — BullMQ background job processor
- **redis** — Job queue and rate limiting

### Step 4: Verify

```bash
# Check all containers are running
docker compose ps

# Health check
curl -s https://your-domain.com/api/health | jq .

# Send a test SMS verification code on the login page
```

### SSL Certificates

Place your certificate files and run:

```bash
bash deploy/cert.sh
```

Or use Let's Encrypt with certbot before starting the containers.

### Updating

```bash
git pull
docker compose up -d --build redis web worker
```

## Extension

The browser extension lives in `extension/`. Load it as an unpacked extension in Chrome:

1. Go to `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked" → select the `extension/` directory

## Secret Prevention

This repo includes a pre-commit hook that blocks commits containing API keys, passwords, and other secrets.

```bash
# Enable the hook (one-time setup)
git config core.hooksPath .githooks
```

## License

This project is dual-licensed:

- **Open Source**: [AGPL-3.0](LICENSE) — free for personal and non-commercial use. You must retain the original author attribution and copyright notice, and share any modifications under the same license.
- **Commercial**: A separate commercial license is available for paid SaaS deployment, private resale, or closed-source use. See [COMMERCIAL_LICENSE.md](COMMERCIAL_LICENSE.md) for details.

For commercial licensing inquiries: jiangwenhuang@iyunci.cn
