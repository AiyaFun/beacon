import { z } from 'zod';
import { prisma } from '../db';
import { toJson, parseJson } from '../json';
import { PLATFORMS } from '../constants';
import { recordCollectionRun } from './collection-run';

// 账号级自有数据回填（粉丝曲线 + 受众画像）。
//
// 与 own-post.ts 并行的另一半：那边是**作品级**（每篇的播放/点赞/完播），
// 这边是**账号级**（每日粉丝数/净增、受众性别年龄地域）。两者都来自同一个创作者后台，
// 走同一个 /api/ingest/self 端点、同一个令牌——刻意不新开端点：
// 语义完全一致（「我自己的数据，我本人登录态下读的」），拆开只会多一套令牌与 CORS 配置。
//
// 为什么账号级数据放不进 PublishRecord.metrics：
//   · 粉丝数不属于任何一篇作品，挂到某篇上是错的；
//   · 受众画像是账号属性，且变化很慢（周级），跟着每篇存会存出一堆几乎一样的副本。
// 所以单开了 AccountDailyStat / AudienceProfile 两张表。

// 占比型字段（受众画像各维度）：{分组名: 占比}。与 Metrics.sources 同一形态与同一套清洗规则。
const MAX_BUCKETS = 20;

function readRate(raw: unknown): number | undefined {
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) return undefined;
  if (v > 100) return undefined;
  const rate = v > 1 ? v / 100 : v;
  return Math.min(1, Math.round(rate * 10000) / 10000);
}

function readBuckets(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const name = String(k).trim().slice(0, 20);
    if (!name) continue;
    const rate = readRate(v);
    if (rate === undefined) continue;
    out[name] = rate;
    if (Object.keys(out).length >= MAX_BUCKETS) break;
  }
  return out;
}

// YYYY-MM-DD。**只认这个形态**：逻辑日不是时刻，接受 ISO 时间戳会因时区把同一天落成两条，
// @@unique([accountId, platform, date]) 就形同虚设。认不出直接丢，不猜。
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const dailyStatSchema = z.object({
  date: z.string().refine((d) => DATE_RE.test(d), { message: 'date 必须是 YYYY-MM-DD' }),
  // 粉丝数与播放是非负计数；净增**允许为负**——掉粉是真实信号，钳成 0 等于粉饰数据
  followers: z.number().int().min(0).max(2_000_000_000).optional(),
  followerDelta: z.number().int().min(-2_000_000_000).max(2_000_000_000).optional(),
  views: z.number().int().min(0).max(2_000_000_000).optional(),
  interactions: z.number().int().min(0).max(2_000_000_000).optional(),
});

const audienceSchema = z.object({
  gender: z.unknown().optional(),
  age: z.unknown().optional(),
  region: z.unknown().optional(),
  interest: z.unknown().optional(),
});

export const ownAccountIngestSchema = z.object({
  platform: z.string().refine((p) => p in PLATFORMS, { message: '未知平台' }),
  // 插件里绑定的账号（与 own-post.ts 同一个字段、同一套校验）
  accountId: z.string().max(64).optional(),
  dailyStats: z.array(dailyStatSchema).max(90).optional(), // 后台通常给近 7/30/90 天
  audience: audienceSchema.optional(),
});

export type OwnAccountPayload = z.infer<typeof ownAccountIngestSchema>;

export type OwnAccountResult = {
  dailyStats: number;
  audience: boolean;
};

/**
 * 入库账号级数据。归属到本工作区的默认（最早活跃）账号——与 own-post.ts 同一条归属规则。
 * 按 (accountId, platform, date) upsert：重复回填是常态（用户可能天天点），不能堆历史垃圾。
 */
