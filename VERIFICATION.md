# 验证报告与缺口清单

**版本** beacon 1.2.0 ｜ **最后更新** 2026-07-24（多条结论已被后续修复推翻，本次同步）

> 2026-07-24 补记：本轮又落地 30+ 项代码级优化（DFA 敏感词缓存、AIGC docProps 隐式标识、插件 Mock 红线标注、degraded 透传、右键灵感箱、采集反馈真实化、LLM 网关结构化日志、推荐信任分层徽章、PWA manifest、billing 本月产出账本等），均通过 `tsc --noEmit` 零错误。明细与「仍需真机/密钥的待验证项」见 `reports/2026-07-23-烽火台-剩余工作与逆向分析.html`。**这些是代码优化，不改本文档「已验证/未验证」的分级结论——需要真机或密钥才能确认的项仍标 🔴。**

## 这份文档是干什么的

给「能不能上线」这个问题一个**诚实**的答案。

上一版这份文档的最大问题不是写得不全，是**它撒谎**：声称「鉴权是固定 Demo 会话、缺登录/RBAC」，
而代码里早已有完整的验证码登录 + 邀请 + RBAC；声称「敏感词库 ~16 个示范词」，实际 402 条。
照那份文档判断项目状态，会得出与代码**完全相反**的结论。

所以本版的第一品质是诚实，不是好看。**宁可写「这块我们没做」，也不含糊其辞。**

### 证据分级（每条结论都标了来源）

| 标记 | 含义 |
|---|---|
| 🟢 实测 | 本轮真跑过命令/脚本，贴得出输出 |
| 🟡 代码核实 | 逐行读过代码/配置确认，但没有对应的运行环境实跑 |
| 🔴 未验证 | 没跑过也没法跑（缺 key / 缺基础设施），**不许当成已验证** |

> 规矩：读到 🔴 就当它**不存在**。没验过的东西不算数。

---

## 一、已验证可用

### 铁律：dev 态零基础设施可跑 🟢

本轮实测（全新 clone → 独立 node_modules → 全程无 Redis / 无 Postgres / 无任何 API Key / 无 `BEACON_MASTER_KEY`）：

```
cp .env.example .env && npm run setup
  → ✅ 完成：敏感词库 402 条（版本 2026.07）· 算法规则 8 条

npx next dev
  → ▲ Next.js 15.1.6   Environments: .env
  → GET /login                 HTTP 200
  → GET /api/health            {"status":"ok","checks":{"db":"ok","queue":"inprocess",
                                "llm":"mock","hotSource":"mock"}}

登录闭环：
  ① 发码 {"ok":true,"devCode":"258291"}   ← dev 态 Mock 通道回显
  ② 校验 ok=true
  ③ 会话 租户=cmror22x… 角色=owner plan=free
```

⚠️ **这条铁律在本轮之前是断的**：`.env` 被 gitignore，而仓库里**没有 `.env.example`** ——
全新 clone 照 README 跑 `npm run setup` 直接死在 `prisma P1012: Environment variable not found: DATABASE_URL`。
本轮新增了被 git 跟踪的 `.env.example` 修好（见 §三·CI）。

### 测试 🟢

`npm test` —— Vitest，**857 个用例 / 33 个文件，全绿**（另 26 个 Redis 真连用例 skipped），
零外部依赖（不需要 Redis/Postgres/key）。
需要 DB 的用例跑**真 SQLite**（不 mock prisma），每个测试文件独占一份临时库，跑完即删。

