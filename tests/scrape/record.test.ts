import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { orderedBefore } from '../helpers/anchor';
import {
  sanitizeValues, vetChannel, MAX_VALUE_CHARS, MAX_VALUES_JSON_CHARS,
  SCRAPE_RECORD_RETENTION_DAYS,
} from '@/lib/scrape/record';

// 采集配方抓到的数，落库（2026-08-29）。
//
// 【这一层为什么必须有守卫，而且守的是「有没有存下来」】
// 在这批之前，两条采集路抓到的值都是原地丢掉的：
//   · lib/scrape/sweep.ts 只拿 values 数了个长度，用来判配方好没好；
//   · extension/sw.js 只 POST {kind:'result', ok:true}，values 连传都没传，
//     而 /api/ingest/recipe 也根本没有接收数据的通道。
// 也就是说「每 6 小时把配方跑一遍」实质是**配方健康检查**，不是采集——
// 用户以为数据在积累，库里一个字都没有。而这件事**不报错**：
// 定时任务绿的、界面写着「采集成功」、配方状态是 active。
//
// 所以下面每一条的形状都是「数据到底有没有走到该去的地方」，
// 而不是「源码里有没有出现某个函数名」。

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('values 收紧：客户端传的一律不信', () => {
  it('正常值原样收下', () => {
    expect(sanitizeValues({ f1: '标题', f2: '1234' })).toEqual({ f1: '标题', f2: '1234' });
  });

  it('key 必须是服务端生成的 f1..f12（它会进 JSON、进导出、进界面）', () => {
    expect(sanitizeValues({ 标题: 'x', 'f1': 'y', '__proto__': 'z', 'f999': 'w' })).toEqual({ f1: 'y' });
  });

  it('单值超长截断而不是打回整批（打回=用户只看到「格式不合法」）', () => {
    const v = sanitizeValues({ f1: 'x'.repeat(1000) });
    expect(v.f1.length).toBe(MAX_VALUE_CHARS);
  });

  it('整包超长时丢后面的字段，已收的照常落库', () => {
    const many: Record<string, string> = {};
    for (let i = 1; i <= 12; i += 1) many[`f${i}`] = 'x'.repeat(MAX_VALUE_CHARS);
    const out = sanitizeValues(many);
    expect(Object.keys(out).length).toBeGreaterThan(0);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(MAX_VALUES_JSON_CHARS + 200);
  });

  it('非字符串、数组、null 一律不收（不炸）', () => {
    expect(sanitizeValues(null)).toEqual({});
    expect(sanitizeValues(['a'])).toEqual({});
    expect(sanitizeValues({ f1: 123, f2: null, f3: { a: 1 } })).toEqual({});
  });

  it('通道名不认就退回 manual，不抛（一条采集不该因为通道名写错整条丢掉）', () => {
    expect(vetChannel('server')).toBe('server');
    expect(vetChannel('plugin_home')).toBe('plugin_home');
    expect(vetChannel('乱写')).toBe('manual');
    expect(vetChannel(undefined)).toBe('manual');
  });
});

describe('抓到的值必须走到库里（这一条是整批的理由）', () => {
  it('定时扫描：落库在判配方好坏之前', () => {
    const src = read('lib/scrape/sweep.ts');
    const save = src.indexOf('saveScrapeRecord(');
    const judge = src.indexOf('await recordScrapeResult(r.id, ws.id, fine)');
    expect(save, 'sweep 里没有落库').toBeGreaterThan(0);
    expect(judge).toBeGreaterThan(0);
    // 顺序不能反：判好坏那一步可能把配方标成 broken，但这次确实抓到东西了，数据该留下
    expect(save).toBeLessThan(judge);
  });

  it('定时扫描的运行摘要要印「入库 N 条」（只报「成功 N」会被读成采到了数据）', () => {
    expect(read('lib/jobs/handlers.ts')).toContain('入库 ${r.saved} 条');
  });

  it('AI / 页面那条路也落库', () => {
    expect(read('lib/agent/tools-local.ts')).toContain('saveScrapeRecord(');
  });

  it('插件真的把 values 传上来了（原来只传 ok:true）', () => {
    const sw = read('extension/sw.js');
    expect(sw).toContain("kind: 'data'");
    // 先落库再报结果，理由同上
    orderedBefore(sw, "kind: 'data'", "kind: 'result', recipeId: recipe.id, ok: true");
  });

  it('服务端有接收这条数据的通道', () => {
    expect(read('app/api/ingest/recipe/route.ts')).toContain("z.literal('data')");
  });

  it('插件传的网址要按配方 origin 复验，且是全等不是前缀', () => {
    const route = read('app/api/ingest/recipe/route.ts');
    // 前缀匹配会让 https://a.com 匹配上 https://a.com.evil.net
    expect(route).toContain('.origin === owned.origin');
    expect(route).not.toContain('startsWith(owned.origin)');
  });
});

