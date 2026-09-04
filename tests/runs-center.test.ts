import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  agentStatus, agentDetail, activeBadge, workflowStatus, publishStatus, collectStatus, collectDetail,
  sortRuns, countByStatus, TRIGGER_LABEL, type RunEntry,
} from '@/lib/runs';
import { codeOfDir } from './helpers/anchor';

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'lib/runs/index.ts'), 'utf8');
const code = (p: string) =>
  fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const at = (iso: string) => new Date(iso);
const row = (p: Partial<RunEntry>): RunEntry => ({
  id: 'x', kind: 'agent', title: 't', status: 'done', at: at('2026-08-19T10:00:00Z'), href: '/', ...p,
});

describe('状态归一：四张表各说各话，收敛成同一套', () => {
  it('AI 执行器停下来等确认 = 等你处理，不是进行中', () => {
    // awaiting_confirm 是模型要做写操作时停下来等人点——归成 running
    // 会让用户以为「等着就行」，而它其实永远不会自己动
    expect(agentStatus('awaiting_confirm')).toBe('waiting');
    expect(agentStatus('running')).toBe('running');
    expect(agentStatus('done')).toBe('done');
    expect(agentStatus('failed')).toBe('failed');
    expect(agentStatus('cancelled')).toBe('cancelled');
  });

  it('等浏览器插件 = 等你处理（要你去开浏览器），等额度 = 进行中（你什么都不用做）', () => {
    // 两种挂起，用户该做的事完全相反，所以**不能归进同一桶**：
    //   waiting_browser —— 不打开那台浏览器它永远不动，必须摆进「等你处理」催人；
    //   waiting_quota   —— 北京时间 0 点重置后定时会自己把它接着跑，摆进「等你处理」
    //                      是叫人去做一件根本不存在的事（这一桶的标签就写着「等你处理」）。
    expect(agentStatus('waiting_browser')).toBe('waiting');
    expect(agentStatus('waiting_quota')).toBe('running');
  });

  it('等额度的那一行必须说清在等什么、什么时候好，且不摆成报错', () => {
    const d = agentDetail({ status: 'waiting_quota', steps: 3, error: '今日 AI 调用额度已用尽（30 次/天），明日 0 点重置。可升级套餐…' });
    expect(d).toContain('额度');
    expect(d).toContain('自动接着跑'); // 它不用管 —— 这句话是这一行存在的意义
    expect(d).not.toContain('可升级套餐'); // 配额那句长文案挤在列表行里像报错，而这次运行并没有失败
    // 其余状态照旧：有错就显示错，等插件要点名在等谁
    expect(agentDetail({ status: 'failed', steps: 1, error: '模型连不上' })).toBe('模型连不上');
    expect(agentDetail({ status: 'waiting_browser', steps: 2, error: null })).toContain('浏览器插件');
    expect(agentDetail({ status: 'running', steps: 5, error: null })).toBe('已执行 5 步');
  });

  it('排队中也是机器在等：归进行中，且要说清它一步都还没跑', () => {
    expect(agentStatus('queued')).toBe('running');
    const d = agentDetail({ status: 'queued', steps: 0, error: null });
    expect(d).toContain('排队');
    expect(d, '说「已执行 0 步」等于什么都没说').not.toContain('0 步');
  });

  it('活动条徽章：「等你处理」只给自己发起的，同事那条要点名是在等谁', () => {
    // 这一页是工作区级的，同事的运行也在列（刻意的）。而 AI 执行的「等你确认」
    // 只有发起人点得动——印成第二人称等于叫人去点一个必定报错的按钮。
    expect(activeBadge({ status: 'waiting', mine: true })).toEqual({ cls: 'badge-accent', text: '等你处理' });
    expect(activeBadge({ status: 'waiting', mine: false, waitingOn: '张三' }).text).toBe('等 张三');
    expect(activeBadge({ status: 'waiting', mine: false }).text, '名字查不到也不能说成「等你」').toBe('等 同事');
    // 没有发起人概念的那几类（采集、发布、插件任务）本来就是谁都能推的
    expect(activeBadge({ status: 'waiting' }).text).toBe('等你处理');
    expect(activeBadge({ status: 'running', mine: false }).text).toBe('进行中');
  });

  it('没见过的状态值按进行中兜底，不许崩也不许静默丢掉', () => {
    expect(agentStatus('brand_new_state')).toBe('running');
    expect(workflowStatus('brand_new_state')).toBe('running');
  });

  it('发布任务的四个中间态全是「等你处理」——没有任何机器在推进它们', () => {
    // 这四个都在等人：等插件接手、等你去平台点发布、等你在公众号后台群发
    for (const s of ['pending', 'ready', 'filled', 'submitted']) {
      expect(publishStatus(s), `${s} 应该是 waiting`).toBe('waiting');
    }
    expect(publishStatus('published')).toBe('done');
    expect(publishStatus('failed')).toBe('failed');
    expect(publishStatus('skipped')).toBe('cancelled');
  });

  it('采集批次一律已完成：note 有降级说明也不算失败', () => {
    // 「采到了但少采了」标成 failed 会让用户以为数据根本没进来
    expect(collectStatus()).toBe('done');
    const d = collectDetail({ items: 12, created: 5, updated: 7, note: '触发频控，本批只采了一页' });
    expect(d).toContain('收到 12 条');
    expect(d).toContain('新增 5');
    expect(d).toContain('触发频控');
    expect(collectDetail({ items: 3, created: 3, updated: 0, note: null })).not.toContain('·  ');
  });
});