覆盖清单见 [README.md](./README.md#测了什么)，**没测到的**同样列在 README（那份诚实清单继续有效）。

> 修复轮期间一度有 1 个 `tests/ratelimit.test.ts` 用例失败 —— 它断言的是**被本轮有意推翻**的
> fail-open 语义。已改为断言 fail-close 默认，并补了 `failMode: 'open'` 的对照用例。**已闭环。**

### 已落地的能力 🟡（逐条读代码核实，非引用旧文档）

| 能力 | 状态 | 落点 |
|---|---|---|
| 验证码登录 / 真实会话 | ✅ 已落地 | `lib/auth.ts`、`lib/session.ts`（由 `AUTH_COOKIE` 解析，**不是**固定 Demo 会话） |
| 成员邀请 | ✅ 已落地 | `app/(app)/members/`、`lib/auth.ts`；token 过期/复用/撤销/跨租户/并发抢占均有用例 |
| RBAC | ✅ 已落地 | `lib/rbac.ts`；15 动作 × 4 角色权限矩阵，`tests/rbac.test.ts` 全 60 格锁死 |
| 敏感词合规 DFA | ✅ 已落地 | 词库 **402 条**（legal 176 / platform 141 / industry 85，版本 2026.07）+ 分平台差异 + 红线硬闸 |
| 红线禁止导出 | ✅ 已接闸 | `app/(app)/studio/actions.ts:84` —— 导出前 `redlineHits` 拦截 |
| AIGC 显式标识 | ✅ 已落地 | `ensureAigcLabel` 接在导出与「复制正文」两个出口；**含校验回环**，见 §二·1 |
| 登录限流 | ✅ 已落地 | `app/login/actions.ts`：发码 10 次/时/IP、校验 20 次/10 分/IP（**无条件生效，没有 env 开关**） |
| LLM 配额 | ✅ 已落地 | `lib/quota.ts`，按 `Tenant.plan` 分日/月档；⚠️ 但 plan 改不了，见 §二·2 |
| 火山引擎短信 | ✅ 代码完成 | 签名 V4 已用**官方对拍向量**逐字节验证；但真实链路 🔴 未验，见 §二·4 |
| BullMQ 三轨编排 | ✅ 代码完成 | `lib/jobs/`；`BEACON_QUEUE=bullmq` 切 Redis，否则进程内。真 Redis 上 🔴 未验 |
| pgvector 向量层 | ✅ 代码完成 | `lib/vector/`、`prisma/postgres/01-pgvector.sql`；真 PG 上 🔴 未验 |
| 备份 / 恢复 | ✅ 脚本完成 | `scripts/backup.sh` / `restore.sh`；**恢复演练 🔴 未做**，见 §二·6 |
| CI | ✅ 已落地 | `.github/workflows/ci.yml`；含 `test`（类型检查+测试+构建）、`ironlaw`（零基础设施铁律）、`redis`（Lua 真执行） |
| 可观测性 | ✅ 已落地 | `/api/health`、`JobRun`、`LlmCallLog`、Sentry 可选 |

---

## 二、真实缺口（**不粉饰**）

### 1. AIGC 导出标识：PDF 无法自动校验 🟢

《标识办法》第四条要求导出文件**中**含显式标识。此前标识能否进最终文件**全靠模型听话，零校验** —— 模型漏一次就是一份违法文件。

本轮补了校验回环（`lib/llm/skills.ts` 的 `verifyAigcLabelInFile`，接在 `app/(app)/studio/actions.ts:97`）：

- **docx / pptx / xlsx（OOXML）→ 可靠可校验**。zip+deflate+XML，Node 内置 zlib 即可解，正文在 `<w:t>/<a:t>/<t>`。校验不过 → **fail closed，中止导出**，绝不交付无标识文件。
- **PDF → 做不到，且我们没有假装做到**。PDF 正文被编码成**子集字体的字形 ID**（实测形如 `<010001000107…> Tj`），要还原 Unicode 必须解析字体的 ToUnicode CMap（pdf-parse / pdf.js 级别的工作量），本项目不引这个依赖。
  **现状（2026-07-23 更正）**：~~PDF 导出照常放行~~ **PDF 导出已在服务端硬闸拦截**（`app/(app)/studio/actions.ts:161`，只放行能自动校验 AIGC 标识的 OOXML 格式）。要重开 PDF 出口需先解决字形 ID 到 Unicode 的还原问题。**此敞口已关闭。**

> 顺带记一条别踩的坑：朴素的 `buffer.includes(AIGC_LABEL)` 对 docx/pptx/pdf **全部返回 false**（实测）。别把校验退化成那种写法 —— 那等于永远 fail，或反过来被人改成永远 pass。

### 2. 计费 / 支付：代码已落地，真实微信支付链路未验 🟡🔴

微信支付 Native 扫码订阅已实现：

- `lib/pay/`（9 文件，~2500 行）：下单 `order.ts` / 签名 `sign.ts` / 二维码 `qr.ts` / 兑现幂等（条件写 + Postgres 行锁 FOR UPDATE）/ 到期懒判断 `plan.ts`。
- `app/api/pay/notify/route.ts`：微信回调验签 + AES-256-GCM 解密 + 幂等兑现。
- `app/(app)/billing/`：升级页 + QR 扫码结账 + 轮询。`billing.manage` 权限由 `billing/actions.ts`（3 处 requireRole）+ `page.tsx` 实现。
- `Tenant.plan` 经 `lib/pay/order.ts:183` 的 `fulfillOrder` 事务内 `tx.tenant.update` 可升档。
- `tests/pay/`（8 文件，225 用例）：覆盖下单 / 兑现幂等 / 金额校验 / 并发回调 / 查单兜底 / 到期降档 / enterprise 降档拦截。

🔴 **真实微信商户号/证书/回调验签未接真 key 验过**。`getPayProvider()` 无真配置时走 Mock。
「容器起来、health 绿」≠ 能真收款 —— 唯一算数证据是真商户号走一笔真单。

#### ~~2b. 准入计数器与账本会漂移，用户会看到「0/30 但已用尽」~~ ✅ 已修（2026-07-23）

~~本轮修配额并发突破时引入了两套数，口径不同，会对不上账。~~

**已修**：`lib/llm/gateway.ts` 现在在 provider 失败降级 Mock 时调用 `releaseLlmQuota` 归还名额（方案 ①「调用失败不占名额」）。
准入计数器与账本口径已对齐：降级 Mock 的调用不占额度，仪表盘显示与实际剩余一致。

### 3. 真实数据源：全走 Mock（缺商业 key）🟡

适配器接口（`SourceAdapter`）已就位，**填 key 即切真，填哪个切哪个**，但目前一个真实源都没接：

| 源 | 需要 | 现状 |
|---|---|---|
| 竞对（抖音/小红书） | TikHub key | Mock |
| 竞对（公众号） | 新榜 key | Mock |
| 竞对（YouTube） | YouTube Data API v3 | Mock |
| 竞对（X） | twitterapi.io key | Mock |
| 热榜 | 自部署 DailyHotApi 实例（`BEACON_DAILYHOT_BASE_URL`） | Mock（60s 公开实例可用） |
| LLM | 任意 OpenAI 兼容 key / BYOK | Mock（确定性假数据） |
| 向量嵌入 | BGE-M3 或云 embedding | 降级为关键词匹配 |

这是**商业/物理边界，不是未实现** —— 但对「能不能上线」而言，**现在给用户看到的所有热榜与竞对数据都是假的**。
产品上必须先接通至少一个真实源，否则第一天就会被用户发现。

### 4. 火山短信：真实链路未验 🔴

- 🟢 签名算法：四级密钥派生 + 端到端 Signature 已用**官方对拍向量**逐字节命中 —— 拿到真 AK/SK 之前就证明了算法正确。
- 🔴 **但 AK/SK 鉴权、IP 白名单（RE:0007）、签名/模板过审、模板变量名（`code` vs `verifyCode`）全部没接真 key 验过**，`fetch` 全程是 mock。

⚠️ 且 fail-fast 是**懒校验**，在**第一次发码**时才炸，不是启动时（顶层 throw 会打挂 `next build`）。
**「容器起来了、health 全绿」不代表短信是通的。** 唯一算数的证据：拿真手机号走一遍登录。

### ~~5. RLS 行级隔离：策略写了，但没接上~~ ✅ 已落地并实测（2026-07-23 更正）

此前结论（「RLS 是装饰」）已被后续修复推翻：

- 🟢 `prisma/postgres/02-rls.sql` 现在对 **31 张表**均设置了 `FORCE ROW LEVEL SECURITY`（表 owner 也不再绕过）。
- 🟢 `lib/tenant-rls.ts` 的 `withTenant()` 现由 `lib/session.ts:52` 调用，所有走 session 的请求均设置 `app.current_tenant`。
- 🟢 **真 Postgres 实测（2026-07-22）** 六项全过：①无上下文全量 ②租户上下文只见自己 ③二级归属表隔离 ④伪造租户 0 行 ⑤跨租户写入被策略拒绝 ⑥同租户写入正常。
- 🟢 实测还抓出连接池下 `set_config(is_local=true)` 事务提交后变空字符串（不是 NULL）的 bug，已在 `app_current_tenant()` 里用 `nullif(..., '')` 归一修复，一处修好全部 31 张表。

**净结论**：RLS 现在是**真实防线**，与应用层 `tenantId`/`workspaceId` 过滤构成双层隔离。仍未实测：两份 schema 的字段级差异、pgvector 检索。

### 6. 恢复演练：没做过 🔴

`scripts/backup.sh` / `restore.sh` 已写好（`-Fc` 格式、导出后 `pg_restore --list` 自检、7 日备+4 周备、可选 AES 加密）。

但 —— **没验证过恢复的备份等于没有备份。** 迄今**没有任何人从备份把库恢复出来过一次**。
步骤见 `docs/生产化部署.md`「恢复演练」，上线前必须做一次，**且要一并验证 BYOK 能解开**（主密钥丢了 = 库恢复出来也全是乱码）。

### 7. 其余未覆盖 🔴

- **Redis 限流路径**：本机无 Redis，只测了进程内实现。`lib/ratelimit.ts` 的 Lua 脚本、`ZRANGE WITHSCORES` 解析、整数转换**从未在真 Redis 上跑过**。
- **多实例限流**：进程内实现下每实例独立计数，实际放行量 ≈ limit × 实例数。生产必须配 `REDIS_URL`。
- **反代 XFF**：🟢 修复前限流按 `X-Forwarded-For` **最左**取值，实测伪造该头即可换桶绕过 IP 闸门（每换一个假 IP 就领一份新配额）。**已修**：现按 `BEACON_TRUSTED_PROXY_HOPS` 取 XFF **右起第 N 跳**（最左永远是客户端自己写的，任何拓扑下都不可信）。覆写/追加两种反代语义均支持，单层都配 `1`。
  - ⚠️ **残留部署约束（代码无法自愈）**：`BEACON_TRUSTED_PROXY_HOPS` 默认 `0` = 生产态 IP 一律判 `unknown` = **全站共用一个限流桶**（约 30 个请求即可瘫痪整站登录，fail-close 型 DoS）。而填大了/前面无反代则**重新打开伪造绕过**。必须精确等于实际反代层数 —— 见 `.env.production.example` §9.5 与 `docs/生产化部署.md`「可信代理层数」。
  - ⚠️ 本仓库 `docker-compose.yml` **不含反代**，裸跑必然退化为全局桶。生产须自行加一层反代。
- **Postgres / pgvector**：单测跑 SQLite，生产是 Postgres。向量检索仍未覆盖。
  🟢 **RLS 已在真 Postgres 上实测（2026-07-22）**：docker 起 postgres:16 → `prisma db push`（postgres schema）
  → 应用 `02-rls.sql` → 建 `rolbypassrls=false` 的非 superuser 角色 → 两租户对拍。六项全过：
  ①无上下文全量 ②租户上下文只见自己 ③二级归属表（DraftVersion→Draft→CreatorAccount）同样隔离
  ④伪造租户 0 行 ⑤跨租户写入被策略拒绝 ⑥同租户写入正常。
  🐛 **实测抓出一个会导致生产静默故障的既有 bug**：自定义 GUC 被 `set_config(..., is_local=true)` 设过后，
  **事务提交并不会让它回到 NULL，而是变成空字符串**。连接池下，用户请求跑完一次 `withTenant` 归还连接，
  worker/cron/支付回调稍后抽到同一条连接时本以为命中「NULL 放行」，实际拿到 `''` → **一行都读不到**，
  且时灵时不灵取决于抽到哪条连接。修法是在 `app_current_tenant()` 里 `nullif(..., '')` 归一，
  一处修好全部 31 张表的策略。**此前的生产验证只覆盖了「全新连接」这一种情况，所以没暴露。**
  仍未实测：两份 schema 的字段级差异、pgvector 检索。
- **React 组件 / 页面**：单测里一个都没测（RBAC 的页面渲染门只验了 `can()` 纯函数）；
  🟢 但 6 条 e2e 冒烟已覆盖 5 个关键页面的真实渲染与交互。
- **Server Actions**：多数 `app/**/actions.ts` 仍未测；🟢 例外是 `topics/actions.ts` 的投票
  （`tests/topic/vote.test.ts`，含跨账号越权与级联删除）与 `inspiration/actions.ts` 的挖问题（走 e2e）。
  成员管理的业务边界（owner 不可移除/降级）**只在 actions 里实现，仍无覆盖**。
- ~~**端到端**：无 Playwright~~ **🟢 2026-07-22 已通**：`e2e/smoke.spec.ts` 6 条冒烟全绿
  （登录冷启动 / 技能安装 / 选题生成 + 三队列 / 灵感收集箱 + 评论挖问题 / 爆款基因空态 / 帮助页入口）。
  修的时候发现**这套 e2e 从来没跑通过**，两个真 bug：
  ① `playwright.config.ts` 的 `DATABASE_URL` 写成相对路径 `file:./prisma/dev.db`，
     而 Prisma 按**相对 schema 目录**解析 → 实际指向 `prisma/prisma/dev.db`，登录第一步就
     「Unable to open the database file」（`tests/setup/global-setup.ts` 对同一个坑早有注释，e2e 漏了）；
  ② 登录 helper 没勾 F9-8 的合规同意框，而不勾就是 disabled 按钮，所有用例卡在第一个动作。
  仍未覆盖：邀请加入、导出链路、移动端视口。
- **worker / 队列 / 定时任务**：`lib/jobs/*` 未覆盖。

### 8. 产品功能（PRD 有、这版没做）🟡

- 自有账号历史回溯的真实拉取（F9-2，现靠 CSV 导入）。
- 记忆的在线编辑（现支持查看 + 删除 + 累计生效，编辑较弱）。
- 团队协作的审批流。
- 移动端深度适配（响应式有基础）。
- PRD V1.2 合入未完成：F10/F11/F12 三模块 + §16 技术选型章节尚未并入 PRD 正文。

---

## 三、CI 铁律验证 ✅ 已修

`.github/workflows/ci.yml` 的 `test` job 原注释声称「CI 每次在替我们验铁律」，
实际上它自己在 job 级 env 里注入了 `DATABASE_URL`，结构上就发现不了全新 clone 起不来的问题。

**已修**：
- `test` job 注释已修正，不再声称自己在验铁律。
- 新增独立 `ironlaw` job，**刻意不设 `DATABASE_URL`**，全靠 `cp .env.example .env`：
  - 先验「无 .env 时 setup 必须失败」（锁住 `.env.example` 不被删/改坏）。
  - 再 `cp .env.example .env && npm run setup`。
  - 最后起 `next dev` 并探活 `/login`（200）+ `/api/health`（`status: ok`）。

---

## 四、上线前必须做的（按优先级）

1. **接一个真实数据源打通端到端**（成本最低：自部署 DailyHotApi + 一个 DeepSeek key）。现在满屏假数据。
2. **微信支付真实验证**：支付代码已就位，上线前用真实商户号跑一笔真单验证回调闭环（§二·2）。
3. **真手机号实测短信**（§二·4）—— 短信不通 = 没人能注册 = 产品不存在。
4. **加一层反代 + 把 `BEACON_TRUSTED_PROXY_HOPS` 设成实际层数 + 实测伪造头绕不过限流**（§二·7）
   —— 代码已堵死伪造绕过，但**默认值 `0` 会让整站登录共用一个桶**；配大了则伪造绕过原样回来。
   这是本次交付里唯一「代码正确但默认部署形态仍不可用」的点。
5. ~~真 PG 上验 RLS 到底生不生效~~ ✅ 已验通过（§二·5），31 表 FORCE RLS + 六项实测全过。
6. **做一次恢复演练**（§二·6）。
7. ~~PDF 出口的 AIGC 敞口~~ ✅ 已关闭：PDF 导出已在服务端硬闸拦截（§二·1）。
8. 真 Redis 上跑一遍限流 Lua（§二·7）。

---

## 五、本轮审查确认成立的问题

本轮由对抗式审查队伍审出 **16 条经独立验证成立**的问题（每条都由独立 agent 实跑复现，非推断）。
**修复已合并**，并由回归轮独立复验（`npm test` 410/410、`npx tsc --noEmit` 零错、
`npm run build` 通过、`npx tsx scripts/verify-flows.ts` 34 PASS / 0 FAIL）。

合并后的整体结论：

| 类别 | 结论 |
|---|---|
| 账号接管（devCode 生产回显 / SMS 静默回退 Mock） | ✅ 已修，双层防线（`lib/auth.ts` 的 `!isProd() && sms.mocked` + `lib/sms/provider.ts` 生产态 throw），🟢 实测 prod 阻断 / dev 回显 |
| 验证码尝试上限并发绕过、配额并发突破 | ✅ 已修（条件写 `updateMany` / 原子准入计数器），🟢 进程内路径实测；**Redis Lua 路径零执行覆盖**（见 §二·7） |
| 限流伪造 XFF 绕过 | ✅ 代码已修；⚠️ **默认部署形态仍不可用**（`hops=0` → 全站单桶），见 §四·4 |
| 限流存储故障静默常开 | ✅ 已改 fail-close 默认 + 显式 `failMode:'open'` 出口；对应测试已同步翻面 |
| RBAC 写操作无守卫（30+ 处） | ✅ 已修，🟢 回归实跑核实：全部 server action 均有守卫，仅 `actLogout`/`actRequestCode`/`actVerifyCode` 无（符合预期） |
| AIGC 标识误判 / 导出校验回环 / 红线硬闸 | ✅ 已修；⚠️ PDF **无法自动校验**（子集字体字形 ID，需 ToUnicode CMap），已按底线改 UI 措辞 |
| dev 零基础设施铁律 | ✅ 未破坏，🟢 fresh clone 实测 setup → dev → 登录 → 各页 200 全通 |

**未闭环的**（如实留在 §二/§四，不因「修复轮结束」而消失）：
Redis Lua 零执行覆盖、微信支付真实链路未验、`BEACON_TRUSTED_PROXY_HOPS` 的部署契约。

> 2026-07-23 已闭环移出：~~RLS 是装饰~~（31 表 FORCE + 实测六项全过）、~~PDF 的 AIGC 敞口~~（服务端硬闸已拦截）、~~准入计数器与账本漂移~~（gateway 失败时归还名额）。

本文档负责人已修复并实跑验证的部分：

| # | 问题 | 状态 |
|---|---|---|
| 1 | `.env.production.example` 里 `BEACON_SMS_VENDOR=""` 留空 → 生产回退 Mock → 验证码明文回显 → 账号接管（配置侧） | ✅ 模板默认值改为 `"volcengine"` 并写明生产留空是**拒绝服务**而非降级；代码侧由 `lib/sms/provider.ts` 的 fail-fast 堵（🟢 实测 prod 留空即抛错、dev 留空仍走 Mock） |
| 2 | 全新 clone 跑不起来：无 `.env.example`，`npm run setup` 死在 P1012 | ✅ 新增被 git 跟踪的 `.env.example`（🟢 实测修前 P1012 / 修后 setup+起服务+登录全通）；README 补 `cp .env.example .env` |
| 3 | 反代 XFF 这条硬约束只存在于代码注释，文档从未写过 | ✅ `docs/生产化部署.md` 补 Nginx 片段 + 数 hops 的方法 + 检查清单项；`.env.production.example` 补 §9.5（🟢 实测伪造头可绕过修复前的实现）。<br>⚠️ 回归时按最终代码校正过两处：①「必须覆写不能追加」是**旧结论**——现按右起第 N 跳取值，两种语义都支持；②「不确定就留 0，会按直连 IP 算」是**错的**——应用层拿不到直连 IP，留 0 = 全站单桶。 |
| 4 | `.env.production.example` 的 `BEACON_QUOTA_ENABLED` 注释与代码行为**相反** | ✅ 按实测行为重写（它**不控制限流**；「不填」在 prod 是**默认开**不是关）|
| 5 | 本文档整份过期（逐条断言与代码相反） | ✅ 即本次重写 |

> 附带发现（不在原 16 条内，🟢 已核实）：
> - ~~`lib/tenant-rls.ts` 的 `withTenant()` 零调用点~~ ✅ 已修：`withTenant` 现由 `lib/session.ts:52` 调用，RLS 31 表 FORCE + 实测通过（§二·5）。
> - `.github/workflows/ci.yml` 的「CI 在替我们验铁律」是假的（§三，已修）。
>
> 支付轮审查（4 lens × adversarial verify，10 条发现 / 4 条成立 / 6 条驳回）：
> - ✅ 已修：fulfillOrder 并发丢失更新（同租户两笔不同订单 → Postgres READ COMMITTED lost-update）→ FOR UPDATE 行锁。
> - ✅ 已修：enterprise 降档绕过（`isPaidPlan('enterprise')===false` 绕过降档闸门）→ `effectivePlan` 前置拦截。
> - ✅ 已修：studio 登记发布路径缺 AC③ AIGC 声明硬闸 → server guard + 弹窗表单。
> - ✅ 已修：本文档 §二·2 过期（声称支付不存在，实际已全量实现）→ 本次重写。
