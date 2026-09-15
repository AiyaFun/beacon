import { prisma } from '../db';
import { AUTO_PAUSE_FAILS } from '../workflow/schedule';
import { redactSecrets } from '../agent/redact';
import type { HealthItem, HealthLevel } from './types';

export * from './types';

// ── 员工健康与异常收件箱（2026-09-11 P1）：只覆盖会影响内容任务的六类依赖，首版只读 ──
//
//   model     模型渠道：有没有可用渠道；近 24h 落 Mock / 被降级的比例
//   channel   消息渠道：BotIntegration.lastError
//   executor  采集执行器：多久没领活；pending 里等太久的任务
//   knowledge 知识范围：绑定指向已删除的资讯条目
//   tool      自写工具：AgentToolDef.lastError
//   schedule  定时：连败 / 已自动停用
// 每条红黄都带证据时间、影响的员工、修复入口。**不做自动修复**：自动修复容易扩大故障。
// HealthCheckResult 不落库：每次读现算，任何一条都能回链到原系统。

const EXECUTOR_STALE_MS = 25 * 60_000;
const PENDING_TOO_LONG_MS = 2 * 60 * 60_000;

export async function agentHealth(tenantId: string, workspaceId: string, now = new Date()): Promise<HealthItem[]> {
  const day = new Date(now.getTime() - 86_400_000);
  const [providers, platformProviders, calls, channels, lastClaim, pendingOld, bindings, tools, schedules, templates, presets] = await Promise.all([
    prisma.modelProvider.findMany({ where: { tenantId }, select: { label: true, status: true } }),
    prisma.platformProvider.count({ where: { enabled: true } }).catch(() => 0),
    // 全量计数（groupBy），不取样：高量工作区取前 2000 条会让比例失真
    prisma.llmCallLog.groupBy({ by: ['mocked', 'degraded'], where: { tenantId, createdAt: { gte: day } }, _count: { _all: true } }),
    prisma.botIntegration.findMany({ where: { workspaceId }, select: { id: true, provider: true, label: true, enabled: true, lastError: true, updatedAt: true, agentTemplateId: true } }),
    prisma.browserTask.findFirst({ where: { workspaceId, claimedAt: { not: null } }, orderBy: { claimedAt: 'desc' }, select: { claimedAt: true } }),
    prisma.browserTask.findMany({ where: { workspaceId, status: 'pending', createdAt: { lt: new Date(now.getTime() - PENDING_TOO_LONG_MS) } }, select: { id: true, kind: true, createdAt: true }, take: 20 }),
    prisma.agentKnowledgeBinding.findMany({ where: { workspaceId, enabled: true, sourceType: 'library_item' }, select: { templateId: true, sourceId: true } }).catch(() => []),
    prisma.agentToolDef.findMany({ where: { workspaceId, lastError: { not: null } }, select: { name: true, label: true, lastError: true, updatedAt: true } }).catch(() => []),
    prisma.scheduledAgent.findMany({ where: { workspaceId }, select: { id: true, templateId: true, taskPresetId: true, enabled: true, failStreak: true, lastError: true, lastRunAt: true, lastStatus: true, providerId: true } }),
    prisma.workflowTemplate.findMany({ where: { OR: [{ isBuiltin: true }, { tenantId }] }, select: { id: true, name: true, emoji: true } }),
    prisma.taskPreset.findMany({ where: { workspaceId }, select: { id: true, agentTemplateId: true, title: true, providerId: true } }),
  ]);
  // 指定过模型渠道的卡/定时：渠道被删或失效后，网关会严格报错（不静默换），这里提前把它列进收件箱
  const chosen = [...new Set([...presets.map((p) => p.providerId), ...schedules.map((s) => s.providerId)].filter((v): v is string => !!v && v !== 'platform'))];
  const liveChosen = chosen.length ? new Set((await prisma.modelProvider.findMany({ where: { id: { in: chosen }, tenantId, status: { not: 'failed' } }, select: { id: true } })).map((p) => p.id)) : new Set<string>();
  const tplName = new Map(templates.map((t) => [t.id, `${t.emoji} ${t.name}`]));
  const presetOwner = new Map(presets.map((p) => [p.id, p.agentTemplateId]));
  const out: HealthItem[] = [];

  // ① 模型
  const live = providers.filter((p) => p.status !== 'failed').length;
  // 平台缺省渠道也可能只配在环境变量里（BEACON_DEFAULT_LLM_*，lib/llm/gateway.ts 的兜底）
  const envDefault = !!process.env.BEACON_DEFAULT_LLM_API_KEY;
  if (live === 0 && platformProviders === 0 && !envDefault) {
    out.push({ kind: 'model', level: 'bad', title: '没有任何可用模型渠道', evidence: '所有生成都会落到 Mock（产物是编的）', at: null, affects: [...tplName.values()], action: { label: '去配模型', href: '/settings/keys' } });
  } else {
    const failed = providers.filter((p) => p.status === 'failed');
    if (failed.length) out.push({ kind: 'model', level: 'warn', title: `${failed.length} 条自带模型渠道已失效`, evidence: failed.map((p) => p.label).join('、'), at: null, affects: [], action: { label: '去看密钥', href: '/settings/keys' } });
    const total = calls.reduce((n, g) => n + g._count._all, 0);
    const mocked = calls.filter((g) => g.mocked).reduce((n, g) => n + g._count._all, 0);
    const degraded = calls.filter((g) => g.degraded).reduce((n, g) => n + g._count._all, 0);
    if (total >= 5 && mocked / total > 0.2) {
      const last = await prisma.llmCallLog.findFirst({ where: { tenantId, mocked: true, createdAt: { gte: day } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
      out.push({ kind: 'model', level: degraded > 0 ? 'bad' : 'warn', title: `近 24 小时 ${Math.round((mocked / total) * 100)}% 的调用落到了 Mock（共 ${total} 次）`, evidence: degraded > 0 ? `其中 ${degraded} 次是接了真模型但失败被兜底（供应商或额度问题）` : '选路就落在 Mock：查渠道配置', at: last ? last.createdAt.toISOString() : null, affects: [], action: { label: '去看模型渠道', href: '/settings/keys' } });
    }
  }
  for (const pid of chosen) {
    if (liveChosen.has(pid)) continue;
    const who = [...presets.filter((p) => p.providerId === pid).map((p) => `一键任务「${p.title}」`), ...schedules.filter((s) => s.providerId === pid).map(() => '一条定时')];
    out.push({ kind: 'model', level: 'bad', title: '指定的模型渠道已删除或失效', evidence: `${who.join('、')} 指定了它；到点跑会直接失败，不会静默换成别的渠道`, at: null, affects: [], action: { label: '去改成别的渠道或自动', href: '/workflows' } });
  }
  // ② 渠道
  for (const c of channels) {
    if (c.enabled && c.lastError) out.push({ kind: 'channel', level: 'warn', title: `${c.provider}${c.label ? ` · ${c.label}` : ''} 上次推送失败`, evidence: c.lastError.slice(0, 160), at: c.updatedAt.toISOString(), affects: c.agentTemplateId ? [tplName.get(c.agentTemplateId) ?? ''].filter(Boolean) : [], action: { label: '去看渠道', href: '/notifications' } });
  }
  // ③ 执行器
  const needsExecutor = pendingOld.length > 0;
  const online = !!lastClaim?.claimedAt && now.getTime() - lastClaim.claimedAt.getTime() < EXECUTOR_STALE_MS;
  if (needsExecutor && !online) {
    out.push({ kind: 'executor', level: 'bad', title: `${pendingOld.length} 个采集任务等了超过 2 小时没人领`, evidence: lastClaim?.claimedAt ? `执行器上次领活 ${lastClaim.claimedAt.toISOString()}` : '从没有执行器领过活', at: pendingOld[0].createdAt.toISOString(), affects: [tplName.get(templates.find((t) => t.name === '情报员')?.id ?? '') ?? '情报员'], action: { label: '打开桌面客户端或插件', href: '/extension' } });
  } else if (lastClaim?.claimedAt && !online) {
    out.push({ kind: 'executor', level: 'warn', title: '采集执行器离线', evidence: `上次领活 ${lastClaim.claimedAt.toISOString()}`, at: lastClaim.claimedAt.toISOString(), affects: [], action: { label: '去看执行器', href: '/extension' } });
  }
  // ④ 知识
  if (bindings.length) {
    const ids = [...new Set(bindings.map((b) => b.sourceId))];
    const exist = new Set((await prisma.inspirationItem.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((i) => i.id));
    const dangling = bindings.filter((b) => !exist.has(b.sourceId));
    if (dangling.length) out.push({ kind: 'knowledge', level: 'warn', title: `${dangling.length} 条知识绑定指向已删除的资讯条目`, evidence: '这些员工读不到原来指定的资料，检索会静默少一块', at: null, affects: [...new Set(dangling.map((b) => tplName.get(b.templateId) ?? b.templateId))], action: { label: '去员工档案清理', href: `/workflows?agent=${dangling[0].templateId}` } });
  }
  // ⑤ 自写工具
  for (const t of tools) {
    out.push({ kind: 'tool', level: 'warn', title: `自写工具「${t.label}」上次报错`, evidence: (t.lastError ?? '').slice(0, 160), at: t.updatedAt.toISOString(), affects: [], action: { label: '去看工具', href: '/skills' } });
  }
  // ⑥ 定时
  for (const s of schedules) {
    const owner = s.templateId ?? (s.taskPresetId ? presetOwner.get(s.taskPresetId) : null);
    const who = owner ? [tplName.get(owner) ?? ''].filter(Boolean) : [];
    if (!s.enabled && s.failStreak >= AUTO_PAUSE_FAILS) out.push({ kind: 'schedule', level: 'bad', title: '一条定时连续失败已被自动停用', evidence: (s.lastError ?? '').slice(0, 160), at: s.lastRunAt?.toISOString() ?? null, affects: who, action: { label: '去定时里修', href: '/workflows#schedules' } });
    else if (s.enabled && s.failStreak > 0) out.push({ kind: 'schedule', level: 'warn', title: `一条定时已连续失败 ${s.failStreak} 次（${AUTO_PAUSE_FAILS} 次会自动停用）`, evidence: (s.lastError ?? '').slice(0, 160), at: s.lastRunAt?.toISOString() ?? null, affects: who, action: { label: '去看定时', href: '/workflows#schedules' } });
  }

  const rank: Record<HealthLevel, number> = { bad: 0, warn: 1, ok: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

/** 诊断包：给支持用的一份 JSON（脱敏：密钥/令牌一律打码）。不含正文内容。 */
export async function supportBundle(tenantId: string, workspaceId: string): Promise<string> {
  const [health, schedules, runs, calls] = await Promise.all([
    agentHealth(tenantId, workspaceId),
    prisma.scheduledAgent.findMany({ where: { workspaceId }, select: { id: true, targetKind: true, atHour: true, atMinute: true, weekdays: true, enabled: true, failStreak: true, lastStatus: true, lastError: true, lastRunAt: true } }),
    prisma.agentRun.findMany({ where: { workspaceId }, orderBy: { updatedAt: 'desc' }, take: 20, select: { id: true, status: true, origin: true, error: true, steps: true, rounds: true, callBudget: true, agentTemplateId: true, createdAt: true, updatedAt: true } }),
    prisma.llmCallLog.groupBy({ by: ['source', 'mocked', 'degraded'], where: { tenantId, createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) } }, _count: { _all: true } }),
  ]);
  const bundle = {
    generatedAt: new Date().toISOString(),
    version: process.env.npm_package_version ?? null,
    edition: process.env.BEACON_EDITION ?? null,
    queue: process.env.BEACON_QUEUE ?? null,
    health, schedules, recentRuns: runs, llm7d: calls,
  };
  return redactSecrets(JSON.stringify(bundle, null, 2)).text;
}
