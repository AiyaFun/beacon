import { parseJson, toJson } from '../json';
import { AGENT_TOOLS, type AgentTool } from './tools';
import { can } from '../rbac';

// ── 「插件」= AI 能调的系统能力，按工作区开关 ──────────────────────────────
//
// 【为什么要有开关】这 10 个工具此前对用户是**完全不可见**的：它们决定了 AI 能替你做什么
// （包括建草稿、加竞对、跑采集这些写操作），但界面上没有任何一处列出它们。
// 用户既不知道 AI 有这些能力，也没法说「这个不许它碰」。
//
// 【存在哪】Workspace.agentToolConfig（JSON），与 automationConfig 同款做法——
// 十来个布尔值不值得单开一张表，而且它天然跟着工作区删除走。
//
// 【关掉之后有两道拦截，缺一不可】
//   ① 不出现在给模型的工具清单里（模型压根不知道有这回事）；
//   ② **执行时再查一次**。模型可能凭上一轮上下文里的记忆去调一个已被关掉的工具，
//      只做①的话它会真的执行成功——这跟权限校验必须查两次是同一个理由。
//
// 【只读工具也允许关】看起来没必要，但 list_competitors / account_performance 这类
// 会把业务数据喂进模型上下文。有的团队就是不想让某些数据出工作区。

export type ToolConfig = Record<string, boolean>;

/**
 * 缺省全开：加了新工具不该要求每个工作区先去打开它一次。
 *
 * `?? {}` 不能省：parseJson 的兜底只在**解析失败**时生效，而 `"null"`、`"123"`、`"[]"`
 * 都是合法 JSON——解析成功、返回 null 或非对象，下一行 `parsed[name]` 直接抛
 * 「Cannot read properties of null」，把整个助手页打成 500。
 */
export function readToolConfig(raw: string | null | undefined): ToolConfig {
  const parsed = asRecord(parseJson<unknown>(raw, {}));
  const out: ToolConfig = {};
  for (const t of AGENT_TOOLS) out[t.name] = parsed[t.name] !== false;
  return out;
}

/** 解析结果必须是普通对象才算数：null / 数组 / 数字一律当空配置。 */
function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** 只写用户真正改过的那些键，避免把「当前的默认值」固化成显式配置。 */
export function writeToolConfig(current: string | null | undefined, name: string, enabled: boolean): string {
  const parsed = asRecord(parseJson<unknown>(current, {}));
  if (enabled) delete parsed[name];
  else parsed[name] = false;
  return toJson(parsed);
}

/** 这个工作区关掉了哪些工具。 */
export function disabledTools(raw: string | null | undefined): string[] {
  const cfg = readToolConfig(raw);
  return Object.entries(cfg).filter(([, on]) => !on).map(([name]) => name);
}

/**
 * 这次运行能用哪些工具 = 角色有权限 ∩ 工作区没关掉。
 *
 * 取代了原来的 toolsForRole：两个判据必须在**同一个函数**里收口，
 * 分成两处就迟早有一处调用只过了其中一道（列表过滤走了 A、执行校验走了 B）。
 */
export function toolsFor(role: string, disabled: readonly string[]): AgentTool[] {
  const off = new Set(disabled);
  return AGENT_TOOLS.filter((t) => can(role, t.action) && !off.has(t.name));
}

/** 给「插件」页用：每个工具的完整档案 + 当前开关。 */
export function toolCatalog(role: string, raw: string | null | undefined) {
  const cfg = readToolConfig(raw);
  return AGENT_TOOLS.map((t) => ({
    name: t.name,
    label: t.label,
    description: t.def.description,
    write: t.write,
    costly: t.costly === true,
    action: t.action,
    enabled: cfg[t.name] !== false,
    /** 角色没权限时开关也没意义：显示成「你的角色用不了」而不是一个点了没用的开关 */
    allowedByRole: can(role, t.action),
  }));
}
