import { describe, it, expect } from 'vitest';
import {
  CALENDAR_NODES,
  LUNAR_TABLE_YEARS,
  resolveNodeDate,
  upcomingNodes,
  calendarCandidates,
} from '@/lib/topic/sources/calendar';
import { emptyPersona, type PersonaCard } from '@/lib/persona';

// 可预测热点日历（lib/topic/sources/calendar.ts）。
// 这个源的价值全在**提前量**，所以本文件锁的是「窗口算得对不对」和「绝不进今日突击」。

const persona = (over: Partial<PersonaCard> = {}): PersonaCard => ({
  ...emptyPersona(),
  identity: '职场成长博主',
  niche: '职场成长',
  platforms: ['douyin'],
  ...over,
});

const at = (iso: string) => new Date(`${iso}T00:00:00Z`);
const node = (key: string) => CALENDAR_NODES.find((n) => n.key === key)!;

describe('日期解析', () => {
  it('公历固定日', () => {
    expect(resolveNodeDate(node('sales618'), 2026)!.toISOString().slice(0, 10)).toBe('2026-06-18');
    expect(resolveNodeDate(node('gaokao'), 2027)!.toISOString().slice(0, 10)).toBe('2027-06-07');
  });

  it('第 n 个星期几：母亲节 = 5 月第 2 个周日、父亲节 = 6 月第 3 个周日', () => {
    // 2026-05-10 是周日（5/3 是第一个周日）
    expect(resolveNodeDate(node('mothersday'), 2026)!.toISOString().slice(0, 10)).toBe('2026-05-10');
    // 2026-06-21 是第三个周日
    expect(resolveNodeDate(node('fathersday'), 2026)!.toISOString().slice(0, 10)).toBe('2026-06-21');
  });

  it('农历/节气查表命中', () => {
    expect(resolveNodeDate(node('cny'), 2026)!.toISOString().slice(0, 10)).toBe('2026-02-17');
    expect(resolveNodeDate(node('midautumn'), 2026)!.toISOString().slice(0, 10)).toBe('2026-09-25');
  });

  it('表外年份返回 null —— 不外推、不猜。日期错了的节点提醒比没有提醒更糟（用户会按它排产）', () => {
    expect(resolveNodeDate(node('cny'), 2099)).toBeNull();
    expect(resolveNodeDate(node('dragonboat'), 2020)).toBeNull();
  });
});

// ⚠️ 这是一条**故意的时间炸弹**，不是写错了。
// 农历表是人工维护的，用完了就会让春节/中秋这些节点**静默消失**。
// 与其让它悄悄没了，不如每年年底让这条用例变红，提醒续表（改 LUNAR_TABLE + LUNAR_TABLE_YEARS）。
describe('农历表覆盖度（到期会主动变红，提醒续表）', () => {
  it('必须覆盖今年和明年', () => {
    const thisYear = new Date().getUTCFullYear();
    for (const y of [thisYear, thisYear + 1]) {
      expect(
        (LUNAR_TABLE_YEARS as readonly number[]).includes(y),
        `农历/节气表未覆盖 ${y} 年：请在 lib/topic/sources/calendar.ts 的 LUNAR_TABLE 补上该年日期，` +
          '并同步 LUNAR_TABLE_YEARS。未覆盖的年份里，春节/中秋等查表节点会整个消失。',
      ).toBe(true);
    }
  });

  it('声明覆盖的年份，每个查表节点都真的有值（别只改了年份列表没补数据）', () => {
    for (const n of CALENDAR_NODES.filter((x) => x.rule.kind === 'table')) {
      for (const y of LUNAR_TABLE_YEARS) {
        expect(resolveNodeDate(n, y), `${n.name}(${n.key}) 缺 ${y} 年日期`).not.toBeNull();
      }
    }
  });
});

describe('upcomingNodes 窗口', () => {
  it('只在节点自己的准备期内才出现', () => {
    // 618 的 leadDays=21，2026-06-18 往前推 21 天 = 5/28
    expect(upcomingNodes(at('2026-05-29')).some((u) => u.node.key === 'sales618')).toBe(true);
    expect(upcomingNodes(at('2026-05-20')).some((u) => u.node.key === 'sales618')).toBe(false);
  });

  it('节点当天仍算数，过了就不再提', () => {
    expect(upcomingNodes(at('2026-06-18')).some((u) => u.node.key === 'sales618')).toBe(true);
    expect(upcomingNodes(at('2026-06-19')).some((u) => u.node.key === 'sales618')).toBe(false);
  });

  it('跨年：12 月能看到下一年 1 月的节点', () => {
    const list = upcomingNodes(at('2026-12-28'));
    const ny = list.find((u) => u.node.key === 'newyearplan');
    expect(ny).toBeTruthy();
    expect(ny!.date.getUTCFullYear()).toBe(2027);
    expect(ny!.daysUntil).toBe(4);
  });

  it('越近的排越前', () => {
    const list = upcomingNodes(at('2026-05-30'));
    for (let i = 1; i < list.length; i++) {
      expect(list[i].daysUntil).toBeGreaterThanOrEqual(list[i - 1].daysUntil);
    }
  });

  it('农历表用完的年份不产出查表节点（静默跳过而非报错）', () => {
    // 2099 年表里没有任何农历节点，但公历节点照常
    const list = upcomingNodes(at('2099-02-10'));
    expect(list.some((u) => u.node.rule.kind === 'table')).toBe(false);
    expect(list.some((u) => u.node.key === 'valentine')).toBe(true);
  });
});

