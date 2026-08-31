// AI 工具的**契约层**（2026-08-30 从 tools.ts 抽出来）。
//
// ── 为什么要单独一个文件 ──
// 抽之前，四个 tools-*.ts 都得 `import type { AgentTool } from './tools'`，
// 而 tools.ts 又反过来 import 那四个文件——**这是一个循环依赖**。
// 它一直没炸，只因为兄弟那一侧全是 `import type`（编译期擦掉了，运行时没有这条边）。
//
// 【代价已经在付了，只是看不出来】`str` / `num` / `clamp` 这三个五行小函数，
// 在 tools.ts 与三个兄弟文件里**各抄了一份，一共五份**。为什么不复用？因为一旦写成
// `import { clamp } from './tools'`，type-only 就变成了真 import，循环就成了真循环
//（模块初始化时拿到 undefined，而且报错现场离病根十万八千里）。抄一份最省事。
// 所以「五份重复的 clamp」不是懒，是那条循环依赖留下的齿痕。
//
// 抽出来之后依赖是单向的：tool-types ← 四个兄弟 ← tools.ts。
// 新加一个 tools-*.ts 时从这里 import，不要再从 './tools' 拿。

import type { ToolDef } from '../llm/types';
import type { Action as RbacAction } from '../rbac';

// ── AI 能调用的系统能力清单 ────────────────────────────────────────────────
//
// 【边界，先说死】这里注册的**就是** AI 能做的全部事情。没注册的它做不了，
// 也不存在「让 AI 写段代码执行一下」的通道——那等于把任意代码执行挂在对话框里。
// 想让 AI 会一件新事，唯一的路是在这张表里加一个工具（于是它天然带着权限、审计、确认）。
//
// 【每个工具三个必答问题】
//   ① 它要哪个 RBAC 动作？—— 按**发起人**的角色判，不是按工作区里权限最大的人判；
//   ② 它是不是写操作？—— 写操作一律先停下来问用户（lib/agent/run.ts 的确认闸）；
//   ③ 它花不花钱？—— costly=true 的即使是「读」也要确认（模型调用/生图都是真金白银）。
//
// 【返回值给谁看】工具返回的是**给模型看的结构化摘要**，不是给人看的界面文案。
// 所以要短、要有 id（模型下一步可能要用）、要如实说「没有」而不是编一个空壳。

export type ToolContext = {
  /**
   * 这次执行的 id。**产物登记与嵌套判定都靠它**。
   *
   * 可空是因为工具也会被别的地方直接调（页面上的按钮、定时任务）——
   * 那些场景没有「一次 AI 执行」这个上下文，产物自然也不必挂到谁头上。
   */
  runId?: string;
  tenantId: string;
  workspaceId: string;
  accountId: string;
  memberId: string;
  role: string;
  /** 超时取消信号。工具内部的 fetch / 外部调用可挂此信号，超时后自动 abort。 */
  signal?: AbortSignal;
};

export type ToolResult = {
  ok: boolean;
  data?: unknown;
  error?: string;
  summary: string;
  /**
   * 这一步做完之后，把整次运行**停下来等一件外部的事**，格式 `<类型>:<id>`
   *（目前只有 `browser:<BrowserTask.id>`，见 lib/agent/wake.ts）。
   *
   * 只有「结果要等别人给」的工具才该填它。填了就意味着：这一轮不再往下推理，
   * 那件事有结局（成功/失败/过期/取消）时才继续——所以**必须保证有人会来叫醒**，
   * 否则就是一次永远醒不来的运行。
   */
  waitFor?: string;
  /**
   * 这一步做出了什么东西（草稿、版本、图、发布计划…）。
   *
   * 【为什么要工具自己报，而不是执行器去猜】只有工具知道自己刚写了哪一行：
   * create_draft 知道新草稿的 id，run_skill 知道存成了第几版。
   * 执行器那边看到的只是一段 JSON summary，从里面反解 id 是猜——猜错了
   * 用户点过去会打开别人的东西。
   */
  artifacts?: { kind: ArtifactKind; refId: string; label: string }[];
};

/** 产物的种类。加新种类时记得让界面知道它该跳到哪一页（lib/agent/artifacts.ts）。 */
export type ArtifactKind =
  | 'draft'
  | 'draft_version'
  | 'topic'
  | 'image'
  | 'publish_plan'
  | 'schedule'
  | 'browser_task';

export type AgentTool = {
  name: string;
  /** 给人看的中文名（确认弹层与步骤列表用） */
  label: string;
  def: ToolDef;
  action: RbacAction;
  /** 会改变系统状态吗 */
  write: boolean;
  /** 会花钱吗（模型调用 / 生图 / 采集配额）。写操作与花钱操作都要确认。 */
  costly?: boolean;
  /**
   * 这一步是**替用户签一份以后会自己生效的东西**吗。
   *
   * 建发布计划、写进长期记忆、配一条定时、拼一个新智能体——它们的共同点是
   * **影响不止于这一次执行**：定时会在他睡着时按时花钱，记忆会改变以后每一次生成，
   * 发布计划摆在那儿等着被发出去。
   *
   * 【为什么用标记而不是写死一张工具名清单】清单会漏。新加一个「配点什么」的工具时，
   * 作者会记得填 write（不填连基本的确认都没有，测试会红），却很难想起去另一个文件里
   * 的排除表补一行——而漏掉的后果是无人值守时它被静默执行。
   * 标记跟着工具定义走，加工具时就在眼前。
   *
   * 效果：**无人值守下照样停下来问人**（机制级，不看提示词也不看授权档）；
   * 预授权的派发卡上**缺省不勾**（用户可以主动勾，那是他知情的选择）。
   */
  contract?: boolean;
  /**
   * 这一步最多等多久（毫秒）。不填走 DEFAULT_TOOL_TIMEOUT_MS。
   *
   * 【填的时候想什么】它不是「预期耗时」，是「超过这个数就该认为外面卡住了」。
   * 因为超时**掐不断**已经跑起来的活（JS 做不到），只是不再等——填小了的代价是
   * 模型收到一次假的失败，而那件事还在后台继续。宁可给足。
   */
  timeoutMs?: number;
  run: (ctx: ToolContext, args: Record<string, unknown>) => Promise<ToolResult>;
};

/** 没单独声明时的等待上限：查数据库、调一次模型都远在这个数以内。 */
export const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

export function toolTimeoutMs(tool: AgentTool): number {
  return tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
}

// ── 参数收紧小工具 ────────────────────────────────────────────────────────
// 模型传来的 args 是 `Record<string, unknown>`，**每一个字段都可能是任何东西**
//（少传、传成 null、把数字传成 "10 条"）。所以工具里读参数一律经过这三个函数，
// 而不是 `args.limit as number` —— 那种写法在模型少传一个字段时就变成 NaN，
// 一路带进 prisma 的 take 里。

export const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v.trim() : fallback);
export const num = (v: unknown, fallback: number): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};
export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

