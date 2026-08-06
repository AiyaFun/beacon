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

See `.env.production.example` for the full production configuration template. The project ships with `docker-compose.yml` for container deployment.

```bash
cp .env.production.example .env.production
# Fill in your real credentials, then:
docker compose up -d --build
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