describe('calendarCandidates 转候选', () => {
  it('赛道词代入模板，证据里写清还有几天和为什么值得做', () => {
    const list = calendarCandidates({ persona: persona(), now: at('2026-06-10') });
    const c = list.find((x) => x.sourceRef === 'sales618')!;
    expect(c.title).toContain('职场成长');
    expect(c.sourceType).toBe('calendar');
    expect(c.evidence).toContain('还有 8 天');
    expect(c.evidence).toContain('6 月 18 日');
    expect(c.windowHint).toContain('提前');
  });

  it('队列恒为「本周窗口」——日历的价值就是提前量，进今日突击等于自毁定位', () => {
    const list = calendarCandidates({ persona: persona(), now: at('2026-06-18') });
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((c) => c.queue === 'week')).toBe(true);
  });

  it('节点当天证据说「就是今天」，不说「还有 0 天」', () => {
    const list = calendarCandidates({ persona: persona(), now: at('2026-06-18') });
    expect(list.find((x) => x.sourceRef === 'sales618')!.evidence).toContain('就是今天');
  });

  it('热度封顶 0.55 —— 确定会来的流量 ≠ 此刻正在发生的流量，不该压过真热点', () => {
    const list = calendarCandidates({ persona: persona(), now: at('2026-11-11') });
    expect(list.every((c) => c.heat <= 0.55)).toBe(true);
    expect(list.every((c) => c.heat > 0)).toBe(true);
  });

  it('越临近热度越高（同一节点，早 vs 晚）', () => {
    const early = calendarCandidates({ persona: persona(), now: at('2026-05-30') }).find((c) => c.sourceRef === 'sales618')!;
    const late = calendarCandidates({ persona: persona(), now: at('2026-06-16') }).find((c) => c.sourceRef === 'sales618')!;
    expect(late.heat).toBeGreaterThan(early.heat);
  });

  it('没填赛道词 → 退回通用表述，句子仍然成立（不出缺主语的标题）', () => {
    const list = calendarCandidates({ persona: emptyPersona(), now: at('2026-06-10') });
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((c) => !c.title.includes('{n}'))).toBe(true);
    expect(list.find((x) => x.sourceRef === 'sales618')!.title).toBe('618 大促前后，可以做点什么内容');
  });

  it('已推过的同名标题可排除', () => {
    const first = calendarCandidates({ persona: persona(), now: at('2026-06-10') });
    const again = calendarCandidates({
      persona: persona(),
      now: at('2026-06-10'),
      exclude: new Set([first[0].title]),
    });
    expect(again.map((c) => c.title)).not.toContain(first[0].title);
  });

  it('默认最多 3 条：日历不该把本周窗口挤满', () => {
    // 6 月中旬同时有 618/毕业季/父亲节/高考志愿等多个节点
    expect(calendarCandidates({ persona: persona(), now: at('2026-06-15') }).length).toBeLessThanOrEqual(3);
  });
});

// 这个源的实用性直接取决于「一年里有多少天它是有货的」。
// 初版节点表实测只有 67% 覆盖，7 月初到 8 月上旬连续 38 天空窗——而暑期恰恰是内容消费高峰。
// 补了暑假季/暑期档/315/520/万圣节/黑五之后到 84%、最大空窗 13 天。
// 这两条线是产品下限，往下掉说明有人删了节点或改坏了窗口逻辑。
describe('全年覆盖率（防止节点表被改瘦而无人察觉）', () => {
  function coverage(year: number) {
    const start = Date.UTC(year, 0, 1);
    let covered = 0;
    let maxGap = 0;
    let gap = 0;
    for (let d = 0; d < 365; d++) {
      if (upcomingNodes(new Date(start + d * 86_400_000)).length > 0) {
        covered++;
        gap = 0;
      } else {
        gap++;
        maxGap = Math.max(maxGap, gap);
      }
    }
    return { ratio: covered / 365, maxGap };
  }

  it('一年至少 80% 的日子有可推的节点', () => {
    expect(coverage(2026).ratio).toBeGreaterThanOrEqual(0.8);
  });

  it('最长空窗不超过 15 天', () => {
    expect(coverage(2026).maxGap).toBeLessThanOrEqual(15);
  });
});

describe('节点表自身的完整性', () => {
  it('key 唯一、importance 在 0-1、leadDays 为正', () => {
    const keys = CALENDAR_NODES.map((n) => n.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const n of CALENDAR_NODES) {
      expect(n.importance, n.key).toBeGreaterThan(0);
      expect(n.importance, n.key).toBeLessThanOrEqual(1);
      expect(n.leadDays, n.key).toBeGreaterThan(0);
      expect(n.topic.length, n.key).toBeGreaterThan(0);
      expect(n.why.length, n.key).toBeGreaterThan(0);
    }
  });
});
