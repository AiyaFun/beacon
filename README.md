🌐 中文 · [English](README.en.md)

<h1 align="center">烽火台 Beacon</h1>

<p align="center">「用数据驱动内容决策的跨平台创作者作战室。」</p>

<p align="center">
  <a href="https://beacon.iyunci.cn">👉 在线体验</a>
</p>

<p align="center">
  <a href="https://github.com/AiyaFun/beacon"><img src="https://img.shields.io/badge/Platform-SaaS-blue" alt="Platform"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-green" alt="License"></a>
  <a href="https://beacon.iyunci.cn"><img src="https://img.shields.io/badge/Demo-beacon.iyunci.cn-orange" alt="Demo"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-20+-339933" alt="Node"></a>
</p>

<p align="center">
  面向创作者和内容团队的多平台选题创作 SaaS。<br>
  热榜聚合 · 竞对监控 · AI 选题智囊团 · 一稿多平台改写 · 敏感词合规 · 数据看板。
</p>

<p align="center">
  作者 / Maintainer：<a href="https://github.com/AiyaFun">AiyaFun</a>
</p>

<p align="center">
  <a href="#它解决什么问题">它解决什么问题</a> ·
  <a href="#适合谁用">适合谁用</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#生产部署">生产部署</a> ·
  <a href="#技术栈">技术栈</a> ·
  <a href="#许可证">许可证</a>
</p>

---

## 它解决什么问题

创作者日常面临三个核心痛点：**追什么热点、学谁的套路、怎么写得又快又合规**。

烽火台把这三件事整合到一个平台里，让你不用在十几个 App 之间来回切换。

| 功能 | 说明 |
|---|---|
| **热榜聚合** | 实时汇聚微博、抖音、B站、知乎、百度、YouTube 等多平台热榜，AI 自动聚类去重 |
| **竞对监控** | 跨平台追踪竞对账号（抖音、公众号、小红书、B站、YouTube、X），自动抓取新作品并分析数据 |
| **选题引擎** | 12 位 AI 人物智囊团从不同视角评审选题，结合你的人设给出切入建议 |
| **创作工坊** | AI 辅助起稿、一稿多平台改写、人味评分、事实漂移检测，自动标注 AIGC 标识 |
| **合规检测** | 四级敏感词库 + 分平台差异规则，发布前一键扫描 |
| **浏览器插件** | 一键收藏灵感素材、自有账号数据回填、竞对作品采集 |
| **机器人集成** | 飞书群机器人推送热点通知、支持自然语言查询 |
| **数据看板** | 多账号统一数据看板，趋势分析与周报 |
| **一键发布** | 公众号走官方接口直发草稿箱；抖音/小红书/B站/视频号由插件把内容填进后台表单，**停在发布按钮前**由你点 |
| **AI 助手与执行器** | 全站可唤起的助手；开「执行」后能代你建草稿、加竞对等，**写操作与花钱操作逐步确认** |
| **工作流模板** | 把「选题 → 起稿 → 改写 → 合规」这类多步串成模板，装一条跑一次，每步都有结果行 |
| **AI 封面与配图** | 按平台比例出封面（16 档风格 + 我的形象库），正文配图一律不上字；显式 + 隐式双 AIGC 标识 |
| **读者原声** | 采集自有作品与竞对作品的评论，回流成选题依据与拆解缺口 |
| **增长追踪** | 自有账号与竞对账号各自的粉丝/互动日快照与趋势，缺席的指标如实留空而不是记 0 |

## 最近更新（2026-08）

这一轮补上的是「写完之后」那一段——以前系统把稿子交给你就结束了，剩下的贴、发、回收全靠人。

- **一键发布**：生成跨平台发布计划。公众号走官方接口写进草稿箱（群发要另行勾选，不可撤销的事不替你做主）；
  抖音 / 小红书 / B站 / 视频号由插件把标题、正文、话题填进创作后台，**停在发布按钮前**；
  YouTube / X / TikTok 如实标「手动发布」并写明卡在哪（要上传视频文件 / 要付费 API / 要企业资质），
  不假装支持。「已填进后台」和「已发布」是两个状态词，不合并。
- **AI 执行器**：助手不止能答，还能调注册表里的工具替你做事。写操作与花钱操作**逐步确认**；
  没配真实模型时整次运行硬停——Mock 会编一句「我已经帮你做好了」，那比不做更糟。
