[中文](README.md) · 🌐 English

<h1 align="center">Beacon</h1>

<p align="center">A data-driven, cross-platform command center for content creators.</p>

<p align="center">
  <a href="https://beacon.iyunci.cn">👉 Live Demo</a>
</p>

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
  <a href="#not-supported-yet--in-progress">Not Supported Yet</a> ·
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
| **Competitor Monitoring** | Cross-platform competitor tracking (Douyin, Xiaohongshu, Bilibili, YouTube, X, TikTok) with automatic content scraping and analytics. **For WeChat Official Accounts / Channels see "Not Supported Yet" below** |
| **Topic Engine** | A panel of 12 AI personas reviews topics from different angles, tailored to your creator profile |
| **Writing Workshop** | AI-assisted drafting, one-click multi-platform rewriting, humanness scoring, fact-drift detection, automatic AIGC labeling |
| **Compliance Check** | 4-tier sensitive word library with per-platform rules — scan before you publish |
| **Browser Extension** | One-click inspiration clipping, self-account data sync, competitor content collection (**never touches the WeChat Official Account back office** — see below) |
| **Bot Integration** | Feishu (Lark) group bot for trending alerts and natural language queries |
| **Analytics Dashboard** | Unified multi-account dashboard with trend analysis and weekly reports |
| **One-Click Publishing** | WeChat Official Accounts go through the official API (drafts only by default); for Douyin / Xiaohongshu / Bilibili / WeChat Channels the extension fills the back-office form and **stops before the publish button** — you press it |
| **AI Assistant & Agent** | An assistant reachable from every page; switch on "execute" and it can create drafts, add competitors and so on — **every write and every paid call is confirmed step by step** |
| **Workflow Templates** | Chain multi-step routines (topic → draft → rewrite → compliance) into a template; install one, run it, and every step reports its own result |
| **AI Covers & Illustrations** | Covers at each platform's aspect ratio (16 structured styles plus your own portrait library); in-article illustrations never carry text. Both explicit and embedded AIGC markers |
| **Reader Voice** | Collects comments on your own posts and on competitors', feeding them back as topic evidence and gap analysis |
| **Growth Tracking** | Daily follower/engagement snapshots and trends for your accounts and for competitors — a metric a platform does not expose stays blank instead of being recorded as 0 |

## What's New (August 2026)

This round fills in everything that happens *after* the draft is written. The system used to hand
you a finished piece and stop; pasting, publishing and collecting the results were all on you.

- **One-click publishing**: builds a cross-platform publishing plan. WeChat Official Accounts go
  through the official API into the draft box (mass-send is a separate, explicit opt-in — we don't
  make irreversible calls for you); for Douyin / Xiaohongshu / Bilibili / WeChat Channels the
  extension fills title, body and hashtags into the creator back office and **stops before the
  publish button**; YouTube / X / TikTok are labelled "manual" with the actual reason (needs the
  video file / needs a paid API tier / needs a business entity) rather than pretending to support
  them. "Filled into the back office" and "published" stay two different words.
- **AI agent**: the assistant can now call registered tools on your behalf. Every write and every
  paid call is confirmed step by step, and a run aborts outright when no real model is configured —
  a mock would happily answer "done, I've taken care of it," which is worse than doing nothing.
- **Workflow templates**: installable multi-step routines; each step reports its own result, and
  the ones that cost money say so up front.
- **AI cover studio and in-article illustrations**: covers at each platform's ratio, with a
  reusable portrait and style library. Covers carry a visible watermark plus embedded provenance
  metadata; in-article illustrations never render text.
- **Self-healing parsers**: when a platform redesign breaks collection, the extension uploads only
  a **redacted structural skeleton** (numbers become NUM, long CJK runs become CJK, attribute names
  only). Selectors proposed by the model are candidates — a human has to adopt them before they
  take effect.
- **Platform ops console**: cross-tenant plans and status, platform AI providers and budgets,
  parser rule adoption — every action audited.
- **One page for keys**: model providers, image generation, publishing credentials, collection
  tokens and bot secrets in one place, with a **side-effect-free** connectivity check (no test
  messages sent, no images actually generated; webhook-only bots are honestly marked "can't test").

## Removed: WeChat Official Account scraping (2026-09-03)

**What changed**: the channel that collected data through *your own logged-in WeChat Official
Account back office* is gone. The extension no longer matches **any page under
`mp.weixin.qq.com`**. Two features were deleted with it:

1. **Competitor collection for Official Accounts** — calling the back office's own `searchbiz`
   (search an account by name) and `appmsgpublish` (list that account's already-published public
   articles) endpoints to fetch a competitor's article list;
2. **Daily auto-sync of your own Official Account metrics** — opening your own back office in a
   background tab on a schedule to read reads / "wow" / read-through rate for your own posts.

