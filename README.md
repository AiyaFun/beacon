🌐 中文 · [English](README.en.md)

<h1 align="center">烽火台 Beacon</h1>

<p align="center"><b>先知道做什么，再谈怎么写。</b></p>

<p align="center">给持续更新的创作者：每天早上一份带理由的选题推荐，覆盖抖音、小红书、公众号、B 站、视频号。</p>

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
  <a href="#下载安装">下载安装</a> ·
  <a href="#它解决什么问题">它解决什么问题</a> ·
  <a href="#与-openclawhermes-agent-的异同">与 OpenClaw / Hermes 的异同</a> ·
  <a href="#暂不支持与开发中">暂不支持与开发中</a> ·
  <a href="#适合谁用">适合谁用</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#生产部署">生产部署</a> ·
  <a href="#技术栈">技术栈</a> ·
  <a href="#许可证">许可证</a>
</p>

---

## 界面一览

<table>
  <tr>
    <td width="50%" valign="top"><b>今天</b> · 说一句话就派活；本周作战报告里每条高潜选题后面就是「起稿」入口<br><br><img src="docs/screenshots/today.png" alt="今天：派活框与本周作战报告"></td>
    <td width="50%" valign="top"><b>看情报</b> · 七源热榜聚合，账号 × 热点差异化雷达<br><br><img src="docs/screenshots/hotlists.png" alt="看情报：热榜与差异化雷达"></td>
  </tr>
  <tr>
    <td width="50%" valign="top"><b>挑选题</b> · 每条推荐带六维评分、差异化切入角、抢跑窗口和「为什么推给你」<br><br><img src="docs/screenshots/topics.png" alt="挑选题：带理由的选题推荐"></td>
    <td width="50%" valign="top"><b>做内容</b> · 照着选题方案与平台格式起稿，自动去 AI 味，一稿多平台<br><br><img src="docs/screenshots/studio.png" alt="做内容：创作工坊"></td>
  </tr>
  <tr>
    <td width="50%" valign="top"><b>看效果</b> · 作品表现回流，播放 / 互动一眼看清，一键生成复盘<br><br><img src="docs/screenshots/data.png" alt="看效果：数据看板"></td>
    <td width="50%" valign="top"><b>技能 · 连接器</b> · 公众号排版、小红书图文、抖音口播等成品技能，装上即用<br><br><img src="docs/screenshots/skills.png" alt="技能：把草稿变成各平台成品"></td>
  </tr>
</table>

<p align="center"><sub>截图来自演示工作台（示例数据）。</sub></p>


## 下载安装

烽火台有三种使用方式，按需选择：

