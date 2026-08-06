# Beacon / 烽火台

Cross-platform content operations SaaS for creators. Monitor trending topics, track competitor content, and generate optimized drafts — all from one dashboard.

**Live Demo**: [beacon.iyunci.cn](https://beacon.iyunci.cn)

## Features

- **Trending Topics** — Aggregates hot topics from 20+ Chinese and global platforms in real-time
- **Competitor Monitoring** — Track competitor accounts across Douyin, WeChat, Xiaohongshu, Bilibili, YouTube, X
- **AI Writing Workshop** — Generate platform-optimized drafts with humanization scoring and fact-drift detection
- **Browser Extension** — One-click content collection, inspiration clipping, and data backfill
- **Multi-account Dashboard** — Unified analytics across all your creator accounts
- **Bot Integration** — Feishu/Lark bot for team notifications and conversational queries

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

For commercial licensing inquiries: wenhuang1006@gmail.com
