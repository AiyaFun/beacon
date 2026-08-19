import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import {
  saveMediaAsset,
  readMediaBytes,
  readMediaDataUri,
  listLibrary,
  listDraftCovers,
  coverCountsByDraft,
  deleteMediaAsset,
  setMediaPinned,
  trimCovers,
  purgeExpiredCovers,
} from '@/lib/media/store';
import { LIBRARY_MAX_ASSETS, COVER_MAX_PER_WORKSPACE, COVER_RETENTION_DAYS, MAX_REFERENCE_BYTES } from '@/lib/cover/rules';

// MediaAsset 的读写口径。要钉死的是四件「错了不报错、只会悄悄出事」的事：
//   ① 人像必须加密落库（拿到库文件的人不该直接看到用户的脸）；
//   ② 存人像没有单独同意 → 拒绝（服务端重算，不信前端）；
//   ③ 形象库配额与封面保留期是硬的（备份会把图片一起带走，07-23 的根盘满事故就是这么来的）；
//   ④ 删封面要顺手摘掉草稿上指向它的 coverAssetId，否则留一个查不到的 id。

const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

async function mkWorkspace() {
  const tenant = await prisma.tenant.create({ data: { name: 't' } });
  return prisma.workspace.create({ data: { tenantId: tenant.id, name: 'w' } });
}

beforeEach(async () => {
  await prisma.mediaAsset.deleteMany();
  await prisma.draft.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.tenant.deleteMany();
});