- **工作流模板**：多步串成一条可安装的模板，跑一次每步都有结果行，花钱的步骤先把账说清楚。
- **AI 封面工位与正文配图**：按平台比例出图、可存自己的形象与风格；封面带显式水印 + 图内隐式标识，
  正文配图一律不上字。
- **解析自愈**：平台改版导致采集解析失效时，插件只上报**脱敏后的结构骨架**（数字变 NUM、长中文变 CJK，
  只留属性名），模型给出的新选择器**只能是候选**，必须人工采纳才会生效。
- **平台运维台**：跨租户的套餐/状态、平台 AI 渠道与预算、解析规则采纳，全部留审计痕迹。
- **接入与密钥一页收口**：模型渠道、生图、发布凭证、采集令牌、机器人凭据集中到一页，
  并提供**无副作用**的一键检测（不发测试消息、不真出图；纯 Webhook 机器人如实标「测不了」）。

## 适合谁用

- **自媒体创作者** — 个人运营多个平台账号，需要高效追热点、出内容
- **内容团队** — MCN / 品牌方的内容运营团队，需要统一监控和协作
- **新媒体运营** — 企业新媒体岗，需要竞对分析和选题数据支撑
- **独立开发者** — 想基于此项目搭建自己的内容工具

## 典型使用流程

```
1. 登录 → 绑定创作者账号（公众号、抖音、小红书等）
2. 首页「今日概览」查看全网热榜 + 竞对动态 + AI 推荐选题
3. 点进选题 → 智囊团给出多角度切入建议
4. 进入「创作工坊」→ AI 起稿 → 一键改写成各平台风格
5. 「合规检测」扫一遍 → 确认无敏感词 → 复制发布
6. 发布后数据自动回流 → 分析表现 → 指导下一次选题
```

## 技术栈

| 层 | 技术 |
|---|---|
| **前端** | Next.js 15 (App Router), React 19, TypeScript, Tailwind CSS |
| **后端** | Next.js Server Actions + API Routes (Node.js)，无独立后端服务 |
| **数据库** | SQLite（开发）/ PostgreSQL + pgvector（生产），Prisma ORM |
| **任务队列** | BullMQ + Redis（生产）/ 进程内队列（开发） |
| **大模型** | 任意 OpenAI 兼容端点（DeepSeek、Qwen、MiniMax、Kimi、GLM 等） |
| **浏览器插件** | Chrome Manifest V3 |
| **容器化** | Docker Compose（Nginx + Web + Worker + Redis） |
| **认证** | 手机短信验证码 + 微信扫码登录（可选） |
| **支付** | 微信支付 Native 扫码（可选） |

## 快速开始

```bash
git clone https://github.com/AiyaFun/beacon.git
cd beacon
npm install
cp .env.example .env
npm run setup
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000)。开发模式下所有外部依赖都用 Mock 替代——**不需要任何 API Key、不需要 Redis、不需要 PostgreSQL**，开箱即用。

## 生产部署

### 前置条件

| 条件 | 说明 |
|---|---|
| Linux 服务器 | Ubuntu 20.04+ 或 CentOS 7+ |
| Docker & Compose v2 | 容器化部署 |
| 域名 + DNS | 指向服务器 |
| SSL 证书 | Let's Encrypt 或自有 |
| PostgreSQL 15+ | 需 pgvector 扩展（自建或托管均可） |

### 第一步：配置

```bash
git clone https://github.com/AiyaFun/beacon.git
cd beacon
cp .env.production.example .env.production
chmod 600 .env.production
```

编辑 `.env.production`，每个变量都有详细中文注释。必填项：

| 变量 | 用途 |
|---|---|
| `DATABASE_URL` | PostgreSQL 连接串，需带 `?schema=beacon` |
| `BEACON_MASTER_KEY` | 加密主密钥。生成：`openssl rand -base64 48` |
| `BEACON_SMS_VENDOR` | 短信通道，填 `"volcengine"` |
| `BEACON_VOLC_SMS_AK/SK` | 火山引擎短信 AccessKey |
| `BEACON_DEFAULT_LLM_*` | 大模型端点 + Key |
| `BEACON_TRUSTED_PROXY_HOPS` | 反代层数，默认 `"1"` |

### 可选功能

以下功能不配也不影响核心使用：

| 功能 | 变量 | 不配的效果 |
|---|---|---|
| **微信扫码登录** | `BEACON_WECHAT_APPID` + `SECRET` | 仅手机号验证码登录 |
| **微信支付** | `BEACON_PAY_VENDOR="wxpay"` + 商户密钥 | 付费功能不可用 |
| **竞对数据源** | `BEACON_TIKHUB_KEY`、`BEACON_YOUTUBE_API_KEY` 等 | 对应平台用 Mock 数据 |
| **向量嵌入** | `BEACON_EMBED_*` | 语义检索降级为关键词匹配 |
| **飞书机器人** | `/settings` 页面配置 | 无推送通知 |
| **Sentry** | `BEACON_SENTRY_DSN` | 仅本地日志 |

### 第二步：初始化数据库

```bash
export REDIS_PASSWORD="$(openssl rand -hex 32)"
DATABASE_URL="your-connection-string" bash scripts/db-init-supabase.sh
```

### 第三步：启动

```bash
docker compose up -d --build
```

| 服务 | 作用 |
|---|---|
| **proxy** | Nginx 反代（对外 80/443） |
| **web** | Next.js 应用（仅内部） |
| **worker** | BullMQ 后台任务 |
| **redis** | 队列 + 限流 |

### 第四步：验证

```bash
docker compose ps
curl -s https://your-domain.com/api/health | jq .
```

### 更新

```bash
git pull
docker compose up -d --build redis web worker
```

## 浏览器插件

1. 打开 `chrome://extensions/`
2. 开启「开发者模式」
3. 「加载已解压的扩展程序」→ 选择 `extension/` 目录

