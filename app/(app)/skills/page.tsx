import { getSession } from '@/lib/session';
import { can } from '@/lib/rbac';
import { listSkillsForTenant } from '@/lib/skills';
import { Stat, Card } from '@/components/ui';
import { SkillCenter } from './SkillCenter';
import { Market } from './Market';
import { RoleTabs } from '@/components/RoleTabs';
import { AGENT_ROLES } from '@/lib/agent/roles';
import { prisma } from '@/lib/db';
import { toolCatalog } from '@/lib/agent/tool-config';
// 能力清单的渲染与开关仍住在 extension 目录（它与那边的 server action 同居，
// 搬目录要一起搬 action，风险大于收益）。这里只是**换个地方渲染它**：
// 2026-08-26 用户指出「能力」点进去跳到「下载采集助手」页，语义不对——
// 能力是 AI 的工具集，跟装浏览器插件是两件事。
import { AgentTools } from '../extension/AgentTools';
import { BrowserReadSwitch } from '../extension/BrowserReadSwitch';
import { readAllowlistLabels } from '@/lib/browser-task/read-allowlist';
import { fetchCatalog } from '@/lib/market/catalog';
import { HubHeader } from '@/components/HubHeader';
import { ProcedureList, type ProcView } from './ProcedureList';
import { can as canEdition } from '@/lib/edition';
import { RecipeList } from './RecipeList';

export const dynamic = 'force-dynamic';

// 技能中心：内置技能全租户可见、按租户安装；自定义技能（提示词模板）归属本租户。
// 装好的技能在创作工坊对草稿/终稿一键生成平台成品。

export default async function SkillsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const s = await getSession();
  const sp = await searchParams;

  // 「能力」标签：同一页的第三个视角（技能 / 智能体 / 能力）。
  // 服务端 view 参数、只渲染当前 tab —— 与 /data、/topics 同一个模式。
  if (sp.view === 'abilities') return <AbilitiesView />;

  const skills = await listSkillsForTenant(s.tenantId);
  // 【为什么服务端先探一次】市场目录现在是空的（生产 /market/index.json 的 entries: []），
  // 而那张卡照样渲染出「技能市场 · 装上就能用」+「看看市场里有什么」按钮——
  // 点下去转一圈告诉你一条都没有。用户 2026-08-26 原话：「没有技能市场，就去掉」。
  // 有内容时它会自己回来，不是把功能删了。探测失败（网络不通）也当作没有：
  // 一个点了必然报错的入口，不如不出现。
  const catalog = await fetchCatalog().catch(() => null);
  const marketHasEntries = !!catalog?.ok && catalog.entries.length > 0;
  const readOnly = !can(s.role, 'content.create');

  const installed = skills.filter((k) => k.installed).length;
  const custom = skills.filter((k) => !k.isBuiltin).length;

  // 采集配方。与做法技能放同一页：两者都是「AI 学会的东西」，分两处用户要找两遍
  const recipeRows = await prisma.scrapeRecipe.findMany({
    where: { workspaceId: s.workspaceId },
    orderBy: { updatedAt: 'desc' },
    take: 50,
    select: { id: true, name: true, origin: true, status: true, version: true, failCount: true, fields: true },
  });

  // 每个配方**最近抓到的那一条** + 总条数。
  //
  // 【为什么值得多查这两下】配方卡上原来只有状态和「跑一次」，看不到抓到了什么。
  // 而这条路上最贵的误解正是「以为数据在积累」——在落库补上之前，
  // 库里其实一个字都没有，而卡片照样显示「能用」。有数据就印数据、
  // 没数据就明说没有，这个误解才不会再发生。
  const recipeIds = recipeRows.map((r) => r.id);
  const [lastRecords, counts] = recipeIds.length === 0 ? [[], []] : await Promise.all([
    // 每个配方取最近一条：条数最多 50，直接按 recipeId 分组取首条比 N 次查询省
    prisma.scrapeRecord.findMany({
      where: { workspaceId: s.workspaceId, recipeId: { in: recipeIds } },
      orderBy: { capturedAt: 'desc' },
      take: 200,
      select: { recipeId: true, capturedAt: true, values: true, got: true, want: true, rowCount: true },
    }),
    prisma.scrapeRecord.groupBy({
      by: ['recipeId'],
      where: { workspaceId: s.workspaceId, recipeId: { in: recipeIds } },
      _count: { _all: true },
    }),
  ]);
  const latest = new Map<string, (typeof lastRecords)[number]>();
  for (const rec of lastRecords) if (!latest.has(rec.recipeId)) latest.set(rec.recipeId, rec);
  const totalBy = new Map(counts.map((c) => [c.recipeId, c._count._all]));

  const recipes = recipeRows.map((r) => {
    const labels = (() => {
      try { return (JSON.parse(r.fields) as { key: string; label: string }[]); } catch { return []; }
    })();
    const rec = latest.get(r.id);
    const pairs: [string, string][] = rec
      ? Object.entries((() => { try { return JSON.parse(rec.values) as Record<string, string>; } catch { return {}; } })())
        // key 是 f1/f2，用户看不懂——换回他自己写的那个人话标签
        .map(([k, v]) => [labels.find((f) => f.key === k)?.label ?? k, v] as [string, string])
        .slice(0, 4)
      : [];
    return {
      id: r.id, name: r.name, origin: r.origin, status: r.status, version: r.version, failCount: r.failCount,
      fields: labels.map((f) => f.label),
      last: rec
        ? { at: rec.capturedAt, got: rec.got, want: rec.want, rowCount: rec.rowCount, pairs }
        : null,
      total: totalBy.get(r.id) ?? 0,
    };
  });

  // 做法技能（流程技能）。与 ContentSkill 分表，见 lib/skill/distill.ts 的说明
  const procedures: ProcView[] = (await prisma.procedureSkill.findMany({
    where: { workspaceId: s.workspaceId },
    orderBy: [{ usedCount: 'desc' }, { createdAt: 'desc' }],
    take: 50,
    select: { id: true, name: true, description: true, steps: true, usedCount: true },
  })).map((p) => ({
    id: p.id, name: p.name, description: p.description, usedCount: p.usedCount,
    steps: (() => { try { return JSON.parse(p.steps) as { tool: string; why: string }[]; } catch { return []; } })(),
  }));

  return (
    <>
      <HubHeader
        title="技能 · 连接器"
        hint={`${AGENT_ROLES.skill.oneLine} · 装上后创作工坊一键用，AI 助手也会自己挑着用`}
        tabs={<RoleTabs active="skill" inline />}
      />

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="可用技能" value={skills.length} foot="内置 + 本团队自定义" />
        <Stat label="已安装" value={installed} foot="创作工坊里可直接用" />
        <Stat label="自定义技能" value={custom} foot="你自己教 AI 的活" />
        <Stat label="内置技能" value={skills.length - custom} foot="平台维护，持续更新" />
      </div>

      {readOnly && (
        <div className="small muted" style={{ marginBottom: 12 }}>
          你是只读成员：可以浏览技能，但安装/卸载/创建需要编辑及以上权限。
        </div>
      )}

      {/* 市场排在最前：新用户唯一问得出口的问题是「有哪些现成的可以装」，
          而不是「怎么自己写一个」。下面那些是已经装好的与自建入口。
          ⚠️ 目录为空时整张卡不渲染（见上面 marketHasEntries）——空市场是个死入口 */}
      {marketHasEntries && (
        <Card
          id="market"
          title="技能市场"
          sub="现成的技能与智能体，装上就能用。都是提示词模板与步骤配置，不含可执行代码"
          style={{ marginBottom: 16 }}
        >
          <Market readOnly={readOnly} />
        </Card>
      )}

      <SkillCenter skills={skills} readOnly={readOnly} />

      <div style={{ marginTop: 16 }}>
        <ProcedureList items={procedures} readOnly={readOnly} />
      </div>

      <div style={{ marginTop: 16 }}>
        <RecipeList items={recipes} readOnly={readOnly} canRun={canEdition('localBrowser')} />
      </div>
    </>
  );
}