**Why**: those endpoints are **not part of WeChat's official open API**. Calling them in an
automated way **may violate the WeChat Official Accounts Platform service agreement** ("no
unofficial interfaces", "no automated access"), and if it does, the account that gets rate-limited,
feature-blocked or penalised is **your own** — we cannot appeal on your behalf.

The feature shipped with three mitigations: off by default, a separate one-time risk
acknowledgement, and hard-coded conservative throttling (one collection per account per 12h,
5 accounts per round, 3–6s between requests, 30-minute stop on any rate-limit signal). Those
**lower the probability but cannot remove the risk** — and the risk sat on the user's account while
the payoff was a list of article titles. That trade does not pay, so the whole channel is gone
rather than getting one more guardrail.

**What to use instead**:

| What it used to do | What to do now |
|---|---|
| Collect a competitor Official Account's article list | Configure `BEACON_NEWRANK_KEY` (a commercial data source; the server fetches it, your account is never used), or export JSON locally with [wechat-article-exporter](https://github.com/jooooock/wechat-article-exporter) and import it under "Competitors → Import WeChat articles" |
| Sync your own Official Account metrics | No automated path for now. The other four creator back offices (WeChat Channels / Douyin / Xiaohongshu / Bilibili) are unaffected — click once to sync as before |
| Publishing to Official Accounts | **Unaffected** — it uses WeChat's official API (drafts) |

Data already collected is untouched and is not deleted.

## Not Supported Yet / In Progress

This section lists what Beacon **cannot do yet**. It exists so the feature table above does not
read as a promise: each item below either has no usable data channel, or has not been verified
against a real environment.

| Item | Status |
|---|---|
| **Competitor data for WeChat Official Accounts** | **Bring your own commercial source.** Without `BEACON_NEWRANK_KEY` there is no automated path at all (the extension route was removed); file import only |
| **Competitor data for WeChat Channels** | **Not supported.** No public profile page and no official content API — neither the server nor the extension can reach it. Subscribing yields no data, and the UI says so instead of pretending to collect |
| **Syncing your own Official Account metrics** | **No channel** (removed together with the above); manual entry in the dashboard only |
| **Chinese text on AI covers** | **Being tuned.** Image generation ships, but Chinese headline typography has not been calibrated style-by-style on real output |
| **TikTok comment collection** | **Not verified on a real account** (needs a login); the other five platforms are verified |
| **Off-site backup replica** | **Not configured.** Daily backups and weekly restore drills run, but the copy currently lives on the same host (set the four `BEACON_BACKUP_S3_*` variables to enable) |

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
| **Competitor Data** | `BEACON_TIKHUB_KEY`, `BEACON_YOUTUBE_API_KEY`, `BEACON_NEWRANK_KEY`, etc. | No server-side source for that platform: the ones the extension can reach (Douyin / Xiaohongshu / Bilibili / YouTube / X / TikTok) are collected in your own browser instead; **WeChat Official Accounts and Channels have no automated path at all** and the UI says "source not enabled" |
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
| **User-Initiated by Default** | Manual collection is always started by a click. **Two exceptions**: the daily scheduled batch collection (on by default, switchable off in the extension settings) and tasks you dispatch from your own workspace. Both are disclosed line by line in the extension's privacy policy, close their tabs when done, and notify you with the result of every round |
| **Official APIs First** | Competitor monitoring prefers official APIs and commercial sources (YouTube Data API, RSSHub, NewRank, TikHub) over page scraping, and **uses no platform's unofficial internal endpoints** — the last such channel (WeChat Official Account back office) was removed on 2026-09-03 |
| **Browser Extension Consent** | The extension only activates when the user explicitly clicks; no silent data harvesting |
| **Rate Limiting & Throttling** | Built-in request throttling to respect platform rate limits and terms of service |
| **Privacy Policy Disclosure** | Extension privacy policy fully discloses data collected, stored, and transmitted |
| **Data Minimization** | For competitors, only metadata visible on public pages. **Your own creator back office** is login-gated by definition: there the extension reads only *your own* posts' metrics, only when you click, never handling cookies and never logging in for you |
| **Right to Delete** | Users can request full data deletion; account removal wipes all collected data with cryptographic verification |
| **No Credential Harvesting** | The extension never reads, stores, or transmits platform login credentials |

## License

This project is dual-licensed:

- **Open Source**: [AGPL-3.0](LICENSE) — Free for personal and non-commercial use. Attribution required. Modifications must be open-sourced under the same license.
- **Commercial**: Paid SaaS, private deployment for sale, or closed-source use requires a commercial license. See [COMMERCIAL_LICENSE.md](COMMERCIAL_LICENSE.md).

Commercial licensing inquiries: jiangwenhuang@iyunci.cn
