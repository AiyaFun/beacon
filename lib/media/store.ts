import { prisma } from '../db';
import { encryptBytes, decryptBytes } from '../crypto';
import { LEGAL_VERSION } from '../legal';
import {
  LIBRARY_MAX_ASSETS,
  COVER_RETENTION_DAYS,
  COVER_MAX_PER_WORKSPACE,
  MAX_REFERENCE_BYTES,
} from '../cover/rules';

// MediaAsset 的读写口径（域14 · AI 封面）。所有对图片字节的存取都走这里，不要在别处直接
// `prisma.mediaAsset.create`——加密与否、配额、保留期这三件事分散到调用点就一定会漏一处。
//
// 两类资产，两套规矩：
//   · portrait / background / brand（用户上传的照片）：**加密**落库（人像属敏感个人信息），
//     每工作区 ≤ LIBRARY_MAX_ASSETS 张，保存到用户自己删或注销；
//   · cover（AI 生成的封面）：明文落库（它本来就要给用户下载/分享），
//     自动保留 COVER_RETENTION_DAYS 天 / 每工作区 COVER_MAX_PER_WORKSPACE 张，用户钉住的不清。

export type MediaKind = 'portrait' | 'background' | 'brand' | 'cover' | 'illustration';

export const LIBRARY_KINDS: MediaKind[] = ['portrait', 'background', 'brand'];

/**
 * AI 生成的图（封面 + 正文配图）。两者在存储上是同一类东西：明文落库、有保留期、有张数上限。
 *
 * ⚠️ 加了 illustration 却不把它写进这个常量，后果是**配图永远不被回收**——
 * 张数闸与到期清理都只认 kind='cover'，盘会一直涨到磁盘满（07-23 那次根盘满事故的同一种形状）。
 */
export const GENERATED_KINDS: MediaKind[] = ['cover', 'illustration'];

export type MediaAssetSummary = {
  id: string;
  kind: MediaKind;
  mime: string;
  size: number;
  label: string | null;
  pinned: boolean;
  draftId: string | null;
  createdAt: Date;
  meta: Record<string, unknown>;
  /** 前端取图的地址（永远走鉴权路由，不外链、不 base64 塞进 RSC 载荷） */
  url: string;
};

