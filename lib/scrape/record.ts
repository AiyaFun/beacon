// 采集配方抓到的数，落库（2026-08-29）。
//
// ── 在这之前，抓到的值是原地丢掉的 ──
// · 定时扫描 lib/scrape/sweep.ts 只拿 `page.values` 数了个 `Object.keys().length`，
//   用来判「配方还能不能用」，然后就丢；
// · 插件 extension/sw.js 更彻底——POST 里只有 `{kind:'result', ok:true}`，
//   **values 连传都没传**，服务端的 /api/ingest/recipe 也根本没有接收数据的通道。
//
// 于是「每 6 小时把配方跑一遍」实质是**配方健康检查**，不是采集。
// 用户以为数据在积累，库里一个字都没有——这条路上最贵的一个误解，而且完全不报错。
//
// ── 留存必须有硬上限，理由和别处不同 ──
// 平台数据是**按平台预先审过**的（五条通道分级、去标识化、移除申请）。
// 任意站点没法预审：用户指哪儿抓哪儿。所以这里的取舍是**存得少、存得短**：
//   · 只存 `fields` 声明过的那几个字段值，不存整页正文（正文只回给模型，不落库）
//   · 单值 200 字符（pick() 里已经截过，这里再夹一次——客户端可改，一律不信）
//   · 整行 values 有总上限，超了丢字段而不是丢整行（截断不打回）
//   · 90 天到期物理删除，与读者原声同档（见 lib/legal/retention.ts）
import { prisma } from '../db';
import { toJson } from '../json';
import { createLogger } from '../logger';

const log = createLogger({ module: 'scrape-record' });

/** 单个字段值的上限。与插件 pick()、CDP 侧 PICK_FN 的 `.slice(0,200)` 同一个数。 */
export const MAX_VALUE_CHARS = 200;

/**
 * 一行 values 的 JSON 总上限。
 * 配方最多 12 个字段 × 200 字符，正常远低于此；这道闸挡的是被改过的客户端。
 */
export const MAX_VALUES_JSON_CHARS = 4_000;

/** 留存天数。任意站点的内容没有预审过，所以比平台数据更该短。与读者原声同档。 */
export const SCRAPE_RECORD_RETENTION_DAYS = 90;

/** 一条记录最多存几行。与既有翻页采集的服务端硬上限同一个数（超一条整批被打回那个 50）。 */
export const MAX_ROWS = 50;
/** 行数据 JSON 的总上限。50 行 × 12 字段 × 200 字符理论上是 120KB，不夹一道会把库撑坏。 */
export const MAX_ROWS_JSON_CHARS = 32_000;

/**
 * 收紧列表行。每一行都过 sanitizeValues（同一套 key 白名单与长度闸），
 * 空行丢掉——一行一个字段都没取到，说明行容器指错了，收进来只会让条数变成假象。
 */
export function sanitizeRows(raw: unknown): Record<string, string>[] {
  if (!Array.isArray(raw)) return [];
  const out: Record<string, string>[] = [];
  let budget = MAX_ROWS_JSON_CHARS;
  for (const item of raw.slice(0, MAX_ROWS)) {
    const row = sanitizeValues(item);
    if (Object.keys(row).length === 0) continue;
    const size = JSON.stringify(row).length + 1;
    if (size > budget) break; // 预算用完就停，已收的那些照常落库（截断不打回）
    budget -= size;
    out.push(row);
  }
  return out;
}

/** 采集通道。与 CollectionRun 的通道词表同名同义，便于将来对齐。 */
export type ScrapeChannel = 'server' | 'plugin_home' | 'manual';

const CHANNELS: ScrapeChannel[] = ['server', 'plugin_home', 'manual'];

/** 通道名不认就退回 'manual'，不抛——一条采集不该因为通道名写错而整条丢掉。 */
export function vetChannel(raw: unknown): ScrapeChannel {
  const s = String(raw ?? '');
  return (CHANNELS as string[]).includes(s) ? (s as ScrapeChannel) : 'manual';
}