| 方式 | 适合谁 | 怎么装 |
|---|---|---|
| **在线版** | 想先试试 | 直接打开 [beacon.iyunci.cn](https://beacon.iyunci.cn) |
| **桌面客户端** | 已有在线版账号，需要本机浏览器采集与自动回填 | 下载对应平台安装包 👇 |
| **整机版** | 想把整套系统装在自己的电脑上，数据完全本地 | 克隆仓库，一条命令装完 👇 |

### 桌面客户端

桌面客户端是在线版的浏览器伴侣——安装后可以用你本机的 Chrome 执行采集和自动回填，不需要额外的浏览器插件。

从 [Releases](https://github.com/AiyaFun/beacon/releases) 页面下载：

| 平台 | 文件 | 说明 |
|---|---|---|
| **macOS** (Apple Silicon) | `烽火台_x.x.x_aarch64.dmg` | 打开 DMG → 拖进 Applications |
| **Windows** (x64) | `烽火台_x.x.x_x64-setup.exe` | 双击运行安装向导 |

安装后用你的在线版账号登录即可。客户端会自动检查更新。

### 整机版（私有部署）

整套系统跑在你自己的电脑上，数据存在本地 SQLite，不需要服务器、不需要 Docker。

```bash
git clone https://github.com/AiyaFun/beacon.git
cd beacon
bash deploy/appliance/install.sh    # macOS / Linux
```

Windows 用 PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File deploy\appliance\install.ps1
```

安装脚本会自动完成：检查 Node.js → 生成配置 → 安装依赖 → 建库 → 构建 → 注册开机自启 → 打开装机向导。

升级到新版本：

```bash
git pull
bash deploy/appliance/update.sh
```


## 它解决什么问题

创作者日常面临三个核心痛点：**追什么热点、学谁的套路、怎么写得又快又合规**。

烽火台把这三件事整合到一个平台里，让你不用在十几个 App 之间来回切换。

| 功能 | 说明 |
|---|---|
| **热榜聚合** | 实时汇聚微博、抖音、B站、知乎、百度、YouTube 等多平台热榜，AI 自动聚类去重 |
| **竞对监控** | 跨平台追踪竞对账号（抖音、小红书、B站、YouTube、X、TikTok），自动抓取新作品并分析数据。**公众号/视频号见下方「暂不支持与开发中」** |
| **选题引擎** | 12 位 AI 人物智囊团从不同视角评审选题，结合你的人设给出切入建议 |
| **创作工坊** | AI 辅助起稿、一稿多平台改写、人味评分、事实漂移检测，自动标注 AIGC 标识 |
| **合规检测** | 四级敏感词库 + 分平台差异规则，发布前一键扫描 |
| **浏览器插件** | 一键收藏灵感素材、自有账号数据回填、竞对作品采集（开源发行版**不进微信公众号后台**，见「暂不支持与开发中」） |
| **机器人集成** | 飞书群机器人推送热点通知、支持自然语言查询 |
| **数据看板** | 多账号统一数据看板，趋势分析与周报 |
| **一键发布** | 公众号走官方接口直发草稿箱；抖音/小红书/B站/视频号由插件把内容填进后台表单，**停在发布按钮前**由你点 |
| **AI 助手与执行器** | 全站可唤起的助手；开「执行」后能代你建草稿、加竞对等，**写操作与花钱操作逐步确认** |
| **工作流模板** | 把「选题 → 起稿 → 改写 → 合规」这类多步串成模板，装一条跑一次，每步都有结果行 |
| **AI 封面与配图** | 按平台比例出封面（16 档风格 + 我的形象库），正文配图一律不上字；显式 + 隐式双 AIGC 标识 |
| **读者原声** | 采集自有作品与竞对作品的评论，回流成选题依据与拆解缺口 |
| **增长追踪** | 自有账号与竞对账号各自的粉丝/互动日快照与趋势，缺席的指标如实留空而不是记 0 |

## 与 OpenClaw、Hermes Agent 的异同

烽火台里也有智能体、技能、记忆、定时任务和群机器人，所以常被拿来和
[OpenClaw](https://github.com/openclaw/openclaw)、[Hermes Agent](https://github.com/NousResearch/hermes-agent) 比。

一句话：**那两个是通用 agent 运行时，烽火台是内容运营的垂直产品**。它们给你一个「什么都能干」的助手，
干什么由你交代；烽火台开箱就是热榜、竞对、选题、起稿、合规、发布、复盘这一条线，agent 只是其中一层。
三者不是替代关系——烽火台自带 MCP Server，可以被它们当工具调用（见本节末尾）。

### 相同点

- **都开源、都能跑在自己的机器上**，模型都不绑定单一供应商。
- **同一种执行内核**：目标 → 调工具 → 看结果 → 再决定下一步的循环，带上下文压缩与预算 / 轮数上限。
- **技能、持久记忆、定时任务、子任务**四样都有——会的事能沉淀下来，到点自己跑，跑完留记录。
- **都能在聊天渠道里派活**：群里说一句话，任务在后台跑，跑完回到原来那个对话。
- **都能驱动浏览器**去读页面。

### 不同点

| 维度 | 烽火台 Beacon | OpenClaw | Hermes Agent |
|---|---|---|---|
| **定位** | 内容运营垂直产品，agent 只是其中一层 | 通用个人 AI 助手，跑在你自己的设备上 | 通用自进化 agent（Nous Research），主打「越用越懂你」 |
| **开箱得到什么** | 领域数据与界面：多源热榜、竞对库、六维选题评分、各平台格式、敏感词库、数据看板 | 一个接得上 20+ 聊天渠道、能操作设备的助手；具体做什么靠技能与插件 | 一个带终端、记忆、技能的 agent；具体做什么靠你交代和它自己沉淀 |
| **主入口** | 网页工作台（首页一个派活框）+ 群机器人 + 桌面客户端 / 浏览器插件 | 聊天渠道 + 各系统的伴侣应用（语音、屏幕、设备动作） | 终端 CLI + 消息网关 |
| **聊天渠道** | 国内办公 IM 为主：飞书、企业微信、钉钉、微信；另有 Telegram、Slack | WhatsApp、Telegram、Slack、Discord、iMessage、Signal、Teams 等 | Telegram、Discord、Slack、WhatsApp、Signal、邮件 |
| **运行形态** | 多租户 SaaS / 桌面客户端 / 整机版（本地 SQLite）三种 | 只有自托管，本机 Gateway 作控制面 | 自托管，从小 VPS 到 serverless；七种终端后端（本机、Docker、SSH、Modal 等） |
| **技能从哪来** | 步骤只从**真实执行轨迹**里提炼；模型可以起草，**启用必须是人** | 技能 / 插件，ClawHub 市场分发 | 复杂任务做完后**自动**生成技能，并在使用中自己改进（闭环学习） |
| **记忆** | 按账号隔离、置信度随时间衰减；写入前和注入前各扫一遍提示注入；只许写陈述句，不许写祈使句 | 会话、记忆、凭据都留在本机 | 持久记忆 + 跨会话全文检索 + 用户画像建模 |
| **执行边界** | 七个职能机器人各有工具白名单；授权分三档；发布 / 删除 / 支付 / 关注这类不可逆动作**一律停手，交给你点**；本机命令执行只在整机版，SaaS 恒关 | 在本机权限内通用执行（命令、浏览器、设备动作） | 通用终端执行，危险命令走审批 |
| **浏览器用来干什么** | 只读采集与发布表单预填：动作白名单，模型不能执行任意脚本；登录态只留在你自己的浏览器里，不做指纹伪装 | 通用浏览器控制 | 通用网页 / 浏览器工具 |
| **模型** | 任意 OpenAI 兼容端点（DeepSeek、Qwen、Kimi、GLM、MiniMax 等）；整机版可用 ChatGPT 订阅 | Claude、Codex、本地模型等，可插拔 | 任意模型（Nous Portal、OpenRouter、OpenAI、自定义端点） |
| **技术栈** | TypeScript · Next.js · Prisma | TypeScript · Node.js | Python |
| **许可证** | AGPL-3.0 + 商业许可 | MIT | MIT |

### 学了什么，没学什么

烽火台的 agent 层源码级读过这两个项目，如实交代：

- **学了**：记忆写入前扫提示注入、压缩上下文前先剪旧的工具结果（不调模型）、本机命令的「任何档位都不放行」底线清单、
  命令输出进上下文前给密钥打码、停机期间漏跑的定时任务补跑一次（以上来自 Hermes）；
  网页正文的语义提取、用 role / aria / 文本当锚点替代脆弱的类名（来自 OpenClaw 一系的浏览器做法）。
- **刻意没学**：后台自动写技能和记忆——这恰恰是 Hermes 的招牌，但烽火台的记忆会带进**每一次生成**，
  技能会替你操作**真实账号**，所以坚持「起草可以是模型，启用必须是人」；
  会话 / 指纹池——那是对抗平台风控，代价落在用户的号上；多终端后端、沙箱里跑模型写的代码——SaaS 架构上不该有。

### 怎么选，能不能一起用

- 想要一个**什么都能交代**的个人助手 → OpenClaw 或 Hermes Agent。
- 想要**每天早上一份带理由的选题**，以及从选题到复盘的整条内容流水线 → 烽火台。
- 已经在用前两者：仓库根的 `mcp-server.ts` 暴露了 7 个工具（派任务、查进度、采竞对、采自有数据、读页面等），
  任何支持 MCP 的 agent 都能把烽火台当作「内容运营」这一块的工具来调。

<sub>对 OpenClaw 与 Hermes Agent 的描述依据它们公开的 README 与源码，两个项目迭代都很快，以各自仓库为准。</sub>

## 暂不支持与开发中

这一节写的是**还没做到的事**。列在这里是为了别让上面的功能表读起来像承诺——
下面这些要么没有可用的数据通道，要么还没在真实环境里验证过。

| 事项 | 现状 |
|---|---|
| **公众号竞对数据** | **需自备商业数据源**。不配 `BEACON_NEWRANK_KEY` 就没有任何自动通道（插件那条已移除且不会恢复），只能用导出文件导入 |
| **视频号竞对数据** | **暂不支持**。它没有公开主页、也没有官方内容接口，服务端和插件都够不着；订阅了也不会有数据，界面上如实标「数据源未启用」而不是假装在采 |
| **自有公众号数据回填** | **开源发行版不含**该可选模块（官方发行版有，需单独授权站点）。从本仓库自行构建插件时这一项不存在 |
| **封面中文上字** | **调优中**。生图链路已上线，但中文标题的排版质量尚未在真机上逐档校准 |
| **TikTok 评论采集** | **未真机验证**（需登录态），其余五个平台的评论采集已真机跑通 |
| **异地备份副本** | **未配置**。每日备份与每周恢复演练已在跑，但副本目前只落在同一台机器上（补 `BEACON_BACKUP_S3_*` 四个变量即可开启） |

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
| **竞对数据源** | `BEACON_TIKHUB_KEY`、`BEACON_YOUTUBE_API_KEY`、`BEACON_NEWRANK_KEY` 等 | 该平台没有服务端数据源：插件采得到的（抖音/小红书/B站/YouTube/X/TikTok）改由插件在你自己的浏览器里采；**公众号/视频号则没有任何自动通道**，界面上如实标「数据源未启用」 |
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
| **用户主动触发为主** | 手动采集全部由用户点击发起；**例外是两类定时任务**——每日定时批量采集（默认开，可在插件设置关闭）与你自己在工作区里派下来的任务。两者都在插件的隐私政策里逐条披露，采完即关标签页，每轮有结果通知 |
| **官方 API 优先** | 竞对监控优先走官方接口与商业数据源（YouTube Data API、RSSHub、新榜、TikHub），而非直接爬页面；**不使用任何平台的非官方内部接口**（2026-09-03 起，最后一条这样的通道——公众号后台采集——已删除） |
| **插件知情同意** | 浏览器插件仅在用户主动点击时激活，不做隐式数据采集 |
| **节流与限速** | 内置请求频率控制，遵守各平台速率限制与服务条款 |
| **隐私政策披露** | 插件隐私政策完整披露采集、存储和传输的数据范围 |
| **数据最小化** | 竞对侧只采公开页面上的元数据；**你自己的创作者后台**属于登录后才可见的页面，只读你**本人作品**的表现数字，且必须由你当场点击触发（不代替登录、不碰 Cookie） |
| **删除权** | 用户可申请完整数据删除，注销时清除全部采集数据并加密验证 |
| **不碰凭证** | 插件绝不读取、存储或传输用户在各平台的登录凭证 |

## 许可证

本项目采用双重许可：

- **开源**: [AGPL-3.0](LICENSE) — 个人与非商业用途免费，需保留署名，修改须同许可开源
- **商业**: 付费 SaaS、私有化售卖、闭源使用需商业授权。详见 [COMMERCIAL_LICENSE.md](COMMERCIAL_LICENSE.md)

商业授权联系：jiangwenhuang@iyunci.cn
