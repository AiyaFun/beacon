# Beacon / 烽火台

面向创作者和内容团队的 **跨平台内容作战室**。一站式完成热点追踪、竞对监控、AI 选题、智能创作与合规检测，帮助创作者用数据驱动内容决策。

Cross-platform content operations SaaS for creators — trending topics, competitor tracking, AI-powered topic selection, smart writing, and compliance checking in one dashboard.

**在线体验 / Live Demo**: [beacon.iyunci.cn](https://beacon.iyunci.cn)

---

## 这个项目能做什么 / What It Does

烽火台解决创作者日常面临的三个核心问题：**追什么热点、学谁的套路、怎么写得又快又合规**。

Beacon solves three core problems for creators: **what's trending, what competitors are doing, and how to write fast without compliance issues**.

| 功能 / Feature | 说明 / Description |
|---|---|
| **热榜聚合** / Trending Aggregation | 实时汇聚微博、抖音、B站、知乎、百度、YouTube 等多平台热榜，AI 自动聚类去重。Aggregates trending topics from Weibo, Douyin, Bilibili, Zhihu, Baidu, YouTube and more with AI-powered clustering. |
| **竞对监控** / Competitor Tracking | 跨平台追踪竞对账号（抖音、公众号、小红书、B站、YouTube、X），自动抓取新作品并分析数据。Track competitor accounts across Douyin, WeChat, Xiaohongshu, Bilibili, YouTube, X. |
| **选题引擎** / Topic Engine | 12 位 AI 人物智囊团从不同视角评审选题，结合你的人设给出切入建议。12 AI personas review topics from different angles based on your brand positioning. |
| **创作工坊** / Writing Workshop | AI 辅助起稿、一稿多平台改写、人味评分、事实漂移检测，自动标注 AIGC 标识。AI drafting, multi-platform rewriting, humanization scoring, fact-drift detection. |
| **合规检测** / Compliance Check | 四级敏感词库 + 分平台差异规则，发布前一键扫描。4-tier sensitive word engine with platform-specific rules. |
| **浏览器插件** / Browser Extension | 一键收藏灵感素材、自有账号数据回填、竞对作品采集。One-click inspiration clipping, account data backfill, competitor collection. |
| **机器人集成** / Bot Integration | 飞书群机器人推送热点通知、支持自然语言查询。Feishu/Lark bot for push notifications and natural language queries. |
| **数据看板** / Analytics Dashboard | 多账号统一数据看板，趋势分析与周报。Unified multi-account analytics with trend analysis. |

## 适合谁用 / Who Is It For

- **自媒体创作者** — 个人运营多个平台账号，需要高效追热点、出内容。Solo creators managing multiple platform accounts.
- **内容团队** — MCN / 品牌方的内容运营团队，需要统一监控和协作。Content teams at MCNs or brands needing unified monitoring.
- **新媒体运营** — 企业新媒体岗，需要竞对分析和选题数据支撑。Enterprise social media managers needing data-driven decisions.
- **独立开发者** — 想基于此项目搭建自己的内容工具。Developers building custom content tools on top of this project.

## 典型使用流程 / Typical Workflow

```
1. 登录 → 绑定创作者账号（公众号、抖音、小红书等）
   Sign in → Link your creator accounts (WeChat, Douyin, Xiaohongshu, etc.)

2. 首页「今日概览」查看全网热榜 + 竞对动态 + AI 推荐选题
   Dashboard shows trending topics + competitor updates + AI topic recommendations

3. 点进选题 → 智囊团给出多角度切入建议
   Drill into a topic → AI panel gives multi-angle entry suggestions

4. 进入「创作工坊」→ AI 起稿 → 一键改写成各平台风格
   Enter Writing Workshop → AI draft → One-click rewrite for each platform

5. 「合规检测」扫一遍 → 确认无敏感词 → 复制发布
   Compliance scan → Confirm no violations → Copy and publish

6. 发布后数据自动回流 → 分析表现 → 指导下一次选题
   Post-publish data flows back → Analyze performance → Inform next topic
```

## 技术栈 / Tech Stack

| 层 / Layer | 技术 / Technology |
|---|---|
| **前端 / Frontend** | Next.js 15 (App Router), React 19, TypeScript, Tailwind CSS |
| **后端 / Backend** | Next.js Server Actions + API Routes (Node.js)，无独立后端服务 / No separate backend service |
| **数据库 / Database** | SQLite（开发 / dev）/ PostgreSQL + pgvector（生产 / prod），Prisma ORM |
| **任务队列 / Queue** | BullMQ + Redis（生产 / prod）/ 进程内队列（开发 / dev） |
| **大模型 / LLM** | 任意 OpenAI 兼容端点 / Any OpenAI-compatible endpoint（DeepSeek、Qwen、MiniMax、Kimi、GLM 等） |
| **浏览器插件 / Extension** | Chrome Manifest V3 |
| **容器化 / Container** | Docker Compose（Nginx + Web + Worker + Redis） |
| **认证 / Auth** | 手机短信验证码 + 微信扫码登录（可选）/ SMS OTP + WeChat OAuth (optional) |
| **支付 / Payment** | 微信支付 Native 扫码（可选）/ WeChat Pay Native QR (optional) |

## 快速开始 / Quick Start

```bash
git clone https://github.com/AiyaFun/beacon.git
cd beacon
npm install
cp .env.example .env
npm run setup
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000)。开发模式下所有外部依赖都用 Mock 替代——**不需要任何 API Key、不需要 Redis、不需要 PostgreSQL**，开箱即用。

Open [http://localhost:3000](http://localhost:3000). Dev mode mocks everything — **no API keys, no Redis, no PostgreSQL needed**. Works out of the box.

## 生产部署 / Production Deployment

### 前置条件 / Prerequisites

| 条件 / Requirement | 说明 / Description |
|---|---|
| Linux 服务器 / Linux Server | Ubuntu 20.04+ 或 CentOS 7+ 推荐 / Ubuntu 20.04+ or CentOS 7+ recommended |
| Docker & Compose v2 | 容器化部署 / Container deployment |
| 域名 + DNS / Domain + DNS | 指向服务器 / Pointed to your server |
| SSL 证书 / SSL Certificate | Let's Encrypt 或自有证书 / Let's Encrypt or your own |
| PostgreSQL 15+ | 需要 pgvector 扩展 / With pgvector extension（自建或托管 / self-hosted or managed） |

### 第一步：配置 / Step 1: Configure

```bash
git clone https://github.com/AiyaFun/beacon.git
cd beacon
cp .env.production.example .env.production
chmod 600 .env.production
```

编辑 `.env.production`，每个变量都有详细中文注释。以下为必填项：

Edit `.env.production` — every variable has detailed comments. Required fields:

| 变量 / Variable | 用途 / Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL 连接串，需带 `?schema=beacon` / Connection string with `?schema=beacon` |
| `BEACON_MASTER_KEY` | 用户 API Key 加密主密钥。生成 / Encryption key. Generate: `openssl rand -base64 48` |
| `BEACON_SMS_VENDOR` | 短信通道，填 `"volcengine"`（火山引擎）/ SMS provider, e.g. `"volcengine"` |
| `BEACON_VOLC_SMS_AK/SK` | 火山引擎短信 AccessKey / VolcEngine SMS credentials |
| `BEACON_DEFAULT_LLM_*` | 大模型端点 + Key / LLM endpoint + API key（任意 OpenAI 兼容 / any OpenAI-compatible） |
| `BEACON_TRUSTED_PROXY_HOPS` | 反代层数，默认 `"1"` / Reverse proxy hops, default `"1"` for built-in Nginx |

### 可选功能配置 / Optional Features

| 功能 / Feature | 变量 / Variables | 不配的效果 / Without it |
|---|---|---|
| **微信扫码登录** / WeChat Login | `BEACON_WECHAT_APPID` + `SECRET` | 登录页不显示微信入口，仅手机号验证码 / Login page shows SMS only |
| **微信支付** / WeChat Pay | `BEACON_PAY_VENDOR="wxpay"` + 商户密钥 / merchant keys | 付费功能不可用，其余正常 / Billing disabled, everything else works |
| **竞对数据源** / Competitor APIs | `BEACON_TIKHUB_KEY`, `BEACON_YOUTUBE_API_KEY` 等 | 对应平台用 Mock 数据 / Mock data for that platform |
| **向量嵌入** / Vector Embedding | `BEACON_EMBED_*` | 语义检索降级为关键词匹配 / Semantic search falls back to keyword matching |
| **飞书机器人** / Feishu Bot | 在 `/settings` 页面配置 / Configure in Settings page | 无推送通知 / No push notifications |
| **Sentry 监控** / Sentry | `BEACON_SENTRY_DSN` | 仅本地日志 / Local logs only |

### 第二步：初始化数据库 / Step 2: Initialize Database

```bash
export REDIS_PASSWORD="$(openssl rand -hex 32)"
DATABASE_URL="your-connection-string" bash scripts/db-init-supabase.sh
```

### 第三步：启动 / Step 3: Deploy

```bash
docker compose up -d --build
```

启动 4 个服务 / Starts 4 services:

| 服务 / Service | 作用 / Role |
|---|---|
| **proxy** | Nginx 反代 / Reverse proxy（对外 80/443 / public ports 80/443） |
| **web** | Next.js 应用 / App server（仅内部 / internal only, port 3000） |
| **worker** | BullMQ 后台任务 / Background job processor |
| **redis** | 队列 + 限流 / Queue + rate limiting |

### 第四步：验证 / Step 4: Verify

```bash
docker compose ps                                          # 确认容器运行 / Check containers
curl -s https://your-domain.com/api/health | jq .          # 健康检查 / Health check
```

### SSL 证书 / SSL Certificates

```bash
bash deploy/cert.sh
```

或使用 Let's Encrypt: `certbot certonly --standalone -d your-domain.com`

### 更新 / Updating

```bash
git pull
docker compose up -d --build redis web worker
```

## 浏览器插件 / Browser Extension

插件代码在 `extension/` 目录。以开发者模式加载：

The extension lives in `extension/`. Load as unpacked:

1. 打开 / Open `chrome://extensions/`
2. 开启「开发者模式」/ Enable "Developer mode"
3. 点击「加载已解压的扩展程序」→ 选择 `extension/` 目录 / Click "Load unpacked" → select `extension/`

## 密钥防泄漏 / Secret Prevention

仓库自带 pre-commit 钩子，自动扫描暂存区中的密钥模式并阻止提交。

This repo includes a pre-commit hook that blocks commits containing API keys, passwords, and other secrets.

```bash
git config core.hooksPath .githooks
```

## 许可证 / License

本项目采用双重许可 / This project is dual-licensed:

- **开源许可 / Open Source**: [AGPL-3.0](LICENSE) — 个人与非商业用途免费，需保留署名与版权信息，修改后的代码需以相同许可开源。Free for personal and non-commercial use. Retain attribution; share modifications under the same license.
- **商业许可 / Commercial**: 付费 SaaS 运营、私有化部署售卖、闭源使用需获取商业授权。See [COMMERCIAL_LICENSE.md](COMMERCIAL_LICENSE.md). A separate commercial license is required for paid SaaS deployment, private resale, or closed-source use.

商业授权联系 / Commercial licensing: jiangwenhuang@iyunci.cn
