import { z } from 'zod';
import { safeFetch } from '../web/fetch';
import { createLogger } from '../logger';
import { compareVersion } from './pack';

const log = createLogger({ module: 'market-catalog' });

// ── 官方市场目录 ────────────────────────────────────────────────────────────
//
// 【为什么是一个静态 JSON 而不是一套后台】市场的第一版只要回答一个问题：
// 「有哪些现成的东西可以装」。一个静态目录 + 一个包地址就够了，而且它有两个
// 别的做法给不了的好处：
//   · **整机版也能用**。客户那台 Mac mini 连的是自己的服务端，但目录可以指向官网——
//     否则整机版装完就是一个永远长不出新东西的离线快照。
//   · **发布不需要发版**。加一个技能就是往目录里加一条，不用等产品发版。
//
// 【为什么每条要带 sha256】目录是静态文件，托管在 CDN 上。有了摘要，
// 客户端至少能确认「拿到的包和目录里登记的是同一个」——
// 这不是完整的信任链（那要签名），但能挡住「包被替换了而目录没变」这一类。
// 界面上必须照实说：**作者署名不是认证**。

const CATALOG_URL = process.env.BEACON_MARKET_URL || 'https://beacon.iyunci.cn/market/index.json';

/** 目录里的一条。刻意只放**展示与定位**需要的字段，包体本身在 url 那边。 */
const entrySchema = z.object({
  kind: z.enum(['skill', 'workflow', 'persona']),
  slug: z.string().min(1).max(64),
  name: z.string().min(1).max(40),
  description: z.string().max(200).default(''),
  emoji: z.string().max(4).default('🧩'),
  version: z.string().max(20),
  author: z.string().max(40).default(''),
  platform: z.string().max(30).default('generic'),
  /** 包体地址。装的时候去这儿取，并按 beaconPack 严格校验 */
  url: z.string().url(),
  /** 包体摘要，可选。有就核一下 */
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  minAppVersion: z.string().max(20).optional(),
});

const catalogSchema = z.object({
  beaconMarket: z.literal(1),
  updatedAt: z.string().max(40).optional(),
  entries: z.array(entrySchema).max(500),
});

export type MarketEntry = z.infer<typeof entrySchema>;

export type CatalogResult =
  | { ok: true; entries: MarketEntry[]; updatedAt?: string }
  | { ok: false; error: string };

/**
 * 拉官方目录。
 *
 * 失败**不抛**：市场拉不到不该让「技能中心」整页打不开——
 * 用户自己建的、已经装好的那些技能与市场没有任何关系。
 */
export async function fetchCatalog(): Promise<CatalogResult> {
  try {
    const page = await safeFetch(CATALOG_URL);
    const parsed = catalogSchema.safeParse(JSON.parse(page.text));
    if (!parsed.success) {
      return { ok: false, error: '市场目录格式不对（可能是这一版还不认识它，升级一下试试）' };
    }
    return { ok: true, entries: parsed.data.entries, updatedAt: parsed.data.updatedAt };
  } catch (err) {
    log.info('拉市场目录失败', { url: CATALOG_URL, error: (err as Error).message });
    return { ok: false, error: '连不上市场（不影响你已经装好的技能）' };
  }
}

/**
 * 把目录与「本地已装的」对起来，算出每条的状态。
 *
 * 三态：没装 / 已是最新 / 有新版本。**「有新版本」要显式算出来**，
 * 让界面直接渲染——在界面里现比版本，迟早比出个「1.10 比 1.9 旧」。
 */
export type EntryState = 'not_installed' | 'installed' | 'update_available';

export function markInstalled(
  entries: MarketEntry[],
  installed: { slug: string; version: string }[],
): (MarketEntry & { state: EntryState; installedVersion?: string })[] {
  // 本地存的 slug 带 mkt- 前缀（与用户自建的 custom- 区分），比对时剥掉
  const local = new Map(installed.map((s) => [s.slug.replace(/^mkt-/, ''), s.version]));
  return entries.map((e) => {
    const cur = local.get(e.slug);
    if (!cur) return { ...e, state: 'not_installed' as const };
    return compareVersion(e.version, cur) > 0
      ? { ...e, state: 'update_available' as const, installedVersion: cur }
      : { ...e, state: 'installed' as const, installedVersion: cur };
  });
}