describe('每一类的 href 都要指到真的有这块内容的地方', () => {
  it('浏览器任务落在运行中心，而运行中心真的渲染这一类', () => {
    // 2026-08-19 犯过一次：运行中心让用户去 /extension 看浏览器任务，那一页却一个字都没有。
    // 2026-08-26 又改了一次落点——用户原话「为什么点最近是跳到插件里去呢」：
    // 浏览器任务是「有什么在跑」，跟「怎么装扩展」是两件事，而 /runs 本来就收这一类、
    // 还带取消按钮。守的性质没变：**落点那一页必须真的有这块内容**。
    expect(SRC, '浏览器任务又落回插件页了').not.toMatch(/href: '\/extension#browser-tasks'/);
    expect(SRC).toMatch(/href: '\/runs'/);
    const runs = codeOfDir('app/(app)/runs');
    expect(runs, '运行中心没有认 browser 这一类').toMatch(/kind === 'browser'/);
  });

  it('带锚点/带 query 的 href 不许让「去XX」按钮退化成「去相关页面」', () => {
    const page = codeOfDir('app/(app)/runs');
    // navLabel 要先剥 # 与 ? 再去 NAV 里找，否则 /extension#x、/assistant?run=x
    // 都找不到，一律落到「去相关页面」这种废话
    expect(page).toMatch(/href\.split\(\/\[#\?\]\/\)\[0\]/);
  });

  it('AI 执行那条必须带上 runId——否则「等你确认」是个永远确认不了的死胡同', () => {
    // 助手页只有本地 state，看不见任何一次已存在的运行。光指 '/assistant' 的话，
    // 用户从「等你处理」点过去只会落到一个空白输入框，那次执行永远停在 awaiting_confirm
    expect(SRC, "lib/runs 里 agent 的 href 丢了 runId").toMatch(/href: `\/assistant\?run=\$\{r\.id\}`/);
    // 另一头也要接得住：助手页必须真的读这个参数并把运行恢复出来
    expect(code('app/(app)/assistant/page.tsx')).toMatch(/searchParams/);
    expect(code('app/(app)/assistant/AgentPanel.tsx'), 'AgentPanel 没有恢复既有运行的通道')
      .toMatch(/actGetAgentRun/);
  });

  it('每一类的落地页都在导航里存在（剥掉锚点之后）', async () => {
    const { NAV, reachableRoutes } = await import('@/lib/nav');
    // covers 也算「在导航里」：/workflows 由「技能 · 连接器」页顶标签覆盖（2026-08-26 扁平化）
    const known = reachableRoutes(NAV);
    // 从源码里把所有 href 抠出来核一遍，避免加了新一类却指向不存在的路由
    // 单引号常量与模板串两种写法都要收：agent 那条是 `/assistant?run=${r.id}`，
    // 只扫单引号的话它会静悄悄地脱离这条守卫
    const quoted = [...SRC.matchAll(/href: '([^']+)'/g)].map((m) => m[1]);
    const templated = [...SRC.matchAll(/href: `([^`]+)`/g)].map((m) => m[1]);
    // 两种写法都要真的扫到：agent 那条是模板串 `/assistant?run=${r.id}`，
    // 只扫单引号的话它会静悄悄地脱离这条守卫
    expect(quoted.length, '单引号 href 一条都没扫到，正则大概是坏的').toBeGreaterThanOrEqual(3);
    expect(templated.length, '模板串 href 一条都没扫到').toBeGreaterThanOrEqual(1);
    const hrefs = [...quoted, ...templated].map((h) => h.split(/[#?]/)[0]);
    for (const h of hrefs) expect(known, `${h} 不在导航里`).toContain(h);
  });
});

describe('工作流的触发来源：同一个红字，用户该做的事不一样', () => {
  it('定时与 AI 派的要标出来，手点的不标（默认路径，标了只是噪音）', () => {
    expect(TRIGGER_LABEL.schedule).toBeTruthy();
    expect(TRIGGER_LABEL.agent).toBeTruthy();
    expect(TRIGGER_LABEL.manual, '手点是默认路径，不该有标签').toBeUndefined();
  });

  it('三条触发路径各自写死了自己的来源，一条都不许漏', () => {
    // 漏了就退化成「全是 manual」，运行中心分不出来，而且不会报错
    expect(code('lib/workflow/schedule.ts'), '定时那条没标 schedule').toMatch(/trigger: 'schedule'/);
    expect(code('lib/agent/tools.ts'), 'AI 派的那条没标 agent').toMatch(/trigger: 'agent'/);
    // 建 run 时要真的写进库
    expect(code('lib/workflow/run.ts')).toMatch(/trigger: ctx\.trigger \?\? 'manual'/);
  });

  it('来源标签拼进 detail，不是只存不显示', () => {
    expect(SRC).toMatch(/TRIGGER_LABEL\[r\.trigger\]/);
  });
});

describe('排序：等人的排最前', () => {
  it('waiting 在 running 之前，failed 在 done 之前', () => {
    const sorted = sortRuns([
      row({ id: 'done', status: 'done' }),
      row({ id: 'run', status: 'running' }),
      row({ id: 'wait', status: 'waiting' }),
      row({ id: 'fail', status: 'failed' }),
      row({ id: 'cancel', status: 'cancelled' }),
    ]);
    expect(sorted.map((r) => r.id)).toEqual(['wait', 'run', 'fail', 'done', 'cancel']);
  });

  it('同状态内新的在前', () => {
    const sorted = sortRuns([
      row({ id: 'old', status: 'waiting', at: at('2026-08-18T10:00:00Z') }),
      row({ id: 'new', status: 'waiting', at: at('2026-08-19T10:00:00Z') }),
    ]);
    expect(sorted.map((r) => r.id)).toEqual(['new', 'old']);
  });

  it('不改原数组', () => {
    const input = [row({ id: 'a', status: 'done' }), row({ id: 'b', status: 'waiting' })];
    sortRuns(input);
    expect(input.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('计数覆盖全部五种状态，没有的记 0（不是 undefined）', () => {
    const n = countByStatus([row({ status: 'waiting' }), row({ status: 'waiting' }), row({ status: 'failed' })]);
    expect(n.waiting).toBe(2);
    expect(n.failed).toBe(1);
    expect(n.done).toBe(0);
    expect(n.running).toBe(0);
    expect(n.cancelled).toBe(0);
  });
});

describe('口径守卫：这几条走反了不会红也不会 404，只会让用户看不见东西', () => {
  it('不收 JobRun——那是平台替所有租户跑的作业，不是这个用户发起的', () => {
    // JobRun 没有 workspaceId，混进来用户会以为是自己的任务，而他既停不掉也重跑不了
    expect(SRC).not.toMatch(/prisma\.jobRun/);
  });

  it('发布任务必须经 PublishPlan join——直接查 PublishTask 会捞到别的工作区', () => {
    // PublishTask 上没有 workspaceId，它挂在 plan 下
    expect(SRC).not.toMatch(/prisma\.publishTask\.findMany/);
    expect(SRC).toMatch(/prisma\.publishPlan\.findMany/);
  });

  it('刻意不按 accountId 过滤：切错账号就以为任务没跑，是「回填成功但看板空白」的翻版', () => {
    // 四个查询的 where 里只能有 workspaceId。这里逐个查 where 子句，
    // 而不是全文搜 accountId —— select/map 里读 accountId 是正常的（要标明归属）
    const wheres = [...SRC.matchAll(/where:\s*\{([^}]*)\}/g)].map((m) => m[1]);
    expect(wheres.length).toBeGreaterThanOrEqual(5);
    for (const w of wheres) {
      expect(w, `这个 where 里出现了 accountId：${w.trim()}`).not.toMatch(/accountId/);
    }
  });

  it('跨账号可见的前提：每条都能标明归属账号', () => {
    expect(SRC).toMatch(/accountName/);
    // 竞对采集不属于任何自有账号，这一条允许留空，但自有采集要带上目标名
    expect(SRC).toMatch(/scope === 'rival'/);
  });

  it('竞对采集指向竞对监控页，自有采集指向数据看板——指错就是指路指到空页面', () => {
    expect(SRC).toMatch(/scope === 'rival' \? '\/competitors' : '\/data'/);
  });
});
