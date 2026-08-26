import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { shouldRun, parseWeekdays, MAX_RUNS_PER_DAY, AUTO_PAUSE_FAILS, type ScheduleRow } from '@/lib/workflow/schedule';
import { AGENT_TICK_MINUTES, SCHEDULES, SCHEDULE_TZ } from '@/lib/jobs/schedule-config';
import { JOB_TRACK } from '@/lib/jobs/types';

const ROOT = path.resolve(__dirname, '..');
const code = (p: string) =>
  fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const row = (p: Partial<ScheduleRow> = {}): ScheduleRow => ({
  id: 'x', workspaceId: 'w', accountId: 'a',
  // 缺省仍是流水线型（旧行为）；派预设任务的那种传 targetKind: 'task'
  targetKind: 'workflow', taskPresetId: null, templateId: 't',
  atHour: 9, atMinute: 0, weekdays: [], enabled: true, failStreak: 0, lastRunDay: null, ...p,
});

/** 北京时间的某时刻（容器跑 UTC，用例不能用 new Date('...09:00') 这种本地时间写法） */
const cn = (iso: string) => new Date(`${iso}+08:00`);

describe('到点判定：早跑一轮白烧配额，漏跑一天用户第二天才发现', () => {
  it('到点后一个扫描窗口内会跑，窗口外不跑', () => {
    expect(shouldRun(row(), cn('2026-08-19T09:00:00'), 10)).toBe(true);
    expect(shouldRun(row(), cn('2026-08-19T09:09:59'), 10)).toBe(true);
    // 窗口右端是开区间：09:10 属于下一轮，这一轮跑过了就该由 lastRunDay 挡住
    expect(shouldRun(row(), cn('2026-08-19T09:10:00'), 10)).toBe(false);
    expect(shouldRun(row(), cn('2026-08-19T08:59:59'), 10)).toBe(false);
  });

  it('用窗口而不是「分钟正好相等」——抖动或堆积会让这一天整个跳过', () => {
    // 扫描晚到 3 分钟：要求相等的实现会漏掉一整天
    expect(shouldRun(row({ atMinute: 30 }), cn('2026-08-19T09:33:00'), 10)).toBe(true);
  });

  it('同一逻辑日只跑一次（扫描每 10 分钟一轮，不挡就会连开好几次）', () => {
    const ran = row({ lastRunDay: '2026-08-19' });
    expect(shouldRun(ran, cn('2026-08-19T09:00:00'), 10)).toBe(false);
    // 第二天照跑
    expect(shouldRun(ran, cn('2026-08-20T09:00:00'), 10)).toBe(true);
  });

  it('停用的一律不跑', () => {
    expect(shouldRun(row({ enabled: false }), cn('2026-08-19T09:00:00'), 10)).toBe(false);
  });

  it('周几按北京时间算——用 UTC 的话跨零点那几小时会差一天', () => {
    // 2026-08-19 是周三(3)。北京时间 00:30 时，UTC 还是周二
    const wed = row({ weekdays: [3], atHour: 0, atMinute: 30 });
    expect(shouldRun(wed, cn('2026-08-19T00:30:00'), 10)).toBe(true);
    const tue = row({ weekdays: [2], atHour: 0, atMinute: 30 });
    expect(shouldRun(tue, cn('2026-08-19T00:30:00'), 10)).toBe(false);
  });

  it('周几为空 = 每天', () => {
    for (const d of ['2026-08-17', '2026-08-19', '2026-08-22', '2026-08-23']) {
      expect(shouldRun(row(), cn(`${d}T09:00:00`), 10), d).toBe(true);
    }
  });
});

describe('weekdays 解析：脏数据不许变成「永远不跑」或「天天跑」', () => {
  it('非法值丢掉，去重，越界剔除', () => {
    expect(parseWeekdays('[1,3,5]')).toEqual([1, 3, 5]);
    expect(parseWeekdays('[1,1,3]')).toEqual([1, 3]);
    expect(parseWeekdays('[7,-1,1.5,"x",null]')).toEqual([]);
    expect(parseWeekdays('[]')).toEqual([]);
  });

  it('坏 JSON / 非数组一律当「每天」，不抛', () => {
    for (const bad of ['{不是 json', 'null', '{}', '"1,2"', '123']) {
      expect(() => parseWeekdays(bad)).not.toThrow();
      expect(parseWeekdays(bad), bad).toEqual([]);
    }
  });
});

