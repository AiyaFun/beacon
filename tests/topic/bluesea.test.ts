import { describe, it, expect } from 'vitest';
import {
  demandProxy,
  blueSeaScore,
  saturationCenter,
  blueSeaEvidence,
  blueSeaByTitle,
  BLUE_SEA_BADGE,
} from '@/lib/topic/bluesea';
import { coarseRank, type Candidate } from '@/lib/topic/scoring';
import { emptyPersona, type PersonaCard } from '@/lib/persona';

// 蓝海度（lib/topic/bluesea.ts）。
// 两条最该守住的：
//   ① 需求代理**只是站内可观测的代理信号**，措辞不许说成搜索指数；
//   ② 它**不新增权重项**，只把饱和度倒U的最优点往低供给方向推——
//      缺省空表时公式必须与接入前逐字一致（否则等于悄悄改了所有账号的排序）。

describe('demandProxy 需求代理', () => {
  it('在榜越久、扩散越广，需求证据越强', () => {
    expect(demandProxy({ hoursOnList: 48, sourceCount: 4 })).toBe(1);
    expect(demandProxy({ hoursOnList: 24, sourceCount: 4 })).toBeCloseTo(0.75);
    expect(demandProxy({ hoursOnList: 48, sourceCount: 1 })).toBeCloseTo(0.5);
  });

  it('单平台上榜的扩散度是 0——一个平台不叫扩散', () => {
    expect(demandProxy({ hoursOnList: 0, sourceCount: 1 })).toBe(0);
  });

  it('两项都缺 → 0，即「没有需求证据」，下游完全退回原行为', () => {
    expect(demandProxy({})).toBe(0);
  });

  it('超出满分线不会溢出，负值当 0', () => {
    expect(demandProxy({ hoursOnList: 9999, sourceCount: 99 })).toBe(1);
    expect(demandProxy({ hoursOnList: -5, sourceCount: 0 })).toBe(0);
  });

  it('持续性与扩散各占一半：只久不广、只广不久都不给满分', () => {
    expect(demandProxy({ hoursOnList: 48, sourceCount: 1 })).toBeLessThan(1);
    expect(demandProxy({ hoursOnList: 0, sourceCount: 4 })).toBeLessThan(1);
  });
});

describe('blueSeaScore', () => {
  it('需求强 + 供给空 = 蓝海；供给挤满 = 0', () => {
    expect(blueSeaScore(1, 0)).toBe(1);
    expect(blueSeaScore(1, 1)).toBe(0);
    expect(blueSeaScore(0.8, 0.25)).toBeCloseTo(0.6);
  });

  it('没有需求证据时，供给再空也不是蓝海（那可能只是没人要）', () => {
    expect(blueSeaScore(0, 0)).toBe(0);
  });
});

describe('saturationCenter 倒U最优点', () => {
  it('无需求证据 → 中心 0.5，与接入前完全一致', () => {
    expect(saturationCenter(0)).toBe(0.5);
  });

  it('需求拉满 → 最优点推到 0，「没人做」成为最优而非风险', () => {
    expect(saturationCenter(1)).toBe(0);
  });

  it('越界输入被钳住', () => {
    expect(saturationCenter(-1)).toBe(0.5);
    expect(saturationCenter(9)).toBe(0);
  });
});

