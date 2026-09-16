# 整机版 / 私有化：用 ChatGPT 订阅跑模型（不用 API Key）

2026-09-15 起，整机版与私有化部署可以直接用你自己的 **ChatGPT Plus / Pro 订阅**当模型渠道——
文本生成、执行模式（工具调用）、看图（视觉）、封面生图都能走它，用量算在订阅里，不按 token 付费。

这条路与 OpenClaw、Hermes Agent 用的是同一条：**不是去调 `codex` 命令行**，而是把 Codex CLI 的登录协议
（device-code OAuth）搬进产品，拿到你的登录态后按 Responses API 的形状直接调 OpenAI 的 Codex 后端。
OpenAI 自 2026-05 起明确允许第三方工具走订阅 OAuth。

> **为什么只有 ChatGPT、没有 Claude**：Anthropic 自 2026-04-04 起禁止任何第三方用 Claude 订阅（Free/Pro/Max）的
> OAuth；Claude 只能走 API Key。产品不建在灰路上。

> **SaaS 版没有这一项**：订阅是你个人的，平台不能替你用（多租户共用一台机器）。这个能力在
> `lib/edition.ts` 的 `chatgptSubscription` 那一格被 SaaS 恒关，服务端动作也会直接拒绝。

## 接入（两种，任选）

到「设置 → 接入与密钥」，最上方有一张「ChatGPT 订阅（不用 API Key）」卡：

1. **用 ChatGPT 账号登录**：点一下，页面显示一串码和 OpenAI 的链接（`https://auth.openai.com/codex/device`）。
   在浏览器里登录你的 ChatGPT、输入那串码；这一页每几秒自己检查一次，登好就自动接上。
   密码永远只在 OpenAI 的页面里输入，不经过烽火台。
2. **从本机 Codex CLI 导入**：如果这台机器上已经 `codex login` 过（用 ChatGPT 账号），
   直接读 `~/.codex/auth.json`，顺带把 `~/.codex/config.toml` 里的默认模型带过来。
   ⚠️ 导入后两边共用同一份登录态：refresh token 续期时会轮换，哪边先续，另一边下次续期可能失败、要重新登录一次。
   长期用建议走第 1 条，各登各的。

接入后它就是一条普通的模型渠道：连通性测试、设为默认、按功能路由，都在同一张列表里。
登录态信封加密存库（与 API Key 同一套），到期自动用 refresh token 续；续不动（被吊销/过期）时会明确报
「登录已失效，请重新登录」，不会静默换渠道。

## 能走它的功能

| 功能 | 怎么走 |
|---|---|
| 内容生成 / 选题打分 / 智囊团 / AI 助手对话 / 执行模式 | 在「功能路由」把该功能指到它，或把它设为默认渠道 |
| 看图（视觉，读后台截图等） | 没配 `BEACON_VISION_LLM_MODEL` 时自动走它（GPT 系列本就多模态） |
| 封面生图 / 正文配图 | **只在你显式把「封面生图」指到它时**才用（Responses 的 `image_generation` 工具）。它出的图没有方舟那种服务端强制的显式水印，隐式标识照常注入——接受了再指 |
| 视频理解 | 不走它（仍只走火山方舟豆包） |

## 模型与限额

- 模型名填 Codex CLI 里 `/model` 能用的那些（导入时会自动带上你 Codex 的默认模型；默认 `gpt-6-astra`）。
  「推理强度」low / medium / high 对应 Responses 的 reasoning.effort，内容生成一般 medium 够用。
- 限额跟着你的 ChatGPT 套餐走（Codex 的用量窗口）。撞到限额时调用会报「ChatGPT 订阅的用量额度用完了」，
  **不会**静默换渠道。夜间打分、半小时一次的聚类这类后台任务如果也指到它，建议另配一条兜底渠道设为默认。

## 零代码的另一条路：hermes proxy

不想让烽火台保存你的登录态，也可以让 Hermes Agent 在本机起一个 OpenAI 兼容端点（`hermes proxy`），
背后是你的订阅，然后把整机版的默认渠道指过去：

```bash
# .env
BEACON_DEFAULT_LLM_BASE_URL=http://127.0.0.1:<hermes proxy 端口>/v1
BEACON_DEFAULT_LLM_API_KEY=any
BEACON_DEFAULT_LLM_MODEL=<模型名>
```

这条路烽火台一行代码都不用改（走的是现成的 `OpenAICompatibleProvider`），代价是要自己维护 Hermes。

## 排查

- 「登录已失效」：到卡片上重新登录一次即可，几个月一次。
- 「用量额度用完了」：等窗口恢复，或临时把功能路由改到别的渠道。
- 「ChatGPT 没有返回图片」：这个模型/账号可能不支持生图工具，把「封面生图」改指回方舟。
- 服务端日志模块名 `llm-chatgpt`。
