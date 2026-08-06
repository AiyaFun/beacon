# 后端如何用 API 调用 Skill（Agent Skills）

「Skill」= Anthropic **Agent Skills**：带 `SKILL.md` 的能力包。官方内置 `pptx`/`docx`/`xlsx`/`pdf`，也可注册自建 skill。后端有两条调用路径。

> 硬约束：Agent Skills 只在 **Anthropic 官方 Messages API** 上可用，必须用官方 API Key（`x-api-key`），不能用任意 OpenAI 兼容端点。本项目已在 `lib/llm/skills.ts` 封装路径 A。
> **但导出功能已不再依赖它**——默认走本地渲染（见文末「本地版技能怎么做」），这条通道只是可选增强。
> 合规：此通道走海外端点，生成内容仍需过本项目合规检测；面向中国公众的正式发布默认不用它（PRD §10.5），仅企业版 + 出海/内部工具场景启用。

---

## 路径 A：Messages API + 代码执行容器（一次性、无状态）

最适合「生成一份 PPTX/DOCX/图表」。关键三件套：`container.skills` 挂 skill、`code_execution` 工具、两个 beta header。

```ts
const res = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-api-key': process.env.BEACON_ANTHROPIC_API_KEY!,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'code-execution-2025-08-25,skills-2025-10-02,files-api-2025-04-14',
  },
  body: JSON.stringify({
    model: 'claude-opus-4-8',
    max_tokens: 16000,
    container: { skills: [{ type: 'anthropic', skill_id: 'pptx', version: 'latest' }] },
    tools: [{ type: 'code_execution_20260521', name: 'code_execution' }],
    messages: [{ role: 'user', content: '把这段内容做成 3 页演示文稿……' }],
  }),
});
```

- skill 在容器里执行，产物（`.pptx` 等）写进容器，响应 `content` 里带每个文件的 `file_id`。
- 用 Files API 下载：`GET /v1/files/{id}/content`，带 `anthropic-beta: files-api-2025-04-14`。

**本项目已封装**，直接调用：

```ts
import { exportDeliverable, downloadSkillFile } from '@/lib/llm/skills';

const r = await exportDeliverable({ format: 'pptx', title: '起号第一周', content: draftText });
const file = await downloadSkillFile(r.files[0].fileId); // { data: Buffer, filename }
```

用 SDK 亦可（等价，需 `npm i @anthropic-ai/sdk`）：

```ts
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic();
const response = await client.beta.messages.create({
  model: 'claude-opus-4-8', max_tokens: 16000,
  container: { skills: [{ type: 'anthropic', skill_id: 'pptx', version: 'latest' }] },
  tools: [{ type: 'code_execution_20260521', name: 'code_execution' }],
  betas: ['code-execution-2025-08-25', 'skills-2025-10-02'],
  messages: [{ role: 'user', content: '……' }],
});
// 从 response.content 找 file_id，再 client.beta.files.download(fileId)
```

## 路径 B：Managed Agents（有状态、可长跑）

把 skill 挂在 **agent** 上（不是 session），开 session 跑。适合长任务、需要工作区/多轮的场景。

```ts
const agent = await client.beta.agents.create({
  name: 'Deliverable Agent',
  model: 'claude-opus-4-8',
  skills: [
    { type: 'anthropic', skill_id: 'xlsx' },
    { type: 'custom', skill_id: 'skill_abc123', version: 'latest' },
  ],
  tools: [{ type: 'agent_toolset_20260401' }],
});
// 之后 sessions.create({ agent: agent.id, environment_id }) 再发 user.message
```

要点：agent 建一次、存 ID 复用;`model/system/tools/skills` 都在 agent 上,session 只引用 ID。

## 注册自建 Skill（Skills API）

把自己的 `SKILL.md` + 附件打包上传,拿到 `skill_id`,即可在路径 A/B 里以 `{ type: 'custom', skill_id }` 引用:

| 操作 | 方法 · 路径 |
|---|---|
| 创建 skill | `POST /v1/skills` |
| 列出 | `GET /v1/skills` |
| 建版本 | `POST /v1/skills/{id}/versions` |

需 header `anthropic-beta: skills-2025-10-02`。

---

## 在 beacon 里怎么用（现状）

**默认不走上面这条路。** 导出的默认实现是本地渲染，Anthropic Agent Skills 降级为「租户配了 Claude 渠道才用」的可选增强。