## 安全防护

本项目在安全方面做了多层防护：

| 防护层 | 机制 |
|---|---|
| **密钥隔离** | 所有密钥、API Key、服务器 IP 均通过 `.env.production` 注入，不进入源码 |
| **Git 历史清洁** | 开源分支为 orphan branch，历史中不含任何密钥或内部配置 |
| **Pre-commit 钩子** | 自动扫描 10 种密钥模式（SK-/AKIA/AKLT/PEM/密码赋值/连接串/AppID 等），检测到即阻止提交 |
| **GitHub Push Protection** | 仓库开启 GitHub 原生密钥扫描，服务端拦截已知密钥格式 |
| **RLS 行级安全** | PostgreSQL 全表开启 Row Level Security，租户数据物理隔离 |
| **反代收口** | 生产环境 Web 端口仅绑定 127.0.0.1，仅 Nginx 反代对外暴露 80/443 |
| **XFF 防伪造** | 反代覆写 X-Forwarded-For，防止直连绕过限流 |
| **加密存储** | 第三方凭证使用 BEACON_MASTER_KEY 对称加密存储，非明文 |
| **CSRF / Cookie** | 登录 Cookie 强制 Secure + HttpOnly + SameSite=Lax |
| **限流** | 短信 / API 接口均有 IP + 用户维度限流，防刷保护 |

启用 pre-commit 钩子：

```bash
git config core.hooksPath .githooks
```

### 合规化采集

所有数据采集均遵循透明、合规的原则：

| 原则 | 实现方式 |
|---|---|
| **用户主动触发** | 所有采集行为由用户手动发起，不做后台静默抓取 |
| **官方 API 优先** | 竞对监控优先走官方接口（YouTube Data API、RSSHub），而非直接爬页面 |
| **插件知情同意** | 浏览器插件仅在用户主动点击时激活，不做隐式数据采集 |
| **节流与限速** | 内置请求频率控制，遵守各平台速率限制与服务条款 |
| **隐私政策披露** | 插件隐私政策完整披露采集、存储和传输的数据范围 |
| **数据最小化** | 仅采集公开内容的元数据，不抓取私密或登录后才可见的数据 |
| **删除权** | 用户可申请完整数据删除，注销时清除全部采集数据并加密验证 |
| **不碰凭证** | 插件绝不读取、存储或传输用户在各平台的登录凭证 |

## 许可证

本项目采用双重许可：

- **开源**: [AGPL-3.0](LICENSE) — 个人与非商业用途免费，需保留署名，修改须同许可开源
- **商业**: 付费 SaaS、私有化售卖、闭源使用需商业授权。详见 [COMMERCIAL_LICENSE.md](COMMERCIAL_LICENSE.md)

商业授权联系：jiangwenhuang@iyunci.cn