describe('coarseRank 接入（不叠权重，只挪中心）', () => {
  const persona: PersonaCard = { ...emptyPersona(), niche: '前端工程化', identity: '前端工程师' };
  const cand = (title: string): Candidate => ({ title, heat: 0.5, sourceType: 'douyin' });

  it('不传 demand → 排序与接入前逐字相同（低饱和仍被倒U惩罚）', () => {
    const pool = [cand('前端工程化甲'), cand('前端工程化乙')];
    const sat = { 前端工程化甲: 0.5, 前端工程化乙: 0.0 };
    // 中心 0.5：甲正中最优，乙偏离最远
    expect(coarseRank(pool, persona, sat)[0].title).toBe('前端工程化甲');
  });

  it('同样是零供给，有需求证据的那条胜出——这正是蓝海要解决的事', () => {
    const pool = [cand('前端工程化甲'), cand('前端工程化乙')];
    const sat = { 前端工程化甲: 0, 前端工程化乙: 0 };
    // 甲没有需求证据 → 零供给按老规矩被当成风险扣分；乙有 → 零供给成为最优
    const demand = { 前端工程化乙: 1 };
    expect(coarseRank(pool, persona, sat, {}, demand)[0].title).toBe('前端工程化乙');
  });

  it('需求拉满 + 零供给 = 拿满分，与任何其它最优点持平（不加分也不留残余罚分）', () => {
    const pool = [cand('前端工程化甲'), cand('前端工程化乙')];
    // 甲坐在老最优点 0.5、无需求证据；乙零供给、需求拉满。两者的饱和度因子应当相等，
    // 于是排序由其余因子（此处完全相同）决定 —— 谁也压不过谁。
    const sat = { 前端工程化甲: 0.5, 前端工程化乙: 0 };
    const demand = { 前端工程化乙: 1 };
    const ranked = coarseRank(pool, persona, sat, {}, demand);
    expect(ranked.map((c) => c.title)).toEqual(['前端工程化甲', '前端工程化乙']); // 稳定排序，未反超
    // 反过来：把乙的需求证据拿掉，它就该掉到甲后面很远（这才是「原来的惩罚」）
    const noDemand = coarseRank(pool, persona, sat, {}, {});
    expect(noDemand[0].title).toBe('前端工程化甲');
  });

  it('红海候选不会因为需求强就被抬起来（供给挤满仍然降分）', () => {
    const pool = [cand('前端工程化甲'), cand('前端工程化乙')];
    const sat = { 前端工程化甲: 0.2, 前端工程化乙: 1.0 };
    const demand = { 前端工程化甲: 1, 前端工程化乙: 1 };
    expect(coarseRank(pool, persona, sat, {}, demand)[0].title).toBe('前端工程化甲');
  });
});

describe('blueSeaEvidence 措辞（会展示给用户，措辞即契约）', () => {
  it('只陈述观测到的事实，绝不说成「搜索需求量」', () => {
    const s = blueSeaEvidence({ hoursOnList: 30, sourceCount: 3, rivals: 0 })!;
    expect(s).toContain('已连续在榜约 30 小时');
    expect(s).toContain('在 3 个平台同时上榜');
    expect(s).toContain('还没人做同题');
    expect(s).not.toContain('搜索');
    expect(s).not.toContain('指数');
  });

  it('有同题竞对时如实报条数', () => {
    expect(blueSeaEvidence({ hoursOnList: 30, sourceCount: 1, rivals: 2 })).toContain('只有 2 条同题竞对作品');
  });

  it('证据不足（在榜不久且单平台）→ 不说话', () => {
    expect(blueSeaEvidence({ hoursOnList: 3, sourceCount: 1, rivals: 0 })).toBeNull();
  });
});

describe('blueSeaByTitle 批量', () => {
  const pool = [
    { title: '热榜话题', heat: 0.8, sourceType: 'douyin' },
    { title: '竞对作品', heat: 0.5, sourceType: 'competitor' },
  ] as Candidate[];

  it('只有拿得到需求证据的候选才有蓝海度，其余键缺席（不是 0）', () => {
    const r = blueSeaByTitle(pool, { 热榜话题: 0.9 }, { 热榜话题: 0.1 });
    expect(r['热榜话题']).toBeCloseTo(0.81);
    expect('竞对作品' in r).toBe(false);
  });

  it('需求为 0 的候选也不写键——「没有证据」和「算出来是 0」要能分开', () => {
    expect(blueSeaByTitle(pool, { 热榜话题: 0 }, {})).toEqual({});
  });
});

describe('徽标门槛', () => {
  it('定得足够高，避免满屏都是「蓝海」等于没有', () => {
    expect(BLUE_SEA_BADGE).toBeGreaterThanOrEqual(0.5);
    // 一个「在榜 24h、2 个平台、有 2 条同题竞对」的普通话题不该被标蓝海
    const ordinary = blueSeaScore(demandProxy({ hoursOnList: 24, sourceCount: 2 }), 0.4);
    expect(ordinary).toBeLessThan(BLUE_SEA_BADGE);
    // 而「在榜 40h、4 个平台、无人做」应该被标上
    const real = blueSeaScore(demandProxy({ hoursOnList: 40, sourceCount: 4 }), 0);
    expect(real).toBeGreaterThanOrEqual(BLUE_SEA_BADGE);
  });
});
