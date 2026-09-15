import { prisma } from '../db';
import { AGENT_TOOLS } from '../agent/tools';
import { readToolConfig } from '../agent/tool-config';
import { can as rbacCan } from '../rbac';
import { can as editionCan, type Capability as EditionCap } from '../edition';
import { listAiTools } from '../agent/ai-tools/store';
import { listSkillsForTenant } from '../skills';
import { parseAgentConfig } from '../agent/autonomous';
import { parseJson } from '../json';
import { type CapabilityRow } from './types';

export * from './types';

// ── 能力注册表（2026-09-11 P1）：一处回答「这个员工现在能不能调这项能力」 ──────────
//
// 【为什么是 read model 不是新表】技能（ContentSkill+SkillInstall）、做法技能（ProcedureSkill）、
// 自写工具（AgentToolDef）、静态工具（AGENT_TOOLS）、执行器（BrowserTask）、渠道（BotIntegration）
// 各有各的表和真相，再建一张「能力表」就是第二份真相。这里只把它们按同一个形状读出来：
//   已安装 / 已授权（角色 + 工作区开关 + 形态）/ 依赖满足 / 最近调用 / 成功率 / 风险 / 可分配给谁。
// 「装成功但不可用」= installed && !usable，并且 depsMissing 说清缺什么、fixHref 指到哪修。
//
// 风险等级来自服务端工具定义（write/costly/contract），不由模型自报，也不由页面猜。

/** 静态工具依赖哪些东西：不列在这里的工具视为只依赖模型渠道。 */
const TOOL_DEPS: Record<string, { edition?: EditionCap; needsExecutor?: boolean; needsKey?: 'image' }> = {
  run_shell: { edition: 'localShell' },
  read_file: { edition: 'localShell' },
  write_file: { edition: 'localShell' },
  list_dir: { edition: 'localShell' },
  browse_local: { edition: 'localBrowser' },
  collect_competitor: { needsExecutor: true },
  collect_self_profile: { needsExecutor: true },
  make_cover: { needsKey: 'image' },
  make_illustrations: { needsKey: 'image' },
};

/** 执行器算在线的窗口：25 分钟内领过活（与 executor_kick 那边同口径） */
const EXECUTOR_ONLINE_MS = 25 * 60_000;

