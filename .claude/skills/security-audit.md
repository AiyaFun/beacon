---
name: security-audit
description: "Audit codebase before commit/push or review code changes to prevent credential-minting script leaks, temporary debug files, and fail-open endpoint vulnerabilities."
user_invocable: true
---

# /security-audit — 安全合规与防泄露审计门禁

在执行代码提交（`git commit`）、推送（`git push`）、发布公网（`/push`）或进行敏感逻辑重构前，必须执行本 Skill。
本 Skill 专门拦截两大典型安全事故：
1. **调试脚本与凭据生成脚本误入代码库**（如根目录 `login-tmp.ts` 等未清理的免密/Ticket生成代码）；
2. **接口鉴权默认放行（Fail-Open）与边缘配置泄露**（如 `/api/health` 等探针在环境变量缺失或错配时泄漏内部拓扑）。

---

## 检查项 1：根目录与非测试目录的临时/调试脚本拦截

### 规则
- 根目录、`app/`、`lib/`、`scripts/` 下严禁提交任何带有临时性质的测试/调试脚本（如 `*-tmp.ts`, `*tmp*.ts`, `repro-*.ts`, `test-*.ts` 等）。
- 严禁在测试目录（`tests/`）之外调用凭据生成与内部绕行方法：
  - `issueLocalLoginTicket`（免密/Magic Link 票据生成）
  - `issueApiToken`（API 访问 Token 签发）
  - 裸查询特定租户（如 `contains: '9520'`）并打印免密登录链接的操作。

### 自动化执行审计命令
在终端运行以下扫描，**若有任何输出则立即拦截**：

```bash
# 1. 检查已追踪或暂存的文件中是否存在临时脚本命名
git ls-files | grep -E '(^|/)(.*-tmp|.*tmp.*|repro-.*)\.(ts|js|mjs)$' || true

# 2. 检查根目录是否存在单发脚本调用凭据签发，或非受控路径调用 issueLocalLoginTicket
find . -maxdepth 1 -name '*.ts' -exec grep -HnE 'issueLocalLoginTicket' {} + || true
grep -rnE 'issueLocalLoginTicket' . \
  --exclude-dir=tests \
  --exclude-dir=node_modules \
  --exclude-dir=.next \
  --exclude-dir=.git \
  --exclude="local-link.ts" \
  --exclude="actions.ts" || true

# 3. 检查代码库中是否有打印本地免密链接的残留代码
grep -rn 'api/auth/local/magic' . \
  --exclude-dir=tests \
  --exclude-dir=node_modules \
  --exclude-dir=.next \
  --exclude-dir=.git \
  --exclude="local-link.ts" || true
```

---

## 检查项 2：接口鉴权与环境判定的“默认安全”（Fail-Safe / Default-Closed）

### 规则
1. **杜绝“负向判定导致未定义即放行”的反模式**：
   - ❌ **严重反模式**：
     ```typescript
     // 危险：如果生产环境运维漏配了 BEACON_ENV 或写错变量名，直接裸奔放行！
     if (!token) return process.env.BEACON_ENV !== 'prod';
     ```
   - ✅ **标准正向白名单模式**：
     ```typescript
     // 安全：只有强正向断言在本地开发环境，才允许回显详情；任何生产、未知或未定义环境一律隐藏
     if (!token) {
       return !isProd() && process.env.NODE_ENV === 'development';
     }
     ```
2. **统一运行环境判定来源**：
   - 生产环境判定必须统一引入 `@/lib/env` 中的 `isProd()`，严禁在各业务文件/路由中自行编写 `process.env.NODE_ENV === 'production' || process.env.BEACON_ENV === 'prod'`。
3. **探针与公共接口（如 `/api/health`）脱敏原则**：
   - 公开探针默认只返回 HTTP 状态码及状态汇总 `{ status: 'ok' | 'degraded' }`。
   - 包含 DB 连通错误明细、队列模式（`bullmq`/`inprocess`）、调度器形态、LLM API 配置状态等底层组件信息的 `checks` 对象，**必须通过请求头携带 Token（如 `x-beacon-health-token` 或 `Bearer`）验证通过才可输出**。

### 自动化执行审计命令
```bash
# 检查是否存在散落的手写生产环境判定（必须统一从 @/lib/env 引入 isProd）
grep -rnE 'process\.env\.(NODE_ENV|BEACON_ENV)\s*[!=]==?' app/ \
  --exclude-dir=node_modules || true
```

---

## 检查项 3：静态敏感凭证与私钥扫描（Secret Scan）

对暂存区与全仓库进行高危密钥与私钥材料扫描：

```bash
# 1. 扫描私钥材料（排除合法测试桩）
grep -rlE "BEGIN (RSA |EC |ENCRYPTED )?PRIVATE KEY" . \
  --exclude-dir=.git \
  --exclude-dir=node_modules \
  --exclude-dir=.next \
  --exclude='official-key.ts' \
  --exclude='redact.ts' \
  --exclude='redact.test.ts' || true

# 2. 扫描明文 API 密钥
git diff --cached -S"sk-" --pickaxe-regex || true
git diff --cached -S"AKIA" --pickaxe-regex || true
```

---

## 检查项 4：.gitignore 防御完整性验证

确保以下容易产生临时泄漏的模式已包含在 `.gitignore` 中：

```
*-tmp.*
*tmp*.ts
*tmp*.js
*.scratch.*
repro-*.ts
.env* (除 .env.example)
```

使用以下命令确认无临时文件漏网：
```bash
git status --porcelain | grep -E '(\.env|tmp|\.scratch)' || true
```

---

## 执行流程与决策表

当运行 `/security-audit` 时，按以下顺序执行：

1. **Step 1: 扫描工作区与暂存区**
   - 运行上述检查命令 1~4。
2. **Step 2: 结果裁决**
   - **PASS**：所有检查项输出均为空，无临时脚本、无负向鉴权兜底、无私钥泄露。输出 `✅ 安全审计通过`。
   - **FAIL**：发现任何违规项，**立即中止后续提交/推送**：
     - 若为临时脚本：指导执行 `git rm <file>` 并将其加入 `.gitignore`。
     - 若为 Fail-Open 鉴权：使用 `isProd()` 改造为默认关闭的白名单模式。
     - 若为私钥/Token：执行脱敏并引导替换为环境变量占位符。
3. **Step 3: 运行自动化回归测试**
   - 执行 `npx vitest run tests/api/health.test.ts` 确保鉴权守卫用例全部通过。