/**
 * 把客户端传来的 values 收紧到能落库的形状。
 *
 * 【为什么超长是丢字段而不是打回整批】展示用的长文本超长就该截断；打回整批的结果是
 * 用户只看到「数据格式不合法」，而他其实抓到了 11 个字段里的 10 个
 *（截断不打回，本项目既有原则）。
 */
export function sanitizeValues(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  let budget = MAX_VALUES_JSON_CHARS;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'string' || !v) continue;
    // key 由服务端生成（f1..f12），客户端传别的一律不收：它会进 JSON、进导出、进界面
    if (!/^f\d{1,2}$/.test(k)) continue;
    const val = v.slice(0, MAX_VALUE_CHARS);
    if (val.length + k.length + 6 > budget) break; // 预算用完就停，已收的那些照常落库
    budget -= val.length + k.length + 6;
    out[k] = val;
  }
  return out;
}

export type SaveScrapeInput = {
  tenantId: string;
  workspaceId: string;
  recipeId: string;
  url: string;
  values: unknown;
  want: number;
  channel: ScrapeChannel;
  capturedAt?: Date;
  /** 列表行（可选）。有行就算抓到了，哪怕页面级标量一个都没取到 */
  rows?: unknown;
};

/**
 * 落一条采集记录。
 *
 * 【为什么一个值都没取到时不写】那不是一次采集，是一次失败——它已经由
 * recordScrapeResult 记进 failCount 了。写进来只会让「抓到过什么」这张表里
 * 混进一堆空行，而那正是用户要翻的表。
 *
 * 【为什么同值也写】与增长快照同一条口径（那次专门推翻过「同值不写」）：
 * 同值不写会让「这个数一直没变」和「这段时间根本没采」在数据上长得一模一样，
 * 而这两件事的处置完全相反。
 *
 * 【绝不抛】落库失败不该连累正在跑的采集——与 CollectionRun 台账同一条理由。
 */
export async function saveScrapeRecord(
  input: SaveScrapeInput,
): Promise<{ saved: boolean; got: number; rows: number }> {
  const values = sanitizeValues(input.values);
  const rows = sanitizeRows(input.rows);
  const got = Object.keys(values).length;
  // 【有行就算抓到了】列表页很常见的情形是：页面级标量一个都没有（没有「总数」这种东西），
  // 但列表本身满满当当。只看 values 会把这种成功判成失败，然后拿去重学。
  if (got === 0 && rows.length === 0) return { saved: false, got: 0, rows: 0 };

  try {
    await prisma.scrapeRecord.create({
      data: {
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        recipeId: input.recipeId,
        url: input.url.slice(0, 500),
        values: toJson(values),
        rows: toJson(rows),
        rowCount: rows.length,
        got,
        want: Math.max(input.want, got),
        // 【运行时再过一道】类型上 channel 已经是 ScrapeChannel，但这是**唯一**
        // 从插件通道进来的字段之一（route 里写死的那个值将来可能被改成透传）。
        // vetChannel 写了却没人调，就是这个项目反复栽的「写了没接」——接上它才算数
        channel: vetChannel(input.channel),
        capturedAt: input.capturedAt ?? new Date(),
      },
    });
    return { saved: true, got, rows: rows.length };
  } catch (e) {
    // 【不抛，但一定要留声】静默吞掉写失败，就分不清「没东西可存」与「每一条都存失败了」——
    // 而这正是本轮开头修的那个缺陷的形状（用户以为数据在积累，库里什么都没有）。
    // 项目里旁路写入的既有约定就是记一条 warn（见 lib/ingest/collection-run.ts）。
    log.warn('采集记录写入失败（不影响本次抓取）', { error: (e as Error).message, recipeId: input.recipeId });
    return { saved: false, got, rows: rows.length };
  }
}

/** 到期清理。由 lib/legal/retention.ts 的每日 sweep 调用。 */
export async function purgeExpiredScrapeRecords(now = Date.now()): Promise<number> {
  const cutoff = new Date(now - SCRAPE_RECORD_RETENTION_DAYS * 86_400_000);
  const r = await prisma.scrapeRecord.deleteMany({ where: { capturedAt: { lt: cutoff } } });
  return r.count;
}
