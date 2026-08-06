import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import {
  ownAccountIngestSchema,
  ingestOwnAccountData,
  followerSeries,
  readAudience,
  topBuckets,
  resolveDefaultAccountId,
} from '@/lib/ingest/own-account';

// 账号级自有数据（粉丝曲线 + 受众画像）。这些放不进 PublishRecord.metrics：
// 粉丝数不属于任何一篇作品，受众画像是账号属性且变化很慢。故单开两张表。
//
// 锁的重点：
//   1. 逻辑日去重——同账号同平台同一天只能有一条，重复回填是常态（用户可能天天点）；
//   2. **掉粉不许被粉饰**——净增允许为负；
//   3. 合并式更新——这次没抓到的维度不许清空上次抓到的。

let accountId = '';
let workspaceId = '';

beforeEach(async () => {
  await prisma.audienceProfile.deleteMany();
  await prisma.accountDailyStat.deleteMany();
  await prisma.creatorAccount.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.tenant.deleteMany();
  const t = await prisma.tenant.create({ data: { name: 'acc' } });
  const ws = await prisma.workspace.create({ data: { tenantId: t.id, name: 'w' } });
  workspaceId = ws.id;
  const a = await prisma.creatorAccount.create({ data: { workspaceId: ws.id, name: 'a', platform: 'multi' } });
  accountId = a.id;
});

const parse = (payload: unknown) => ownAccountIngestSchema.parse(payload);

describe('形状校验', () => {
  it('未知平台被挡下', () => {
    expect(ownAccountIngestSchema.safeParse({ platform: 'nosuch' }).success).toBe(false);
  });

  it('🔒 date 只认 YYYY-MM-DD —— 收 ISO 时间戳会因时区把同一天落成两条', () => {
    expect(
      ownAccountIngestSchema.safeParse({
        platform: 'douyin',
        dailyStats: [{ date: '2026-07-22T00:00:00Z', followers: 100 }],
      }).success,
    ).toBe(false);
    expect(
      ownAccountIngestSchema.safeParse({ platform: 'douyin', dailyStats: [{ date: '2026-07-22', followers: 100 }] })
        .success,
    ).toBe(true);
  });

  it('🔒 净增允许为负 —— 掉粉是真实信号，钳成 0 等于粉饰数据', () => {
    const r = parse({ platform: 'douyin', dailyStats: [{ date: '2026-07-22', followerDelta: -320 }] });
    expect(r.dailyStats?.[0].followerDelta).toBe(-320);
  });

  it('粉丝总数不接受负值（那是脏数据，不是信号）', () => {
    expect(
      ownAccountIngestSchema.safeParse({ platform: 'douyin', dailyStats: [{ date: '2026-07-22', followers: -5 }] })
        .success,
    ).toBe(false);
  });
});