function parseMeta(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function mediaUrl(id: string): string {
  return `/api/media/${id}`;
}

function toSummary(row: {
  id: string; kind: string; mime: string; size: number; label: string | null;
  pinned: boolean; draftId: string | null; createdAt: Date; meta: string;
}): MediaAssetSummary {
  return {
    id: row.id,
    kind: row.kind as MediaKind,
    mime: row.mime,
    size: row.size,
    label: row.label,
    pinned: row.pinned,
    draftId: row.draftId,
    createdAt: row.createdAt,
    meta: parseMeta(row.meta),
    url: mediaUrl(row.id),
  };
}

const SUMMARY_SELECT = {
  id: true, kind: true, mime: true, size: true, label: true,
  pinned: true, draftId: true, createdAt: true, meta: true,
} as const;

export type SaveMediaInput = {
  workspaceId: string;
  accountId?: string | null;
  draftId?: string | null;
  kind: MediaKind;
  mime: string;
  bytes: Uint8Array;
  width?: number;
  height?: number;
  label?: string;
  meta?: Record<string, unknown>;
  /** 上传人像时勾选了「本人或已获单独同意」——落库时留痕（PIPL 单独同意的凭证） */
  consented?: boolean;
};

export type SaveMediaResult =
  | { ok: true; asset: MediaAssetSummary }
  | { ok: false; error: string };

/**
 * 存一张图。形象库类（portrait/background/brand）加密 + 过配额；cover 明文 + 顺手做保留期回收。
 */
export async function saveMediaAsset(input: SaveMediaInput): Promise<SaveMediaResult> {
  const isLibrary = LIBRARY_KINDS.includes(input.kind);
  if (input.bytes.length === 0) return { ok: false, error: '图片是空的' };
  if (input.bytes.length > MAX_REFERENCE_BYTES && isLibrary) {
    return { ok: false, error: `单张不能超过 ${MAX_REFERENCE_BYTES / 1024 / 1024}MB` };
  }
  if (isLibrary && input.kind === 'portrait' && !input.consented) {
    // 服务端重算：前端显示过勾选框不等于用户勾了
    return { ok: false, error: '存人像照片前需要确认：照片中的人物是你本人，或你已取得其单独同意' };
  }
  if (isLibrary) {
    const used = await prisma.mediaAsset.count({
      where: { workspaceId: input.workspaceId, kind: { in: LIBRARY_KINDS } },
    });
    if (used >= LIBRARY_MAX_ASSETS) {
      return { ok: false, error: `形象库最多存 ${LIBRARY_MAX_ASSETS} 张，先删掉几张不用的再存` };
    }
  }

  const stored = isLibrary ? encryptBytes(input.bytes) : input.bytes;
  const row = await prisma.mediaAsset.create({
    data: {
      workspaceId: input.workspaceId,
      accountId: input.accountId ?? null,
      draftId: input.draftId ?? null,
      kind: input.kind,
      mime: input.mime,
      data: Buffer.from(stored),
      encrypted: isLibrary,
      size: input.bytes.length,
      width: input.width ?? null,
      height: input.height ?? null,
      label: input.label?.slice(0, 60) ?? null,
      meta: JSON.stringify(input.meta ?? {}),
      consentAt: input.consented ? new Date() : null,
      consentVersion: input.consented ? LEGAL_VERSION : null,
    },
    select: SUMMARY_SELECT,
  });

  if (!isLibrary) await trimCovers(input.workspaceId);
  return { ok: true, asset: toSummary(row) };
}

/** 取字节（出图路由用）。解不开就抛——图片解不开是取不到，不能静默返回空图。 */
export async function readMediaBytes(
  workspaceId: string,
  id: string,
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const row = await prisma.mediaAsset.findFirst({
    where: { id, workspaceId },
    select: { data: true, mime: true, encrypted: true },
  });
  if (!row) return null;
  const raw = new Uint8Array(row.data);
  return { bytes: row.encrypted ? decryptBytes(raw) : raw, mime: row.mime };
}

/** 取一张的 data URI（生图时把形象库里的照片喂给模型用）。 */
export async function readMediaDataUri(workspaceId: string, id: string): Promise<string | null> {
  const r = await readMediaBytes(workspaceId, id);
  if (!r) return null;
  return `data:${r.mime};base64,${Buffer.from(r.bytes).toString('base64')}`;
}

export async function listLibrary(workspaceId: string, accountId?: string | null): Promise<MediaAssetSummary[]> {
  const rows = await prisma.mediaAsset.findMany({
    where: {
      workspaceId,
      kind: { in: LIBRARY_KINDS },
      // 形象库是工作区级的素材，但按账号分过的要能只看自己的：没绑账号的（共享）也一起给
      ...(accountId ? { OR: [{ accountId }, { accountId: null }] } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: LIBRARY_MAX_ASSETS,
    select: SUMMARY_SELECT,
  });
  return rows.map(toSummary);
}

export async function listDraftCovers(workspaceId: string, draftId: string, take = 12): Promise<MediaAssetSummary[]> {
  const rows = await prisma.mediaAsset.findMany({
    where: { workspaceId, draftId, kind: 'cover' },
    orderBy: { createdAt: 'desc' },
    take,
    select: SUMMARY_SELECT,
  });
  return rows.map(toSummary);
}

/** 某篇草稿的正文配图（与封面分开列：它们在界面上是两块，混在一起用户分不清哪张是封面）。 */
export async function listDraftIllustrations(workspaceId: string, draftId: string, take = 12): Promise<MediaAssetSummary[]> {
  const rows = await prisma.mediaAsset.findMany({
    where: { workspaceId, draftId, kind: 'illustration' },
    orderBy: { createdAt: 'desc' },
    take,
    select: SUMMARY_SELECT,
  });
  return rows.map(toSummary);
}

/**
 * 这个工作区最近生成的图（封面 + 配图，含不绑草稿的自由出图）。
 *
 * 出图工位（/images）要的就是这一份：按草稿列的两个函数在那儿用不了——
 * 自由出图根本没有 draftId，只按 draftId 查等于「刚出的图一张都看不见」。
 */
export async function listGenerated(
  workspaceId: string,
  opts: { take?: number; kind?: MediaKind } = {},
): Promise<MediaAssetSummary[]> {
  const rows = await prisma.mediaAsset.findMany({
    where: { workspaceId, kind: opts.kind ? opts.kind : { in: GENERATED_KINDS } },
    orderBy: { createdAt: 'desc' },
    take: opts.take ?? 24,
    select: SUMMARY_SELECT,
  });
  return rows.map(toSummary);
}

/** 每篇草稿有没有封面（一稿多平台家族列表用）。 */
export async function coverCountsByDraft(workspaceId: string, draftIds: string[]): Promise<Record<string, number>> {
  if (draftIds.length === 0) return {};
  const rows = await prisma.mediaAsset.groupBy({
    by: ['draftId'],
    where: { workspaceId, kind: 'cover', draftId: { in: draftIds } },
    _count: { _all: true },
  });
  const out: Record<string, number> = {};
  for (const r of rows) if (r.draftId) out[r.draftId] = r._count._all;
  return out;
}

export async function deleteMediaAsset(workspaceId: string, id: string): Promise<boolean> {
  const r = await prisma.mediaAsset.deleteMany({ where: { id, workspaceId } });
  // 有草稿把它选作封面的话，顺手把那个指向摘掉——留着就是一个查不到的 id
  if (r.count > 0) await prisma.draft.updateMany({ where: { coverAssetId: id }, data: { coverAssetId: null } });
  return r.count > 0;
}

export async function setMediaPinned(workspaceId: string, id: string, pinned: boolean): Promise<boolean> {
  const r = await prisma.mediaAsset.updateMany({ where: { id, workspaceId }, data: { pinned } });
  return r.count > 0;
}

/**
 * 封面的张数回收：每个工作区只自动留最近 COVER_MAX_PER_WORKSPACE 张，钉住的不算也不删。
 * 落一张就顺手回收一次——不靠定时任务兜底（定时任务没跑的那几天，盘照样在涨）。
 */
export async function trimCovers(workspaceId: string): Promise<number> {
  const keep = await prisma.mediaAsset.findMany({
    where: { workspaceId, kind: { in: GENERATED_KINDS }, pinned: false },
    orderBy: { createdAt: 'desc' },
    skip: COVER_MAX_PER_WORKSPACE,
    select: { id: true },
  });
  if (keep.length === 0) return 0;
  const ids = keep.map((k) => k.id);
  const r = await prisma.mediaAsset.deleteMany({ where: { id: { in: ids } } });
  await prisma.draft.updateMany({ where: { coverAssetId: { in: ids } }, data: { coverAssetId: null } });
  return r.count;
}

/**
 * 封面的到期清理（全库，给 sweepRetention 用）：满 COVER_RETENTION_DAYS 天的自动删，钉住的不删。
 * 形象库（portrait/background/brand）**不在这里清**——那是用户主动存的素材，
 * 保存到他自己删或注销，替他定个期限反而奇怪（政策文本就是这么写的）。
 */
export async function purgeExpiredCovers(): Promise<number> {
  const cutoff = new Date(Date.now() - COVER_RETENTION_DAYS * 86_400_000);
  const expired = await prisma.mediaAsset.findMany({
    where: { kind: { in: GENERATED_KINDS }, pinned: false, createdAt: { lt: cutoff } },
    select: { id: true },
    take: 5000,
  });
  if (expired.length === 0) return 0;
  const ids = expired.map((e) => e.id);
  const r = await prisma.mediaAsset.deleteMany({ where: { id: { in: ids } } });
  await prisma.draft.updateMany({ where: { coverAssetId: { in: ids } }, data: { coverAssetId: null } });
  return r.count;
}