describe('三道闸是这个功能的前提，不是加分项', () => {
  it('闸①每日上限、闸②连续失败自动停，阈值都是有限正数', () => {
    // 写成 0 或 Infinity 都等于没有闸
    expect(MAX_RUNS_PER_DAY).toBeGreaterThan(0);
    expect(MAX_RUNS_PER_DAY).toBeLessThanOrEqual(20);
    expect(AUTO_PAUSE_FAILS).toBeGreaterThan(0);
    expect(AUTO_PAUSE_FAILS).toBeLessThanOrEqual(10);
  });

  it('闸①在真正开跑之前判——判晚了配额已经烧掉了', () => {
    const src = code('lib/workflow/schedule.ts');
    const gateAt = src.indexOf('MAX_RUNS_PER_DAY');
    const runAt = src.indexOf('await runWorkflow');
    expect(gateAt).toBeGreaterThan(-1);
    expect(runAt).toBeGreaterThan(-1);
    expect(gateAt, '每日上限的判断必须在 runWorkflow 之前').toBeLessThan(runAt);
  });

  it('先抢占 lastRunDay 再跑——跑一半挂了不许明天补跑两次', () => {
    const src = code('lib/workflow/schedule.ts');
    const claimAt = src.indexOf('lastRunDay: beijingDayKey(now)');
    const runAt = src.indexOf('await runWorkflow');
    expect(claimAt).toBeGreaterThan(-1);
    expect(claimAt, '写 lastRunDay 必须在 runWorkflow 之前').toBeLessThan(runAt);
  });

  it('闸②停用时必须同时告警——用户不在场，光改 enabled 他要好几天后才发现', () => {
    // 2026-08-19 第一版只做了「自动停用」，告警漏了。定时是用户睡着时在跑：
    // 不通知的话他下一次知道是「某天发现稿子没出」，中间已经白停了好几天
    const src = code('lib/workflow/schedule.ts');
    const pause = src.slice(src.indexOf('async function autoPauseIfBroken'));
    expect(pause).toMatch(/enabled: false/);
    expect(pause, '停用了却不通知').toMatch(/notify\(/);
  });

  it('闸①跳过也要说一声——那条计划今天没执行，不说等于静默吞掉', () => {
    const src = code('lib/workflow/schedule.ts');
    const gate = src.slice(src.indexOf('MAX_RUNS_PER_DAY'), src.indexOf('await runWorkflow'));
    expect(gate).toMatch(/notify\(/);
  });

  it('跑完要推给用户——定时是他不在场时跑的，不推等于只省了点手点', () => {
    const src = code('lib/workflow/schedule.ts');
    expect(src, '跑完没推送').toMatch(/pushEvent\(/);
    expect(src).toMatch(/'agent_done'/);
    // 机器人卡片里的链接必须是绝对地址：飞书客户端里点相对路径打不开
    expect(src, '推送链接没走 beaconUrl').toMatch(/beaconUrl\('\/runs'\)/);
    // 推送失败不许影响运行结果与后面的计划
    expect(src).toMatch(/\}\)\.catch\(\(\) => \{\}\)/);
  });

  it('通知与推送都要说清「是哪条计划」——一个工作区最多 5 条，只说「定时智能体」还得自己对', () => {
    const src = code('lib/workflow/schedule.ts');
    // 【这条守的是意图不是写法】早先它数的是 `tplName.get(` 出现几次，
    // 而定时现在能指两种东西（流水线模板 / 一键任务），名字改由 nameOf 统一算——
    // 数旧写法会把一个更好的抽象判红。要钉的是「每处通知都带上了名字」。
    expect(src, '没有统一的「这条计划叫什么」').toMatch(/const nameOf =/);
    expect((src.match(/nameOf\(r\)/g) ?? []).length, '有通知/推送没带上计划名')
      .toBeGreaterThanOrEqual(4);
    // 两种指向都要认得，且被删了要如实说而不是印一个空名字
    expect(src, 'nameOf 没处理一键任务那种').toMatch(/presetName/);
    expect(src, '被删了没有兜底名字').toMatch(/这条计划/);
  });

  it('告警要指得回来——link 指向配这些计划的页面', () => {
    const src = code('lib/workflow/schedule.ts');
    const links = [...src.matchAll(/link: '([^']+)'/g)].map((m) => m[1]);
    expect(links.length, '一条告警链接都没有').toBeGreaterThan(0);
    for (const l of links) expect(l, `${l} 不是定时计划所在的页面`).toBe('/workflows');
  });

  it('配额用完不算「坏模板」——不累加失败次数，否则连续三天用超就把计划全停了', () => {
    const src = code('lib/workflow/schedule.ts');
    // 判据必须是 code 不是 message：文案一改字符串匹配就失效，而且失效得静悄悄
    expect(src).toMatch(/code === 'QUOTA_EXCEEDED'/);
    expect(src, '配额那次仍然累加了 failStreak').toMatch(/failStreak: ok \|\| quota \? 0 :/);
    // 而且要告诉用户「计划还在，额度回来就照跑」，不然他以为坏了
    expect(src).toMatch(/额度/);
  });

  it('错误码得真的被 runWorkflow 打上，否则上一条守的是个永远为假的分支', () => {
    const src = code('lib/workflow/run.ts');
    expect(src).toMatch(/err instanceof QuotaExceededError \? 'QUOTA_EXCEEDED' : undefined/);
    // StepLog 的类型里也要有它，不然调用方读不到
    expect(src).toMatch(/code\?: 'QUOTA_EXCEEDED'/);
  });

  it('一条计划失败不许把整轮带走', () => {
    const src = code('lib/workflow/schedule.ts');
    expect(src).toMatch(/try \{/);
    expect(src).toMatch(/catch \(err\)/);
  });

  it('不给用户写 cron——写错一个字段就是一小时跑 60 次', () => {
    const src = code('lib/workflow/schedule.ts');
    expect(src).not.toMatch(/cron/i);
    // 只认「几点几分 + 周几」
    expect(src).toMatch(/atHour/);
    expect(src).toMatch(/atMinute/);
  });
});

describe('没有后台调度的部署上，不许让用户配一个永不执行的计划', () => {
  it('判据是队列类型，不是部署形态', async () => {
    const { backgroundSchedulerRuns } = await import('@/lib/jobs/queue');
    vi.stubEnv('BEACON_QUEUE', 'bullmq');
    expect(backgroundSchedulerRuns()).toBe(true);
    // 进程内队列的 schedule() 是空实现：整机版（只启 next start）与本机 dev 都走这条
    vi.stubEnv('BEACON_QUEUE', '');
    expect(backgroundSchedulerRuns()).toBe(false);
    vi.unstubAllEnvs();
  });

  it('不许把它做成 edition 的 Capability——那张矩阵钉死了「两个企业版能力面一致」', () => {
    // 定时跑不跑是**基础设施**差异（有没有独立 worker 进程），不是产品能力面。
    // 放进矩阵会让 appliance 与 private 分叉，违反 lib/edition.ts 顶部写的原则
    expect(code('lib/edition.ts')).not.toMatch(/backgroundSchedule/);
  });

  it('界面与服务端都要拦——只藏界面等于没拦', () => {
    expect(code('app/(app)/workflows/Schedules.tsx')).toMatch(/if \(!scheduleWorks\)/);
    // 服务端那道闸在**建计划的领域函数**里，不在 action 里——抽出来是因为 AI 也要能
    // 起草定时计划，而它跑在后台没有会话、调不了 server action。闸放在领域函数里，
    // 两条入口（页面表单 / AI 起草后确认）就都绕不过去
    expect(code('lib/workflow/schedule-create.ts')).toMatch(/if \(!backgroundSchedulerRuns\(\)\)/);
    // 且 action 必须真的走那条领域函数，不许自己再建一份
    expect(code('app/(app)/workflows/schedule-actions.ts'), 'action 要委托给领域函数，不能自己 create').toMatch(/createSchedule\(/);
    expect(
      code('app/(app)/workflows/schedule-actions.ts'),
      'action 里再出现 scheduledAgent.create 就是又分叉出了第二份口径',
    ).not.toMatch(/scheduledAgent\.create\(/);
  });

  it('说明要讲清「为什么不给」和「那我怎么办」', () => {
    // 断言对准**语义**而不是某句话的字面：措辞会改（改过一次——原文写死了「整机版」，
    // 而本机 dev 同样走进程内队列，对着开发者说整机版是答非所问）
    const src = code('app/(app)/workflows/Schedules.tsx');
    expect(src, '没说清为什么不给').toMatch(/不会触发|不会到点执行|没有在跑/);
    expect(src, '只说不行、不给出路，用户只会以为功能坏了').toMatch(/跑一遍/);
    expect(src, '没告诉他换成什么部署才有').toMatch(/worker|后台任务进程/);
  });
});

describe('推送事件要能被用户勾上，不然推了也没人收', () => {
  it('agent_done 在 PUSH_EVENTS 清单里，且有名字与说明', async () => {
    const { PUSH_EVENTS } = await import('@/lib/bot/types');
    const ev = PUSH_EVENTS.find((e) => e.key === 'agent_done');
    // 设置页的勾选框是从这张表渲染的：不在表里 = 用户永远勾不上 = pushEvent 发了也没人订阅
    expect(ev, 'agent_done 不在 PUSH_EVENTS 里，用户勾不上它').toBeTruthy();
    expect(ev!.name).toBeTruthy();
    expect(ev!.desc.length).toBeGreaterThanOrEqual(8);
  });

  it('服务端校验白名单也认它——否则用户勾了保存不上', async () => {
    const { PUSH_EVENTS } = await import('@/lib/bot/types');
    // bot-actions.ts 的 VALID_EVENTS 是从 PUSH_EVENTS 现算的，这条守的是「别改成手写清单」
    expect(code('app/(app)/settings/bot-actions.ts')).toMatch(/PUSH_EVENTS\.map\(\(e\) => e\.key\)/);
    expect(PUSH_EVENTS.map((e) => e.key)).toContain('agent_done');
  });
});

describe('接进定时体系：时区与间隔是两个踩过的坑', () => {
  it('扫描间隔与窗口宽度是同一个数，否则要么漏跑要么一天跑两次', () => {
    const entry = SCHEDULES.find((s) => s.name === 'run_scheduled_agents');
    expect(entry, '定时智能体没注册进 SCHEDULES').toBeTruthy();
    expect(entry!.cron).toBe(`*/${AGENT_TICK_MINUTES} * * * *`);
    // handler 传给 tickScheduledAgents 的也必须是这个常量，不能另写一个字面量
    expect(code('lib/jobs/handlers.ts')).toMatch(/tickScheduledAgents\(new Date\(\), AGENT_TICK_MINUTES\)/);
  });

  it('cron 时区必须是北京时间（容器跑 UTC，不传就晚 8 小时）', () => {
    expect(SCHEDULE_TZ).toBe('Asia/Shanghai');
  });

  it('归到广播轨：它自己扫全表找到点的，不需要外层按租户分批', () => {
    expect(JOB_TRACK.run_scheduled_agents).toBe('broadcast');
  });
});

describe('「什么时候跑」这句话只有一处口径', () => {
  it('空数组 = 每天（跟 shouldRun 的判断一致）', async () => {
    const { scheduleWhen } = await import('@/lib/workflow/schedule-format');
    // shouldRun 里 weekdays 长度为 0 时**直接跳过**星期判断 = 天天跑。
    // 写成「长度 7 才算每天」是错的，而且错得很静：界面会把一条天天跑的计划
    // 显示成「每周日、一、二…」，用户据此以为自己配错了
    expect(scheduleWhen([], 9, 0)).toBe('每天 09:00');
    expect(scheduleWhen([1, 3], 9, 5)).toBe('每周一、三 09:05');
    // 七天全勾**不是**空数组，照实说每一天（shouldRun 对它俩的行为一样，但用户勾的样子不同）
    expect(scheduleWhen([0, 1, 2, 3, 4, 5, 6], 9, 0)).toContain('每周');
  });

  it('界面与 AI 说的是同一句——两处各算一遍迟早对不上', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const root = path.resolve(__dirname, '..');
    const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
    // 定时那张表（客户端）与 AI 的 list_schedules（服务端）都必须引这一份纯函数
    expect(read('app/(app)/workflows/Schedules.tsx')).toContain('schedule-format');
    expect(read('lib/agent/tools.ts')).toContain('schedule-format');
    // 那个文件不许碰 prisma：它被客户端组件 import，一碰就打包失败（tsc 与单测都不会红）。
    // ⚠️ 断言前先剥注释——那个文件的注释里恰恰在解释「schedule.ts 里有 prisma 所以不能引」，
    // 直接全文搜会被自己的注释判红（同 shell-modes 里 href="#" 那次假红）
    const noComments = read('lib/workflow/schedule-format.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(noComments).not.toContain('prisma');
  });
});