export async function ingestOwnAccountData(
  accountId: string,
  payload: OwnAccountPayload,
): Promise<OwnAccountResult> {
  let statCount = 0;
  for (const st of payload.dailyStats ?? []) {
    // 一个数都没有的日期不建行（后台某些天没数据时会渲染空行）
    if (st.followers == null && st.followerDelta == null && st.views == null && st.interactions == null) continue;
    const data = {
      followers: st.followers ?? null,
      followerDelta: st.followerDelta ?? null,
      views: st.views ?? null,
      interactions: st.interactions ?? null,
      source: 'plugin',
    };
    await prisma.accountDailyStat.upsert({
      where: { accountId_platform_date: { accountId, platform: payload.platform, date: st.date } },
      create: { accountId, platform: payload.platform, date: st.date, ...data },
      // 合并式更新：本次没抓到的字段不覆盖已有值（与 own-post 的 applyMetrics 同一原则）
      update: Object.fromEntries(Object.entries(data).filter(([, v]) => v !== null)),
    });
    statCount++;
  }

  let audienceWritten = false;
  if (payload.audience) {
    const gender = readBuckets(payload.audience.gender);
    const age = readBuckets(payload.audience.age);
    const region = readBuckets(payload.audience.region);
    const interest = readBuckets(payload.audience.interest);
    // 四个维度全空 = 没抓到画像，不要写一份空档案覆盖掉上次抓到的
    if (Object.keys(gender).length || Object.keys(age).length || Object.keys(region).length || Object.keys(interest).length) {
      const prev = await prisma.audienceProfile.findUnique({
        where: { accountId_platform: { accountId, platform: payload.platform } },
      });
      // 逐维度合并：这次只抓到性别，不该把上次抓到的地域清空
      const merged = {
        gender: Object.keys(gender).length ? toJson(gender) : (prev?.gender ?? '{}'),
        age: Object.keys(age).length ? toJson(age) : (prev?.age ?? '{}'),
        region: Object.keys(region).length ? toJson(region) : (prev?.region ?? '{}'),
        interest: Object.keys(interest).length ? toJson(interest) : (prev?.interest ?? '{}'),
        source: 'plugin',
      };
      await prisma.audienceProfile.upsert({
        where: { accountId_platform: { accountId, platform: payload.platform } },
        create: { accountId, platform: payload.platform, ...merged },
        update: merged,
      });
      audienceWritten = true;
    }
  }

  // 台账：账号级数据的「时间段」是显式的——后台给的就是逐日行，覆盖区间即这批日期的首尾。
  // 只有 dailyStats 有时间维度；画像是一张当下的切片，没有区间，单独抓到时只记条数不记区间。
  // 逻辑日 → 时刻，**显式按 UTC 零点**：不带 Z 会按运行环境的本地时区解析，
  // 本机（+8）与生产容器（UTC）得到的存量值会差 8 小时，跨机器对账时首尾日直接错一天。
  const dates = (payload.dailyStats ?? []).map((st) => new Date(`${st.date}T00:00:00Z`));
  if (statCount > 0 || audienceWritten) {
    const acc = await prisma.creatorAccount.findUnique({
      where: { id: accountId },
      select: { workspaceId: true, name: true },
    });
    if (acc) {
      await recordCollectionRun({
        workspaceId: acc.workspaceId,
        scope: 'self',
        platform: payload.platform,
        targetId: accountId,
        targetName: acc.name,
        channel: 'plugin_backend', // 粉丝曲线/受众画像只有创作者后台给得到
        dates,
        items: statCount,
        created: statCount,
        note: audienceWritten ? (statCount > 0 ? '含受众画像' : '仅受众画像（无时间区间）') : null,
      });
    }
  }

  return { dailyStats: statCount, audience: audienceWritten };
}

/**
 * 账号级数据的归属。**插件里绑定了账号就只认它**（与 own-post.ts 同一条规则、同一个理由：
 * 一个工作区经营两个同平台号时，「猜最早活跃的那个」必然错一半，而错了要到数据看板上才发现）；
 * 没绑定才退回默认（最早活跃）账号。
 * 工作区一个账号都没有、或绑定的账号不在本工作区时返回 null，由调用方回 404。
 */
export async function resolveDefaultAccountId(workspaceId: string, boundAccountId?: string): Promise<string | null> {
  const accounts = await prisma.creatorAccount.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, status: true },
  });
  if (accounts.length === 0) return null;
  if (boundAccountId) return accounts.find((a) => a.id === boundAccountId)?.id ?? null;
  return (accounts.find((a) => a.status === 'active') ?? accounts[0]).id;
}

// ─────────────────────────── 读取层（纯函数友好）───────────────────────────

export type FollowerPoint = { date: string; followers: number | null; delta: number | null };

/**
 * 粉丝增长序列。**不插值、不补齐缺失日期**——后台没给的那天就是没数据，
 * 画成连续曲线会让「你多久回填一次」看起来像「粉丝怎么涨的」。
 */
export async function followerSeries(accountId: string, platform: string, limit = 90): Promise<FollowerPoint[]> {
  const rows = await prisma.accountDailyStat.findMany({
    where: { accountId, platform },
    orderBy: { date: 'desc' },
    take: limit,
    select: { date: true, followers: true, followerDelta: true },
  });
  return rows
    .reverse()
    .map((r) => ({ date: r.date, followers: r.followers, delta: r.followerDelta }));
}

export type AudienceBuckets = {
  gender: Record<string, number>;
  age: Record<string, number>;
  region: Record<string, number>;
  interest: Record<string, number>;
  updatedAt: Date | null;
};

export async function readAudience(accountId: string, platform: string): Promise<AudienceBuckets | null> {
  const p = await prisma.audienceProfile.findUnique({
    where: { accountId_platform: { accountId, platform } },
  });
  if (!p) return null;
  return {
    gender: parseJson<Record<string, number>>(p.gender, {}),
    age: parseJson<Record<string, number>>(p.age, {}),
    region: parseJson<Record<string, number>>(p.region, {}),
    interest: parseJson<Record<string, number>>(p.interest, {}),
    updatedAt: p.updatedAt,
  };
}

/** 取占比最高的 N 项，供 UI 与 prompt 注入共用（占比降序，过滤 0）。 */
export function topBuckets(b: Record<string, number>, n = 3): { name: string; share: number }[] {
  return Object.entries(b)
    .filter(([, v]) => v > 0)
    .sort((a, b2) => b2[1] - a[1])
    .slice(0, n)
    .map(([name, share]) => ({ name, share }));
}
