[中文](README.md) · 🌐 English

<h1 align="center">Beacon</h1>

<p align="center">A data-driven, cross-platform command center for content creators.</p>

<p align="center">
  <a href="https://github.com/AiyaFun/beacon"><img src="https://img.shields.io/badge/Platform-SaaS-blue" alt="Platform"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-green" alt="License"></a>
  <a href="https://beacon.iyunci.cn"><img src="https://img.shields.io/badge/Demo-beacon.iyunci.cn-orange" alt="Demo"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-20+-339933" alt="Node"></a>
</p>

<p align="center">
  A multi-platform content planning SaaS for creators and content teams.<br>
  Trending Aggregation · Competitor Monitoring · AI Topic Advisory · Multi-Platform Rewriting · Compliance Check · Analytics Dashboard.
</p>

<p align="center">
  Maintainer: <a href="https://github.com/AiyaFun">AiyaFun</a>
</p>

<p align="center">
  <a href="#what-problem-does-it-solve">What It Solves</a> ·
  <a href="#who-is-it-for">Who It's For</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#production-deployment">Deployment</a> ·
  <a href="#tech-stack">Tech Stack</a> ·
  <a href="#license">License</a>
</p>

---

## What Problem Does It Solve

Creators face three daily challenges: **What's trending? What are competitors doing? How to write fast while staying compliant?**

Beacon brings all three into one platform so you don't have to juggle a dozen apps.

| Feature | Description |
|---|---|
| **Trending Aggregation** | Real-time trending topics from Weibo, Douyin (TikTok CN), Bilibili, Zhihu, Baidu, YouTube, etc. with AI-powered clustering and deduplication |
| **Competitor Monitoring** | Cross-platform competitor tracking (Douyin, WeChat Official Accounts, Xiaohongshu, Bilibili, YouTube, X) with automatic content scraping and analytics |
| **Topic Engine** | A panel of 12 AI personas reviews topics from different angles, tailored to your creator profile |
| **Writing Workshop** | AI-assisted drafting, one-click multi-platform rewriting, humanness scoring, fact-drift detection, automatic AIGC labeling |
| **Compliance Check** | 4-tier sensitive word library with per-platform rules — scan before you publish |
| **Browser Extension** | One-click inspiration clipping, self-account data sync, competitor content collection |
| **Bot Integration** | Feishu (Lark) group bot for trending alerts and natural language queries |
| **Analytics Dashboard** | Unified multi-account dashboard with trend analysis and weekly reports |

## Who Is It For

- **Solo Creators** — Managing multiple platform accounts, need efficient trend tracking and content production
- **Content Teams** — MCN / brand content ops teams needing unified monitoring and collaboration
- **Social Media Managers** — Corporate social media roles needing competitor analysis and data-driven topic selection
- **Indie Developers** — Want to build your own content tools on top of this project

## Typical Workflow

```
1. Sign in → Link creator accounts (WeChat, Douyin, Xiaohongshu, etc.)
2. Home "Today's Overview": trending topics + competitor activity + AI-recommended topics
3. Tap a topic → AI advisory panel gives multi-angle entry suggestions
4. Enter "Writing Workshop" → AI draft → one-click rewrite for each platform's style
5. Run "Compliance Check" → confirm no sensitive words → copy & publish
6. Post-publish data flows back → analyze performance → inform next topic
```

## Tech Stack

| Layer | Technology |
|---|---|
| **Frontend** | Next.js 15 (App Router), React 19, TypeScript, Tailwind CSS |
| **Backend** | Next.js Server Actions + API Routes (Node.js) — no separate backend service |
| **Database** | SQLite (dev) / PostgreSQL + pgvector (prod), Prisma ORM |
| **Task Queue** | BullMQ + Redis (prod) / in-process queue (dev) |
| **LLM** | Any OpenAI-compatible endpoint (DeepSeek, Qwen, MiniMax, Kimi, GLM, etc.) |
| **Browser Extension** | Chrome Manifest V3 |
| **Containerization** | Docker Compose (Nginx + Web + Worker + Redis) |
| **Auth** | SMS OTP + WeChat OAuth (optional) |
| **Payment** | WeChat Pay Native (optional) |

## Quick Start