export async function capabilityRegistry(tenantId: string, workspaceId: string, role: string, now = new Date()): Promise<CapabilityRow[]> {
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const [ws, templates, aiTools, skills, procedures, channels, providers, platformProviders, lastClaim, steps] = await Promise.all([
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { agentToolConfig: true, browserReadEnabled: true } }),
    prisma.workflowTemplate.findMany({ where: { enabled: true, mode: 'autonomous', OR: [{ isBuiltin: true }, { tenantId }] }, select: { id: true, name: true, emoji: true, agentConfig: true } }),
    listAiTools(workspaceId).catch(() => []),
    listSkillsForTenant(tenantId).catch(() => []),
    prisma.procedureSkill.findMany({ where: { workspaceId }, select: { id: true, name: true, description: true, usedCount: true, updatedAt: true, toolAllowlist: true } }),
    prisma.botIntegration.findMany({ where: { workspaceId }, select: { id: true, provider: true, label: true, enabled: true, lastError: true, lastOutboundAt: true, agentTemplateId: true } }),
    prisma.modelProvider.findMany({ where: { tenantId }, select: { id: true, label: true, status: true, model: true } }),
    prisma.platformProvider.count({ where: { enabled: true } }).catch(() => 0),
    prisma.browserTask.findFirst({ where: { workspaceId, claimedAt: { not: null } }, orderBy: { claimedAt: 'desc' }, select: { claimedAt: true, claimedBy: true } }),
    // 近 30 天工具调用：按工具聚合次数与成功率（tool_result 的 ok）
    prisma.agentStep.findMany({
      where: { kind: 'tool_result', createdAt: { gte: since }, run: { workspaceId } },
      select: { tool: true, ok: true, createdAt: true, args: true },
      take: 5000,
    }),
  ]);
  const cfg = readToolConfig(ws?.agentToolConfig);
  const executorOnline = !!lastClaim?.claimedAt && now.getTime() - lastClaim.claimedAt.getTime() < EXECUTOR_ONLINE_MS;
  // 平台缺省渠道也可能只配在环境变量里（BEACON_DEFAULT_LLM_*，gateway 的兜底）
  const modelOk = providers.some((p) => p.status !== 'failed') || platformProviders > 0 || !!process.env.BEACON_DEFAULT_LLM_API_KEY;

  const stat = new Map<string, { calls: number; ok: number; last: Date | null }>();
  const bump = (key: string, s: { ok: boolean; createdAt: Date }) => {
    const cur = stat.get(key) ?? { calls: 0, ok: 0, last: null };
    cur.calls += 1; if (s.ok) cur.ok += 1;
    if (!cur.last || s.createdAt > cur.last) cur.last = s.createdAt;
    stat.set(key, cur);
  };
  for (const s of steps) {
    if (!s.tool) continue;
    bump(s.tool, s);
    // 生成技能各自的用量：run_skill 的参数里带 skill_id（第一版把 run_skill 总量套给每个技能，是错的）
    if (s.tool === 'run_skill') {
      const sid = (parseJson<{ skill_id?: string }>(s.args, {}).skill_id ?? '').toString();
      if (sid) bump(`skill:${sid}`, s);
    }
  }
  const statOf = (name: string) => {
    const s = stat.get(name);
    return { calls30d: s?.calls ?? 0, successRate30d: s && s.calls > 0 ? Math.round((s.ok / s.calls) * 100) : null, lastCalledAt: s?.last ? s.last.toISOString() : null };
  };
  const agentsWith = (toolName: string) => templates
    .filter((t) => { const c = parseAgentConfig(t.agentConfig); return c.tools.length === 0 || c.tools.includes(toolName); })
    .map((t) => `${t.emoji} ${t.name}`);

  const rows: CapabilityRow[] = [];

  // ① 静态动作工具
  for (const t of AGENT_TOOLS) {
    const deps = TOOL_DEPS[t.name] ?? {};
    const missing: string[] = [];
    let fixHref = '/skills?view=abilities';
    if (deps.edition && !editionCan(deps.edition)) missing.push('这个部署形态不提供（整机版/桌面版专属）');
    if (deps.needsExecutor && !executorOnline) { missing.push('没有在线的采集执行器（桌面客户端或浏览器插件 25 分钟内没领过活）'); fixHref = '/extension'; }
    if (deps.needsKey === 'image' && !modelOk) { missing.push('没有可用的生图/模型渠道'); fixHref = '/settings/keys'; }
    if (!deps.edition && !deps.needsExecutor && !modelOk && (t.costly === true)) { missing.push('没有配置模型渠道，会落到 Mock'); fixHref = '/settings/keys'; }
    const authorized = rbacCan(role, t.action) && cfg[t.name] !== false;
    rows.push({
      id: `tool:${t.name}`, type: 'tool', name: t.name, label: t.label, description: t.def.description.slice(0, 160),
      installed: true, authorized, usable: authorized && missing.length === 0, depsMissing: missing, fixHref,
      risk: { write: t.write, costly: t.costly === true, contract: t.contract === true },
      ...statOf(t.name), assignableAgents: agentsWith(t.name),
    });
  }
  // ② AI 自写工具
  for (const a of aiTools as { id: string; name: string; label: string; description: string; status: string; write: boolean; costly: boolean; contract: boolean; lastError: string | null; usedCount: number }[]) {
    const missing = a.lastError ? [`上次报错：${a.lastError.slice(0, 80)}`] : [];
    rows.push({
      id: `ai_tool:${a.id}`, type: 'ai_tool', name: a.name, label: a.label, description: a.description.slice(0, 160),
      installed: a.status === 'enabled', authorized: editionCan('aiAuthoredTools'), usable: a.status === 'enabled' && editionCan('aiAuthoredTools') && missing.length === 0,
      depsMissing: a.status === 'draft' ? ['还是草稿：要人看过代码点「启用」', ...missing] : missing, fixHref: '/skills',
      risk: { write: a.write, costly: a.costly, contract: a.contract }, ...statOf(a.name), assignableAgents: agentsWith(a.name),
    });
  }
  // ③ 生成技能
  for (const s of skills) {
    const missing = modelOk ? [] : ['没有配置模型渠道，会落到 Mock'];
    rows.push({
      id: `skill:${s.id}`, type: 'skill', name: s.slug, label: `${s.emoji} ${s.name}`, description: s.description.slice(0, 160),
      installed: s.installed, authorized: s.enabled, usable: s.installed && s.enabled && missing.length === 0,
      depsMissing: s.installed ? missing : ['没装：到技能中心装上'], fixHref: s.installed ? '/settings/keys' : '/skills',
      risk: { write: true, costly: true, contract: false }, ...statOf(`skill:${s.id}`), assignableAgents: agentsWith('run_skill'),
    });
  }
  // ④ 做法技能
  for (const p of procedures) {
    const allow = parseJson<string[]>(p.toolAllowlist, []);
    const missing = allow.filter((n) => cfg[n] === false).map((n) => `依赖的工具「${n}」已被工作区关闭`);
    rows.push({
      id: `procedure:${p.id}`, type: 'procedure', name: p.name, label: `📋 ${p.name}`, description: p.description.slice(0, 160),
      installed: true, authorized: true, usable: missing.length === 0, depsMissing: missing, fixHref: '/skills?view=abilities',
      risk: { write: allow.some((n) => AGENT_TOOLS.find((t) => t.name === n)?.write), costly: allow.some((n) => AGENT_TOOLS.find((t) => t.name === n)?.costly), contract: allow.some((n) => AGENT_TOOLS.find((t) => t.name === n)?.contract) },
      calls30d: p.usedCount, successRate30d: null, lastCalledAt: p.updatedAt.toISOString(), assignableAgents: [],
    });
  }
  // ⑤ 执行器（一条）
  rows.push({
    id: 'executor:browser', type: 'executor', name: 'executor', label: '🖥️ 采集执行器', description: '桌面客户端或浏览器插件替 AI 去平台页面采集。判在线 = 25 分钟内领过活。',
    installed: !!lastClaim, authorized: true, usable: executorOnline,
    depsMissing: executorOnline ? [] : [lastClaim?.claimedAt ? `上次领活 ${lastClaim.claimedAt.toISOString()}，已离线` : '从没有执行器领过活'], fixHref: '/extension',
    risk: { write: false, costly: false, contract: false }, calls30d: 0, successRate30d: null, lastCalledAt: lastClaim?.claimedAt?.toISOString() ?? null, assignableAgents: [],
  });
  // ⑥ 消息渠道
  for (const c of channels) {
    const tpl = c.agentTemplateId ? templates.find((t) => t.id === c.agentTemplateId) : null;
    rows.push({
      id: `channel:${c.id}`, type: 'channel', name: c.provider, label: `${c.provider}${c.label ? ` · ${c.label}` : ''}`, description: '群机器人：推送与派活',
      installed: true, authorized: c.enabled, usable: c.enabled && !c.lastError,
      depsMissing: c.lastError ? [`上次报错：${c.lastError.slice(0, 80)}`] : [], fixHref: '/notifications',
      risk: { write: true, costly: false, contract: false }, calls30d: 0, successRate30d: null, lastCalledAt: c.lastOutboundAt?.toISOString() ?? null,
      assignableAgents: tpl ? [`${tpl.emoji} ${tpl.name}`] : [],
    });
  }
  // ⑦ 模型渠道
  rows.push({
    id: 'model:route', type: 'model', name: 'model', label: '🧠 模型渠道', description: providers.length ? `自带 ${providers.length} 条（${providers.filter((p) => p.status === 'failed').length} 条失效）` : (platformProviders > 0 ? '走平台渠道' : '没有任何渠道'),
    installed: providers.length > 0 || platformProviders > 0, authorized: true, usable: modelOk,
    depsMissing: modelOk ? [] : ['没有可用模型渠道：所有生成都会落到 Mock（产物是编的）'], fixHref: '/settings/keys',
    risk: { write: false, costly: true, contract: false }, calls30d: 0, successRate30d: null, lastCalledAt: null, assignableAgents: [],
  });

  return rows;
}

/** 摘要：给页头三格 */
export function summarizeRegistry(rows: readonly CapabilityRow[]): { total: number; usable: number; installedButUnusable: number } {
  return {
    total: rows.length,
    usable: rows.filter((r) => r.usable).length,
    installedButUnusable: rows.filter((r) => r.installed && !r.usable).length,
  };
}