describe('saveMediaAsset · 加密与同意', () => {
  it('人像加密落库：库里的字节 ≠ 原文，读出来 = 原文', async () => {
    const w = await mkWorkspace();
    const r = await saveMediaAsset({ workspaceId: w.id, kind: 'portrait', mime: 'image/jpeg', bytes: BYTES, consented: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = await prisma.mediaAsset.findUnique({ where: { id: r.asset.id }, select: { data: true, encrypted: true, size: true } });
    expect(row!.encrypted).toBe(true);
    expect(Array.from(new Uint8Array(row!.data))).not.toEqual(Array.from(BYTES));
    expect(row!.size).toBe(BYTES.length); // size 记的是明文长度（配额按明文算）
    const back = await readMediaBytes(w.id, r.asset.id);
    expect(Array.from(back!.bytes)).toEqual(Array.from(BYTES));
    expect(back!.mime).toBe('image/jpeg');
  });

  it('封面明文落库（本来就要给用户下载/分享）', async () => {
    const w = await mkWorkspace();
    const r = await saveMediaAsset({ workspaceId: w.id, kind: 'cover', mime: 'image/png', bytes: BYTES });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = await prisma.mediaAsset.findUnique({ where: { id: r.asset.id }, select: { data: true, encrypted: true } });
    expect(row!.encrypted).toBe(false);
    expect(Array.from(new Uint8Array(row!.data))).toEqual(Array.from(BYTES));
  });

  it('🔒 存人像没有单独同意 → 拒绝，并且什么都没落库', async () => {
    const w = await mkWorkspace();
    const r = await saveMediaAsset({ workspaceId: w.id, kind: 'portrait', mime: 'image/jpeg', bytes: BYTES });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('同意');
    expect(await prisma.mediaAsset.count()).toBe(0);
  });

  it('同意落库时记下时间与政策版本（PIPL 单独同意的留痕）', async () => {
    const w = await mkWorkspace();
    const r = await saveMediaAsset({ workspaceId: w.id, kind: 'portrait', mime: 'image/jpeg', bytes: BYTES, consented: true });
    if (!r.ok) return;
    const row = await prisma.mediaAsset.findUnique({ where: { id: r.asset.id }, select: { consentAt: true, consentVersion: true } });
    expect(row!.consentAt).toBeInstanceOf(Date);
    expect(row!.consentVersion).toBeTruthy();
  });

  it('跨工作区读不到（人像是敏感个人信息，能猜 id 就取图等于公开）', async () => {
    const a = await mkWorkspace();
    const b = await mkWorkspace();
    const r = await saveMediaAsset({ workspaceId: a.id, kind: 'cover', mime: 'image/png', bytes: BYTES });
    if (!r.ok) return;
    expect(await readMediaBytes(b.id, r.asset.id)).toBeNull();
    expect(await readMediaDataUri(b.id, r.asset.id)).toBeNull();
  });
});

describe('配额与保留期', () => {
  it(`🔒 形象库满 ${LIBRARY_MAX_ASSETS} 张 → 拒绝再存`, async () => {
    const w = await mkWorkspace();
    for (let i = 0; i < LIBRARY_MAX_ASSETS; i++) {
      const r = await saveMediaAsset({ workspaceId: w.id, kind: 'background', mime: 'image/jpeg', bytes: BYTES });
      expect(r.ok).toBe(true);
    }
    const over = await saveMediaAsset({ workspaceId: w.id, kind: 'background', mime: 'image/jpeg', bytes: BYTES });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toContain(String(LIBRARY_MAX_ASSETS));
    expect(await prisma.mediaAsset.count({ where: { workspaceId: w.id } })).toBe(LIBRARY_MAX_ASSETS);
  });

  it('🔒 形象库单张超上限 → 拒绝', async () => {
    const w = await mkWorkspace();
    const big = new Uint8Array(MAX_REFERENCE_BYTES + 1);
    const r = await saveMediaAsset({ workspaceId: w.id, kind: 'brand', mime: 'image/png', bytes: big });
    expect(r.ok).toBe(false);
  });

  it(`🔒 封面超过 ${COVER_MAX_PER_WORKSPACE} 张 → 落一张就回收最旧的（钉住的不动）`, async () => {
    const w = await mkWorkspace();
    // 先塞满并把第一张钉住
    const first = await saveMediaAsset({ workspaceId: w.id, kind: 'cover', mime: 'image/png', bytes: BYTES });
    if (!first.ok) return;
    await setMediaPinned(w.id, first.asset.id, true);
    // 把 createdAt 拨老，保证它是"最旧的那张"
    await prisma.mediaAsset.update({ where: { id: first.asset.id }, data: { createdAt: new Date(Date.now() - 86_400_000) } });
    for (let i = 0; i < COVER_MAX_PER_WORKSPACE + 3; i++) {
      await saveMediaAsset({ workspaceId: w.id, kind: 'cover', mime: 'image/png', bytes: BYTES });
    }
    const total = await prisma.mediaAsset.count({ where: { workspaceId: w.id, kind: 'cover' } });
    // 未钉住的被压到上限，钉住的那张仍在
    expect(total).toBe(COVER_MAX_PER_WORKSPACE + 1);
    expect(await prisma.mediaAsset.findUnique({ where: { id: first.asset.id } })).not.toBeNull();
  });

  it(`🔒 满 ${COVER_RETENTION_DAYS} 天的封面被清；钉住的与形象库不清`, async () => {
    const w = await mkWorkspace();
    const old = await saveMediaAsset({ workspaceId: w.id, kind: 'cover', mime: 'image/png', bytes: BYTES });
    const pinned = await saveMediaAsset({ workspaceId: w.id, kind: 'cover', mime: 'image/png', bytes: BYTES });
    const portrait = await saveMediaAsset({ workspaceId: w.id, kind: 'portrait', mime: 'image/jpeg', bytes: BYTES, consented: true });
    if (!old.ok || !pinned.ok || !portrait.ok) return;
    await setMediaPinned(w.id, pinned.asset.id, true);
    const longAgo = new Date(Date.now() - (COVER_RETENTION_DAYS + 1) * 86_400_000);
    await prisma.mediaAsset.updateMany({ where: { workspaceId: w.id }, data: { createdAt: longAgo } });

    const n = await purgeExpiredCovers();
    expect(n).toBe(1);
    expect(await prisma.mediaAsset.findUnique({ where: { id: old.asset.id } })).toBeNull();
    expect(await prisma.mediaAsset.findUnique({ where: { id: pinned.asset.id } })).not.toBeNull();
    // 形象库是用户主动存的素材，保留到他自己删——不进这条清理
    expect(await prisma.mediaAsset.findUnique({ where: { id: portrait.asset.id } })).not.toBeNull();
  });

  it('trimCovers 只动本工作区（别把别人的封面清了）', async () => {
    const a = await mkWorkspace();
    const b = await mkWorkspace();
    for (let i = 0; i < 3; i++) await saveMediaAsset({ workspaceId: b.id, kind: 'cover', mime: 'image/png', bytes: BYTES });
    await trimCovers(a.id);
    expect(await prisma.mediaAsset.count({ where: { workspaceId: b.id } })).toBe(3);
  });
});

describe('列表与删除', () => {
  it('本稿封面按草稿查；家族计数按草稿分组', async () => {
    const w = await mkWorkspace();
    const acc = await prisma.creatorAccount.create({ data: { workspaceId: w.id, name: 'a', platform: 'xiaohongshu' } });
    const d1 = await prisma.draft.create({ data: { accountId: acc.id, title: 'x', platform: 'xiaohongshu' } });
    const d2 = await prisma.draft.create({ data: { accountId: acc.id, title: 'y', platform: 'douyin' } });
    await saveMediaAsset({ workspaceId: w.id, kind: 'cover', mime: 'image/png', bytes: BYTES, draftId: d1.id });
    await saveMediaAsset({ workspaceId: w.id, kind: 'cover', mime: 'image/png', bytes: BYTES, draftId: d1.id });
    const covers = await listDraftCovers(w.id, d1.id);
    expect(covers).toHaveLength(2);
    expect(covers[0].url).toBe(`/api/media/${covers[0].id}`);
    const counts = await coverCountsByDraft(w.id, [d1.id, d2.id]);
    expect(counts[d1.id]).toBe(2);
    expect(counts[d2.id]).toBeUndefined(); // 没出过封面的不出现在计数里（"未出"是缺席不是 0）
  });

  it('形象库只列形象类，不把封面混进来', async () => {
    const w = await mkWorkspace();
    await saveMediaAsset({ workspaceId: w.id, kind: 'portrait', mime: 'image/jpeg', bytes: BYTES, consented: true });
    await saveMediaAsset({ workspaceId: w.id, kind: 'cover', mime: 'image/png', bytes: BYTES });
    const lib = await listLibrary(w.id);
    expect(lib).toHaveLength(1);
    expect(lib[0].kind).toBe('portrait');
  });

  it('🔒 删封面时顺手摘掉草稿上的 coverAssetId（否则留一个查不到的 id）', async () => {
    const w = await mkWorkspace();
    const acc = await prisma.creatorAccount.create({ data: { workspaceId: w.id, name: 'a', platform: 'xiaohongshu' } });
    const d = await prisma.draft.create({ data: { accountId: acc.id, title: 'x', platform: 'xiaohongshu' } });
    const r = await saveMediaAsset({ workspaceId: w.id, kind: 'cover', mime: 'image/png', bytes: BYTES, draftId: d.id });
    if (!r.ok) return;
    await prisma.draft.update({ where: { id: d.id }, data: { coverAssetId: r.asset.id } });
    expect(await deleteMediaAsset(w.id, r.asset.id)).toBe(true);
    const after = await prisma.draft.findUnique({ where: { id: d.id }, select: { coverAssetId: true } });
    expect(after!.coverAssetId).toBeNull();
  });

  it('删别人工作区的资产删不掉', async () => {
    const a = await mkWorkspace();
    const b = await mkWorkspace();
    const r = await saveMediaAsset({ workspaceId: a.id, kind: 'cover', mime: 'image/png', bytes: BYTES });
    if (!r.ok) return;
    expect(await deleteMediaAsset(b.id, r.asset.id)).toBe(false);
    expect(await prisma.mediaAsset.count()).toBe(1);
  });

  it('工作区删除时资产随外键 Cascade 一起走（注销链路靠它）', async () => {
    const w = await mkWorkspace();
    await saveMediaAsset({ workspaceId: w.id, kind: 'cover', mime: 'image/png', bytes: BYTES });
    await prisma.workspace.delete({ where: { id: w.id } });
    expect(await prisma.mediaAsset.count()).toBe(0);
  });
});
