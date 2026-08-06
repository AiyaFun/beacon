import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { toJson, parseJson, type Metrics } from '@/lib/json';
import { ownPostIngestSchema, ingestOwnPostData } from '@/lib/ingest/own-post';
import { diagnose } from '@/lib/algorithm/coach';

// 完播率/完读率走通自有作品回填通道。
//
// 这个文件的存在理由：completion 是 lib/algorithm/coach.ts 里抖音/公众号/B站/YouTube/视频号的
// **第一信号**，而公开作品页拿不到它——只有创作者后台有。此前这条通道的 METRIC_KEYS 里
// 根本没有 completion，插件就算读到也被静默丢掉，于是「个性化诊断」永远只能说样本不足。
//
// 锁两件事：
//   1. completion 是**率**不是计数——绝不能走 Math.floor（0.42 取整成 0 = 静默丢数据）；
//   2. 收进来的值真的能让 coach 给出完播率结论（端到端，不只是字段存进去了）。

let workspaceId: string;
let accountId: string;

beforeEach(async () => {
  await prisma.performanceSnapshot.deleteMany();
  await prisma.publishRecord.deleteMany();
  await prisma.creatorAccount.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.tenant.deleteMany();
  const tenant = await prisma.tenant.create({ data: { name: 't-completion' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'w', ingestToken: 'bcn_c' } });
  workspaceId = ws.id;
  const acc = await prisma.creatorAccount.create({ data: { workspaceId, name: 'a', platform: 'multi' } });
  accountId = acc.id;
});

const parseOne = (metrics: Record<string, unknown>) =>
  ownPostIngestSchema.parse({ platform: 'douyin', posts: [{ platformItemId: '7123456789012345678', metrics }] })
    .posts[0].metrics;

describe('completion 解析 · 率不是计数', () => {
  it('🔒 0-1 的比率原样保留，不被取整抹成 0', () => {
    expect(parseOne({ views: 1000, completion: 0.42 })?.completion).toBe(0.42);
  });

  it('0-100 的百分数自动折算', () => {
    expect(parseOne({ views: 1000, completion: 42.3 })?.completion).toBe(0.423);
    expect(parseOne({ views: 1000, completion: 100 })?.completion).toBe(1);
  });

  it('超出 100 → 判脏数据丢弃（宁可不要，也不要一个假的第一信号）', () => {
    expect(parseOne({ views: 1000, completion: 250 })?.completion).toBeUndefined();
  });

  it('0 / 负数 / 非数字 一律丢弃', () => {
    for (const bad of [0, -1, 'abc', null, undefined]) {
      expect(parseOne({ views: 1000, completion: bad })?.completion).toBeUndefined();
    }
  });

  it('不影响计数型指标照常取整', () => {
    const m = parseOne({ views: 1000.9, likes: 30.2, completion: 0.5 });
    expect(m).toMatchObject({ views: 1000, likes: 30, completion: 0.5 });
  });
});

describe('completion 入库 · 与既有指标合并', () => {
  it('后台回填的完播率写进记录，且不冲掉已有的计数指标', async () => {
    const rec = await prisma.publishRecord.create({
      data: { accountId, platform: 'douyin', platformItemId: '7123456789012345678', needsBackfill: false, metrics: toJson({ views: 900, likes: 40 }) },
    });
    const payload = ownPostIngestSchema.parse({
      platform: 'douyin',
      posts: [{ platformItemId: '7123456789012345678', metrics: { views: 1000, completion: 0.55 } }],
    });
    const r = await ingestOwnPostData(workspaceId, payload);
    expect(r.ok && r.updated).toBe(1);

    const after = parseJson<Metrics>((await prisma.publishRecord.findUnique({ where: { id: rec.id } }))!.metrics, {});
    expect(after.completion).toBe(0.55);
    expect(after.views).toBe(1000);
    expect(after.likes).toBe(40); // 本次没抓到，合并保留
  });

  it('只抓到完播率（一个计数都没有）也算有效数据，不被当空记录跳过', async () => {
    const payload = ownPostIngestSchema.parse({
      platform: 'douyin',
      posts: [{ platformItemId: '7999999999999999999', metrics: { completion: 0.6 } }],
    });
    const r = await ingestOwnPostData(workspaceId, payload);
    expect(r.ok && r.created).toBe(1);
    expect(r.ok && r.skipped).toBe(0);
  });
});

describe('端到端 · 有了完播率，coach 才给得出第一信号结论', () => {
  const withCompletion = (c: number) =>
    Array.from({ length: 3 }, () => ({ views: 10000, likes: 300, comments: 20, shares: 50, completion: c }));

  it('公开页拿不到完播率时 → 诊断里没有完播率这条（诚实缺席，不编）', () => {
    const noCompletion = Array.from({ length: 3 }, () => ({ views: 10000, likes: 300, comments: 20, shares: 50 }));
    expect(diagnose('douyin', noCompletion).map((d) => d.signal)).not.toContain('完播率');
  });

  it('后台回填完播率后 → 抖音给出完播率结论', () => {
    const low = diagnose('douyin', withCompletion(0.2)).find((d) => d.signal === '完播率');
    expect(low?.severity).toBe('bad');
    const ok = diagnose('douyin', withCompletion(0.55)).find((d) => d.signal === '完播率');
    expect(ok?.severity).toBe('good');
  });

  it('公众号侧同理：完读率是它的第一信号', () => {
    const d = diagnose('wechat', withCompletion(0.3)).find((x) => x.signal === '阅读完成率');
    expect(d?.severity).toBe('bad');
  });
});