```bash
git clone https://github.com/AiyaFun/beacon.git
cd beacon
npm install
cp .env.example .env
npm run setup
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). In development mode all external dependencies are mocked — **no API keys, no Redis, no PostgreSQL required**. Works out of the box.

## Production Deployment

### Prerequisites

| Requirement | Details |
|---|---|
| Linux Server | Ubuntu 20.04+ or CentOS 7+ |
| Docker & Compose v2 | Container orchestration |
| Domain + DNS | Pointed to your server |
| SSL Certificate | Let's Encrypt or your own |
| PostgreSQL 15+ | pgvector extension required (self-hosted or managed) |

### Step 1: Configuration

```bash
git clone https://github.com/AiyaFun/beacon.git
cd beacon
cp .env.production.example .env.production
chmod 600 .env.production
```

Edit `.env.production`. Every variable has detailed comments. Required variables:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string with `?schema=beacon` |
| `BEACON_MASTER_KEY` | Encryption master key. Generate: `openssl rand -base64 48` |
| `BEACON_SMS_VENDOR` | SMS provider, set to `"volcengine"` |
| `BEACON_VOLC_SMS_AK/SK` | VolcEngine SMS AccessKey |
| `BEACON_DEFAULT_LLM_*` | LLM endpoint + API key |
| `BEACON_TRUSTED_PROXY_HOPS` | Reverse proxy layers, default `"1"` |

### Optional Features

These are not required for core functionality:

| Feature | Variables | Without It |
|---|---|---|
| **WeChat OAuth** | `BEACON_WECHAT_APPID` + `SECRET` | SMS-only login |
| **WeChat Pay** | `BEACON_PAY_VENDOR="wxpay"` + merchant keys | Paid features unavailable |
| **Competitor Data** | `BEACON_TIKHUB_KEY`, `BEACON_YOUTUBE_API_KEY`, etc. | Mock data for those platforms |
| **Vector Embeddings** | `BEACON_EMBED_*` | Falls back to keyword matching |
| **Feishu Bot** | Configure in `/settings` | No push notifications |
| **Sentry** | `BEACON_SENTRY_DSN` | Local logs only |

### Step 2: Initialize Database

```bash
export REDIS_PASSWORD="$(openssl rand -hex 32)"
DATABASE_URL="your-connection-string" bash scripts/db-init-supabase.sh
```

### Step 3: Launch

```bash
docker compose up -d --build
```

| Service | Role |
|---|---|
| **proxy** | Nginx reverse proxy (public ports 80/443) |
| **web** | Next.js application (internal only) |
| **worker** | BullMQ background tasks |
| **redis** | Queue + rate limiting |

### Step 4: Verify

```bash
docker compose ps
curl -s https://your-domain.com/api/health | jq .
```

### Updating

```bash
git pull
docker compose up -d --build redis web worker
```

## Browser Extension

1. Open `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked" → select the `extension/` directory

## Security & Compliance

### Security Measures

This project implements multiple layers of security protection:

| Layer | Mechanism |
|---|---|
| **Secret Isolation** | All secrets, API keys, and server IPs are injected via `.env.production`, never in source code |
| **Clean Git History** | Open-source branch is an orphan branch — no secrets or internal configs in history |
| **Pre-commit Hook** | Scans for 10 secret patterns (SK-/AKIA/AKLT/PEM/password assignments/connection strings/AppIDs, etc.) and blocks commits |
| **GitHub Push Protection** | Repository-level secret scanning blocks known secret formats on push |
| **Row Level Security** | PostgreSQL RLS enabled on all tables — tenant data is physically isolated |
| **Reverse Proxy Lockdown** | Production web port binds to 127.0.0.1 only; only Nginx exposes ports 80/443 |
| **XFF Anti-Spoofing** | Reverse proxy overwrites X-Forwarded-For to prevent rate-limit bypass via direct connection |
| **Encrypted Storage** | Third-party credentials encrypted at rest with BEACON_MASTER_KEY (AES), never stored in plaintext |
| **CSRF / Cookie** | Login cookies enforce Secure + HttpOnly + SameSite=Lax |
| **Rate Limiting** | SMS and API endpoints rate-limited by IP + user dimensions to prevent abuse |

Enable the pre-commit hook:

```bash
git config core.hooksPath .githooks
```

### Compliant Data Collection

All data collection in Beacon follows transparent, compliant practices:

| Principle | Implementation |
|---|---|
| **User-Initiated Only** | All data collection is triggered by the user, never automated scraping in the background |
| **Official APIs First** | Competitor monitoring prefers official APIs (YouTube Data API, RSSHub) over page scraping |
| **Browser Extension Consent** | The extension only activates when the user explicitly clicks; no silent data harvesting |
| **Rate Limiting & Throttling** | Built-in request throttling to respect platform rate limits and terms of service |
| **Privacy Policy Disclosure** | Extension privacy policy fully discloses data collected, stored, and transmitted |
| **Data Minimization** | Only collects publicly available content metadata; does not scrape private or login-gated data |
| **Right to Delete** | Users can request full data deletion; account removal wipes all collected data with cryptographic verification |
| **No Credential Harvesting** | The extension never reads, stores, or transmits platform login credentials |

## License

This project is dual-licensed:

- **Open Source**: [AGPL-3.0](LICENSE) — Free for personal and non-commercial use. Attribution required. Modifications must be open-sourced under the same license.
- **Commercial**: Paid SaaS, private deployment for sale, or closed-source use requires a commercial license. See [COMMERCIAL_LICENSE.md](COMMERCIAL_LICENSE.md).

Commercial licensing inquiries: jiangwenhuang@iyunci.cn
