# 三种交付形态

同一份代码，靠 `BEACON_EDITION` 切三个形态。能力差异是**一张表**（`lib/edition.ts` 的 `MATRIX`），
不是散落各处的 if —— 改产品边界就改那张表，测试会逼你把三个格子都填上。

| | `saas`（默认） | `appliance` | `private` |
|---|---|---|---|
| 部署 | 现有生产 | 客户的 Mac/Win 整机 | 客户自己的云 Docker |
| 数据库 / 队列 | 托管 PG + Redis | **SQLite + 进程内** | 自带 PG + Redis |
| 登录 | 短信 / 微信 | 企业应用 | 企业应用 |
| 支付 · 计费 | 有 | **无**（导航里也不出现） | **无** |
| AI 渠道 | 平台垫付 + BYOK | **仅 BYOK** | **仅 BYOK** |
| 首启 | — | `/setup` 装机向导 | `/setup` 装机向导 |
| 机器人入站 | webhook | 长连接（NAT 后无公网地址） | webhook |

`BEACON_EDITION` 留空 = `saas`，所以**现有生产一个字都不用改**。拼错则直接抛错，
不静默回落 —— 回落意味着卖出去的机器跑着 SaaS 版：支付路由活着，登录页要短信而机器上没有短信通道。

## 一、整机版（appliance）

```bash
bash deploy/appliance/install.sh        # macOS / Linux
powershell -ExecutionPolicy Bypass -File deploy\appliance\install.ps1   # Windows
```

装完即用：生成 `.env.appliance`（含随机主密钥与装机口令）→ 建库灌数据 → 构建 →
注册开机自启 → 桌面放启动器与《安装说明》→ 跑体检 → 打开浏览器进 `/setup`。

**为什么整机版不用 Docker**：依赖只有 Node 和一个 SQLite 文件（队列走进程内，
见 `lib/jobs/queue.ts`）。给客户装 Docker Desktop 只是多一层会坏的东西。

**备份 = 复制两个文件**：`prisma/appliance.db`（全部业务数据）+ `.env.appliance`（主密钥，
缺了它库里的 Key 解不开）。

## 二、私有化（private）

```bash
cp deploy/private/.env.private.example .env.private   # 填主密钥 / 库密码 / 域名 / 装机口令
docker compose -f deploy/private/docker-compose.yml up -d db
DATABASE_URL="postgresql://beacon:<PWD>@localhost:5432/beacon?schema=beacon" scripts/db-init-supabase.sh
docker compose -f deploy/private/docker-compose.yml up -d
```

与生产编排的差别只有三处：**不含 xray 出海代理**（客户机房架代理过不了安全审查）、
**自带 Postgres+pgvector**（客户要的就是数据在自己这儿）、形态标 `private`。

**建表不再需要人肉**：`scripts/db-init-supabase.sh` 已改成遍历 `prisma/postgres/*.sql`
全部按序应用（pgvector / RLS / 各版本增量）。以前只跑 01、02，剩下七份靠人记得手工执行 ——
忘一次就是生产 42P01，而且往往等到某个功能第一次被用到才炸。新增 SQL 丢进那个目录即可，脚本无需改。

## 登录（企业版）

企业版没有短信通道，登录只有一条路：**私聊企业应用里的机器人**。
不走网页扫码是因为网页授权要在企业应用后台登记 redirect_uri，而整机跑在
`http://localhost:<端口>` —— 只有那台机器上的浏览器跳得回来，同事在自己电脑上访问
局域网地址时回跳直接断。私聊这条路不需要任何回跳登记。

**员工只需要记住一个词：`登录`。** 私聊机器人发它——已是成员就回一条一次性链接；
还不是成员就**当场加入**再回链接。没有邀请码、没有申请、没有审批。

敢自动加入是因为企业应用本身就是公司边界：能私聊到这个机器人的人，已经过了客户自己的
飞书/钉钉/企微认证。再叠一层邀请码挡不住外人（外人根本发不了消息），只会让每个同事
都先去找管理员要串码。但**绝不静默**：机器人当场说明他以什么身份进来，同时给工作区发
一条站内通知，管理员在红点里看得到是谁。要收回就在「成员与权限」停用。

| 谁 | 发什么 | 作用 |
|---|---|---|
| 所有人 | `登录` | 回一条一次性链接（5 分钟有效、用过即失效）；不是成员的当场加入为「编辑」 |
| 装机管理员（一次） | `绑定 <6位码>` | 码印在装机完成页上，也可在「账号与安全」再取。**不绑的话这次会话过期后他自己也登不回来** |

两条指令**只在私聊里响应**——链接发进群等于谁点谁登进来。钉钉的群/单聊判定刻意 fail-closed：
只有显式 `conversationType==='1'` 才当私聊。

**权限只有两档**（企业版）：管理员 / 编辑。服务端与下拉框共用 `assignableRoles()`，
不存在「藏起来但打得通」的第三档。

**私有化版**另有网页授权（`/api/auth/oa/feishu/redirect`），登录页会多一个「用飞书登录」按钮。
整机版不给这个按钮：它要求 redirect_uri 在飞书后台登记，而整机跑在 localhost，
局域网里的同事点了也跳不回来 —— 给一个必然失败的按钮比不给更糟。
网页这条路**不做**自动加入（授权链接可以被转发到公司外），必须带邀请码。

### 飞书长连接（整机版）

飞书事件订阅默认走 webhook，要飞书服务器主动打到你的公网地址 —— 整机在 NAT 后面没有。
所以整机版多跑一个进程 `connector.ts`，由本机主动出站连飞书，事件顺着连接推下来：
不需要公网 IP / 域名 / 证书 / 备案。安装脚本已把它注册成第二个开机自启服务
（launchd `cn.iyunci.beacon.connector` / 计划任务 `BeaconConnector`）。

手动跑：`npm run connector`。私有化版**不用**它（云上有公网地址，走现成的 webhook 路由）。

## 三、SaaS

不动。所有形态闸的默认分支都是 SaaS 原行为，全量 3924 个用例可证。