describe('留存：任意站点的内容没预审过，所以存得少、存得短', () => {
  it('有硬留存期，且不长于平台数据那一档', () => {
    expect(SCRAPE_RECORD_RETENTION_DAYS).toBeLessThanOrEqual(90);
  });

  it('接进了每日到期清理（不接的话这张表只增不减）', () => {
    const r = read('lib/legal/retention.ts');
    expect(r).toContain('purgeExpiredScrapeRecords');
    expect(r).toContain('scrapeRecords');
  });

  it('清理结果要印出来（静默的合规清理和没有这个任务是一回事）', () => {
    expect(read('lib/jobs/handlers.ts')).toContain('采集记录 ${r.scrapeRecords}');
  });

  it('只存字段值，不存整页正文（正文只回给模型）', () => {
    // browseLocal 取到的 text 不许出现在落库那一段里
    const tools = read('lib/agent/tools-local.ts');
    const i = tools.indexOf('saveScrapeRecord({');
    const block = tools.slice(i, i + 400);
    expect(block).not.toContain('page.text');
  });
});

describe('加表清单：这个项目漏过的每一项都要在', () => {
  it('两份 schema 都有（漏一份 = 另一种形态上表不存在）', () => {
    expect(read('prisma/schema.prisma')).toContain('model ScrapeRecord');
    expect(read('prisma/schema.postgres.prisma')).toContain('model ScrapeRecord');
  });

  it('RLS 名单里有它（改完要重跑 02-rls.sql）', () => {
    expect(read('prisma/postgres/02-rls.sql')).toContain("'ScrapeRecord'");
  });

  it('有建表 SQL', () => {
    expect(read('prisma/postgres/40-scrape-record.sql')).toContain('CREATE TABLE IF NOT EXISTS beacon."ScrapeRecord"');
  });

  it('在数据导出里（PIPL 可携带权；只导配方不导数据=工具搬走、成果留下）', () => {
    expect(read('lib/account/export.ts')).toContain('prisma.scrapeRecord.findMany');
    expect(read('lib/account/export.ts')).toContain('scrapeRecords:');
  });
});

// ── 加了能力就得做界面（2026-08-29）─────────────────────────────────────
//
// 本项目在同一个会话里犯过三次「加了能力没做界面」（本机命令执行开关、CDP 端点、配方本身）。
// 落库这件事更甚：**用户没有任何办法知道库里是空的**——配方卡上写着「能用」，
// 定时任务绿着，而抓到的每一个值都被丢掉了。
describe('抓到的数在界面上看得见', () => {
  const list = read('app/(app)/skills/RecipeList.tsx');
  const page = read('app/(app)/skills/page.tsx');

  it('配方卡上印最近抓到的值', () => {
    expect(list).toContain('抓到：');
    expect(list).toContain('共 {r.total} 条');
  });

  it('一条都没有时明说，而不是留白（留白会被读成「还没到时候」）', () => {
    expect(list).toContain('还没存下过数据');
  });

  it('字段名要换回用户自己写的人话标签（f1/f2 他看不懂）', () => {
    expect(page).toContain('labels.find((f) => f.key === k)?.label');
  });

  it('「跑得通但没存下东西」要单独说破——那正是修复前的状态', () => {
    expect(list).toContain('配方是通的，但每次抓到的值都没留下来');
  });

  it('部分字段缺失要标出来（页面照常出数、只是少了几列，是最难发现的坏）', () => {
    expect(list).toContain('r.last.got < r.last.want');
  });
});