/**
 * 「能力」视角：AI 一次只做一个动作的那批工具（33 项左右），逐项可关。
 *
 * 2026-08-26 从 /extension#abilities 搬到这里。原来它住在「下载采集助手」页，
 * 于是侧栏点「能力」会跳到一个讲怎么装浏览器扩展的页面——**用户当场问「为什么
 * 能力是跳转到插件去了」**。能力是 AI 的工具集，跟装扩展是两件事；
 * 它和技能、智能体本来就是同一个问题的三个答案，理应在同一页的三个标签里。
 */
async function AbilitiesView() {
  const s = await getSession();
  const [ws, workspace] = await Promise.all([
    prisma.workspace.findUnique({ where: { id: s.workspaceId }, select: { agentToolConfig: true } }),
    prisma.workspace.findUnique({ where: { id: s.workspaceId }, select: { browserReadEnabled: true } }),
  ]);
  const rows = toolCatalog(s.role, ws?.agentToolConfig);
  // 开关要 byok.manage 权限：能力关掉会影响整个工作区，不是个人偏好
  const canManageTools = can(s.role, 'byok.manage');

  return (
    <>
      <HubHeader
        title="技能 · 连接器"
        hint={`${AGENT_ROLES.ability.oneLine} · ${AGENT_ROLES.ability.decidedBy} · 这里可以整个关掉`}
        tabs={<RoleTabs active="ability" inline />}
      />
      <Card
        id="abilities"
        title={`AI ${AGENT_ROLES.ability.name}`}
        sub="关掉之后 AI 既看不到它，也调不动它"
      >
        <AgentTools tools={rows} readOnly={!canManageTools} />
        {/* 这一个开关刻意不混进上面那张表：那些缺省全开（「默认能用，你可以关」），
            这一个缺省是关的（「默认不能用，你得知道自己在开什么」）。 */}
        <BrowserReadSwitch
          enabled={workspace?.browserReadEnabled ?? false}
          allowlist={readAllowlistLabels()}
          readOnly={!canManageTools}
        />
      </Card>
    </>
  );
}