describe('粉丝每日数据', () => {
  it('按日入库，重复回填走 upsert 不堆重复行', async () => {
    await ingestOwnAccountData(accountId, parse({
      platform: 'douyin',
      dailyStats: [
        { date: '2026-07-20', followers: 1000, followerDelta: 30 },
        { date: '2026-07-21', followers: 1050, followerDelta: 50 },
      ],
    }));
    await ingestOwnAccountData(accountId, parse({
      platform: 'douyin',
      dailyStats: [{ date: '2026-07-21', followers: 1060, followerDelta: 60 }], // 同一天再回填一次
    }));

    const rows = await prisma.accountDailyStat.findMany({ where: { accountId }, orderBy: { date: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows[1].followers).toBe(1060); // 更新而不是新增
  });

  it('合并式更新：本次没抓到的字段不覆盖已有值', async () => {
    await ingestOwnAccountData(accountId, parse({
      platform: 'douyin',
      dailyStats: [{ date: '2026-07-21', followers: 1050, views: 90000 }],
    }));
    await ingestOwnAccountData(accountId, parse({
      platform: 'douyin',
      dailyStats: [{ date: '2026-07-21', followerDelta: 50 }], // 只抓到净增
    }));
    const row = await prisma.accountDailyStat.findFirstOrThrow({ where: { accountId } });
    expect(row.followerDelta).toBe(50);
    expect(row.followers).toBe(1050); // 没被抹掉
    expect(row.views).toBe(90000);
  });

  it('分平台隔离：同一天两个平台各一条，不互相覆盖', async () => {
    await ingestOwnAccountData(accountId, parse({ platform: 'douyin', dailyStats: [{ date: '2026-07-21', followers: 1000 }] }));
    await ingestOwnAccountData(accountId, parse({ platform: 'xiaohongshu', dailyStats: [{ date: '2026-07-21', followers: 500 }] }));
    expect(await prisma.accountDailyStat.count({ where: { accountId } })).toBe(2);
    expect((await followerSeries(accountId, 'douyin'))[0].followers).toBe(1000);
    expect((await followerSeries(accountId, 'xiaohongshu'))[0].followers).toBe(500);
  });

  it('一个数都没有的日期不建行（后台空行不该变成数据）', async () => {
    const r = await ingestOwnAccountData(accountId, parse({ platform: 'douyin', dailyStats: [{ date: '2026-07-21' }] }));
    expect(r.dailyStats).toBe(0);
    expect(await prisma.accountDailyStat.count()).toBe(0);
  });

  it('followerSeries 按日升序返回，且**不补齐缺失日期**', async () => {
    await ingestOwnAccountData(accountId, parse({
      platform: 'douyin',
      dailyStats: [
        { date: '2026-07-25', followers: 1200 },
        { date: '2026-07-20', followers: 1000 }, // 中间 21-24 没数据
      ],
    }));
    const s = await followerSeries(accountId, 'douyin');
    // 只有 2 个点，不是 6 个——插值会让「你多久回填一次」看起来像增长节奏
    expect(s.map((p) => p.date)).toEqual(['2026-07-20', '2026-07-25']);
  });
});

describe('受众画像', () => {
  it('四个维度入库，占比归一到 0-1', async () => {
    await ingestOwnAccountData(accountId, parse({
      platform: 'douyin',
      audience: { gender: { 男: 42, 女: 58 }, age: { '24-30': 0.45, '31-40': 0.3 } },
    }));
    const a = await readAudience(accountId, 'douyin');
    expect(a?.gender).toEqual({ 男: 0.42, 女: 0.58 });
    expect(a?.age).toEqual({ '24-30': 0.45, '31-40': 0.3 });
  });

  it('🔒 逐维度合并：这次只抓到性别，不该把上次抓到的地域清空', async () => {
    await ingestOwnAccountData(accountId, parse({ platform: 'douyin', audience: { region: { 广东: 0.2 } } }));
    await ingestOwnAccountData(accountId, parse({ platform: 'douyin', audience: { gender: { 男: 0.4, 女: 0.6 } } }));
    const a = await readAudience(accountId, 'douyin');
    expect(a?.region).toEqual({ 广东: 0.2 });
    expect(a?.gender).toEqual({ 男: 0.4, 女: 0.6 });
  });

  it('四个维度全空 → 不写空档案覆盖已有的', async () => {
    await ingestOwnAccountData(accountId, parse({ platform: 'douyin', audience: { gender: { 男: 0.4 } } }));
    const r = await ingestOwnAccountData(accountId, parse({ platform: 'douyin', audience: { gender: {} } }));
    expect(r.audience).toBe(false);
    expect((await readAudience(accountId, 'douyin'))?.gender).toEqual({ 男: 0.4 });
  });

  it('脏占比（>100）被丢弃，其余照收', async () => {
    await ingestOwnAccountData(accountId, parse({ platform: 'douyin', audience: { gender: { 男: 250, 女: 58 } } }));
    expect((await readAudience(accountId, 'douyin'))?.gender).toEqual({ 女: 0.58 });
  });

  it('没有画像 → 返回 null（调用方据此走退化形态）', async () => {
    expect(await readAudience(accountId, 'douyin')).toBeNull();
  });
});

describe('topBuckets', () => {
  it('按占比降序取前 N，过滤 0', () => {
    expect(topBuckets({ a: 0.1, b: 0.5, c: 0, d: 0.3 }, 2)).toEqual([
      { name: 'b', share: 0.5 },
      { name: 'd', share: 0.3 },
    ]);
  });
});

describe('归属', () => {
  it('归到最早的活跃账号', async () => {
    expect(await resolveDefaultAccountId(workspaceId)).toBe(accountId);
  });
  it('工作区没有账号 → null（调用方回 404）', async () => {
    const t = await prisma.tenant.create({ data: { name: 'empty' } });
    const ws = await prisma.workspace.create({ data: { tenantId: t.id, name: 'w2' } });
    expect(await resolveDefaultAccountId(ws.id)).toBeNull();
  });
});
