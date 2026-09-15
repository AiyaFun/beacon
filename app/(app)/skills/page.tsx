import { getSession } from '@/lib/session';
import { can } from '@/lib/rbac';
import { listSkillsForTenant, ensureBuiltinSkills } from '@/lib/skills';
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
import { AiToolList, type AiToolView } from './AiToolList';
import { getServerLang } from '@/lib/i18n/server';
import { getDictionary } from '@/lib/i18n/dict';
import { capabilityRegistry, summarizeRegistry } from '@/lib/capabilities/registry';
import { CapabilityTable } from './CapabilityTable';

export const dynamic = 'force-dynamic';

export default async function SkillsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const s = await getSession();
  const sp = await searchParams;
  const lang = await getServerLang();
  const dict = getDictionary(lang);

  // 「能力」标签：同一页的第三个视角（技能 / 智能体 / 能力）。
  // 服务端 view 参数、只渲染当前 tab —— 与 /data、/topics 同一个模式。
  if (sp.view === 'abilities') return <AbilitiesView />;

  // ── 本页取数：一次并发 ──
  //
  // 【为什么合并】原来是七个连着写的 await：内置技能落库 → 技能清单 → 市场目录(HTTP) →
  // AI 自写工具 → 采集配方 → 采集记录 → 做法技能。逐条核过，只有「采集记录」真依赖
  // 「采集配方」的 id，其余六条互不相干。生产库跨区一跳 32ms，白等五跳 ≈ 160ms，
  // 而 fetchCatalog 还是一次公网 HTTP，串在中间尤其亏。
  // 落库(ensureBuiltinSkills)必须在读清单之前，所以那两条用 .then 串在**同一格**里。
  const [skills, catalog, aiToolRows, recipeRows, procedureRows] = await Promise.all([
    // 内置技能落库（幂等，只补缺）：新加的内置技能才能在存量部署出现（生产不跑 seed）
    ensureBuiltinSkills().catch(() => {}).then(() => listSkillsForTenant(s.tenantId)),
    // 【为什么服务端先探一次】市场目录现在是空的（生产 /market/index.json 的 entries: []），
    // 而那张卡照样渲染出「技能市场 · 装上就能用」+「看看市场里有什么」按钮——
    // 点下去转一圈告诉你一条都没有。用户 2026-08-26 原话：「没有技能市场，就去掉」。
    // 有内容时它会自己回来，不是把功能删了。探测失败（网络不通）也当作没有：
    // 一个点了必然报错的入口，不如不出现。
    fetchCatalog().catch(() => null),
    // AI 自写的工具：审核台数据（代码一起带到页面上——看过才能启用）
    prisma.agentToolDef.findMany({ where: { workspaceId: s.workspaceId }, orderBy: { createdAt: 'desc' } }),
    // 采集配方。与做法技能放同一页：两者都是「AI 学会的东西」，分两处用户要找两遍
    prisma.scrapeRecipe.findMany({
      where: { workspaceId: s.workspaceId },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      select: { id: true, name: true, origin: true, status: true, version: true, failCount: true, fields: true },
    }),
    // 做法技能（流程技能）。与 ContentSkill 分表，见 lib/skill/distill.ts 的说明
    prisma.procedureSkill.findMany({
      where: { workspaceId: s.workspaceId },
      orderBy: [{ usedCount: 'desc' }, { createdAt: 'desc' }],
      take: 50,
      select: { id: true, name: true, description: true, steps: true, usedCount: true },
    }),
  ]);
  const marketHasEntries = !!catalog?.ok && catalog.entries.length > 0;
  const readOnly = !can(s.role, 'content.create');
  const aiTools: AiToolView[] = aiToolRows.map((t) => ({
    id: t.id, name: t.name, label: t.label, description: t.description,
    uses: (() => { try { return JSON.parse(t.uses) as string[]; } catch { return []; } })(),
    code: t.code, status: t.status, write: t.write, costly: t.costly, contract: t.contract,
    usedCount: t.usedCount, lastError: t.lastError, createdAt: t.createdAt.toISOString(),
  }));

  const installed = skills.filter((k) => k.installed).length;
  const custom = skills.filter((k) => !k.isBuiltin).length;

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

  // 做法技能（流程技能）。与 ContentSkill 分表，见 lib/skill/distill.ts 的说明（取数已并进上面那一波）
  const procedures: ProcView[] = procedureRows.map((p) => ({
    id: p.id, name: p.name, description: p.description, usedCount: p.usedCount,
    steps: (() => { try { return JSON.parse(p.steps) as { tool: string; why: string }[]; } catch { return []; } })(),
  }));

  return (
    <>
      <HubHeader
        title={lang === 'en' ? 'Skills & Connectors' : '技能 · 连接器'}
        hint={lang === 'en' ? 'Equip capabilities for Studio and AI Assistant' : `${AGENT_ROLES.skill.oneLine} · 装上后创作工坊一键用，AI 助手也会自己挑着用`}
        tabs={<RoleTabs active="skill" inline />}
        action={
          <a href="/skills?view=abilities" className="btn">
            {lang === 'en' ? 'Manage Connectors' : '管理连接器'}
          </a>
        }
      />

      {readOnly && (
        <div className="small muted" style={{ marginBottom: 12 }}>
          {lang === 'en'
            ? 'You have read-only access: you can browse skills, but installing/editing requires editor permissions.'
            : '你是只读成员：可以浏览技能，但安装/卸载/创建需要编辑及以上权限。'}
        </div>
      )}

      {/* 现代两列工作台：适合当前账号的技能 + 最近任务 */}
      <SkillCenter skills={skills} readOnly={readOnly} />

      {/* 市场排在技能后：有内容时显示 */}
      {marketHasEntries && (
        <Card
          id="market"
          title={lang === 'en' ? 'Skill Market' : '技能市场'}
          sub={lang === 'en' ? 'Off-the-shelf skills and agents, ready to install. Prompt templates and step configurations only, no executable code.' : '现成的技能与智能体，装上就能用。都是提示词模板与步骤配置，不含可执行代码'}
          style={{ marginTop: 16 }}
        >
          <Market readOnly={readOnly} />
        </Card>
      )}

      {/* 高级扩展能力收纳区（做法技能、采集配方与AI自写工具） */}
      <details className="surface" style={{ marginTop: 16, borderRadius: 12, border: '1px solid var(--border)', padding: '12px 16px' }}>
        <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 13, color: 'var(--text-2)', userSelect: 'none' }}>
          {lang === 'en' ? '🧩 Advanced Capabilities (Procedures, Recipes & Custom Tools)' : '🧩 进阶能力扩展（做法技能、采集配方与自写工具）'}
        </summary>
        <div style={{ marginTop: 16 }}>
          <div className="grid-stats">
            <Stat label={lang === 'en' ? 'Available Skills' : '可用技能'} value={skills.length} foot={lang === 'en' ? 'Built-in + Custom' : '内置 + 本团队自定义'} />
            <Stat label={lang === 'en' ? 'Installed' : '已安装'} value={installed} foot={lang === 'en' ? 'Usable in Studio' : '创作工坊里可直接用'} />
            <Stat label={lang === 'en' ? 'Custom Skills' : '自定义技能'} value={custom} foot={lang === 'en' ? 'Created by your team' : '你自己教 AI 的活'} />
            <Stat label={lang === 'en' ? 'Built-in Skills' : '内置技能'} value={skills.length - custom} foot={lang === 'en' ? 'Maintained by platform' : '平台维护，持续更新'} />
          </div>

          <ProcedureList items={procedures} readOnly={readOnly} />

          <div style={{ marginTop: 16 }}>
            <RecipeList items={recipes} readOnly={readOnly} canRun={canEdition('localBrowser')} />
          </div>

          <div style={{ marginTop: 16 }}>
            <AiToolList items={aiTools} readOnly={readOnly} supported={canEdition('aiAuthoredTools')} />
          </div>
        </div>
      </details>
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
  const lang = await getServerLang();
  const [ws, workspace] = await Promise.all([
    prisma.workspace.findUnique({ where: { id: s.workspaceId }, select: { agentToolConfig: true } }),
    prisma.workspace.findUnique({ where: { id: s.workspaceId }, select: { browserReadEnabled: true } }),
  ]);
  const rows = toolCatalog(s.role, ws?.agentToolConfig);
  // 开关要 byok.manage 权限：能力关掉会影响整个工作区，不是个人偏好
  const canManageTools = can(s.role, 'byok.manage');
  // 能力注册表（2026-09-11 P1）：七类能力同一个形状，标出「装了但不可用」
  const registry = await capabilityRegistry(s.tenantId, s.workspaceId, s.role).catch(() => []);

  return (
    <>
      <HubHeader
        title={lang === 'en' ? 'Skills & Connectors' : '技能 · 连接器'}
        hint={lang === 'en' ? 'AI action tools · Can be toggled on/off here' : `${AGENT_ROLES.ability.oneLine} · ${AGENT_ROLES.ability.decidedBy} · 这里可以整个关掉`}
        tabs={<RoleTabs active="ability" inline />}
      />
      <Card
        id="abilities"
        title={lang === 'en' ? 'AI Tool Abilities' : `AI ${AGENT_ROLES.ability.name}`}
        sub={lang === 'en' ? 'When disabled, AI cannot see or invoke it' : '关掉之后 AI 既看不到它，也调不动它'}
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
      <Card
        title={lang === 'en' ? 'Capability registry' : '能力注册表'}
        sub={lang === 'en' ? 'Tools, custom tools, skills, procedures, executor, channels and model route in one shape — installed vs. usable, risk, usage, assignable agents' : '动作工具 / 自写工具 / 生成技能 / 做法技能 / 执行器 / 消息渠道 / 模型渠道同一张表：装没装、能不能用、风险、用量、能派给谁'}
      >
        <CapabilityTable rows={registry} summary={summarizeRegistry(registry)} />
      </Card>
    </>
  );
}