创作工坊「导出」按钮 → `actExportDeliverable`：
- 有 Claude Key → `exportDeliverable()` → `file_id` → `downloadSkillFile()`
- 没有（默认）→ `renderLocalDeliverable()`（`lib/deliverable/registry.ts`）
- 两条路汇合后统一 `injectAigcDocProps` + `verifyAigcLabelInFile`，未检出标识一律 fail closed

---

## 本地版「技能」怎么做（不依赖 Anthropic）

一个技能 = **规划**（提示词把自由文本变成结构化大纲）+ **渲染**（确定性代码把大纲变成文件字节）。
Anthropic 把两者焊死在它的容器里，所以只能整包用、且只能用它家 Key。拆开之后：

| | 谁做 | 依赖 |
|---|---|---|
| 规划 | `lib/deliverable/outline.ts` → `llmComplete(json:true)` | **任意模型**（DeepSeek/通义/豆包/Claude 皆可，走项目现有 OpenAI 兼容网关） |
| 渲染 | `pptx.ts` / `skills.ts:buildDocxLocal` / `card.ts`（图文卡） | 零依赖，零模型 |

一份大纲（`Deck`）→ 三种渲染。产物有两类，注册表用 `output` 区分：
- `file`：直接产字节（docx/pptx），服务端可跑 `verifyAigcLabelInFile` 校验回环；
- `ops`：产**绘制指令**（图文卡），由浏览器 canvas 落成 PNG（`lib/deliverable/canvas.ts`）——
  服务器因此不需要 chromium、中文字体或任何原生依赖，代价是不同系统字体略有差异。

规划有三级降级，导出永不失败：稿子自带 Markdown 结构 → 直接按结构切页（零 token，且尊重用户原结构）；
无结构长文 → 请模型切页；模型不可用/返回垃圾 → 按段落机械切页。

### 加一种格式的清单

1. 写 `render(deck | content) => Buffer`，**AIGC 显式标识必须由渲染器自己写入**（pptx 是每页页脚），
   不能靠提示词求模型保留——这正是 Skills 路径唯一真实的合规风险点；
2. 在 `LOCAL_SKILLS` 注册表加一条（`lib/deliverable/registry.ts`）；
3. 确认 `verifyAigcLabelInFile` 能真校验该格式（OOXML 可以，PDF 不行）；不能真校验的**不要进导出白名单**。

### 图文卡模板

`CARD_THEMES`（`card.ts`）四套：极简白 / 杂志红 / 深色夜间 / 便签黄。
模板只管**颜色 + 封面构图 + 标题装饰**；边距、字号刻度、分页规则四套共用——
那部分是「放得下、看得清」的物理约束，不该跟着风格变（用例里有一条就在守这个：
四套排出来的张数必须一致）。加一套 = 加一条配置。

四套的绘制指令**一次全排出来**下发给客户端，切模板只是换一份指令重画：不再调模型、不再等。

### 图片这条路的合规边界（别搞混）

图片的**显式**标识画在像素上，从字节里验不了（要 OCR），所以：
- 显式标识靠「`card.ts` 每张卡强制画一行」保证，客户端没有能删掉它的路径；
- 可字节校验的只有**隐式**标识——PNG 的 iTXt 分块（`png-meta.ts`，用 iTXt 不用 tEXt，因为服务提供者名是中文）；
- 因此 `LOCAL_SKILLS.card.labelVerifiable = false`，如实标注，不假装做了校验回环。

zip / OOXML 原语在 `lib/deliverable/zip.ts`（`buildZip` / `readZipEntries` / `crc32`，Node 内置 zlib，无第三方依赖）。

### pptx 的部件图（最小可用）

`[Content_Types].xml`、`_rels/.rels`、`ppt/presentation.xml`(+rels)、`slideMasters/slideMaster1.xml`(+rels)、
`slideLayouts/slideLayout1.xml`(+rels)、`theme/theme1.xml` —— 这 6 个是**一次写死的骨架**，
每次导出只有 `ppt/slides/slideN.xml` 在变（几个文本框而已）。

两个踩过的坑：
- `<a:pPr>` 子元素顺序是 schema 硬约束（lnSpc → spcBef → buFont → buChar/buNone）。写反了 PowerPoint 弹「需要修复」，
  **而 python-pptx 之类宽松读者照样读得出来**——别拿「解析器能读」当验收标准；
- `docProps/custom.xml` 只写 `[Content_Types].xml` 不挂包级关系，Office 的「属性 → 自定义」里看不到隐式标识，
  等于第五条白做。

验收方式（本轮实际用的）：`xmllint` 逐部件查良构 → `python-pptx` 真读一遍文本 → `qlmanage -t` 出缩略图看版式。
