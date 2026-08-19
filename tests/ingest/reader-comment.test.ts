import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { prisma } from '@/lib/db';
import { ingestReaderComments, purgeExpiredComments, commentTextHash } from '@/lib/ingest/reader-comments';
import { loadExemplars } from '@/lib/account-context';
import {
  COMMENT_TEXT_PURGE_DAYS, MAX_COMMENT_TEXT_LEN,
  MAX_READER_COMMENTS_PER_WORKSPACE, MIN_LEN,
} from '@/lib/comment-collect-rules';

// 读者原声（评论正文）入库。这张表存的是**第三方个人写下的内容**，
// 每一条护栏都是「能存它」的前提条件，不是可选的加固——所以逐条钉死。

const META = {
  scope: 'own' as const,
  platform: 'douyin',
  author: 'creator_a',
  accountId: null,
  workKey: 'v123',
  workTitle: '一条视频',
};

async function ws(): Promise<string> {
  const t = await prisma.tenant.create({ data: { name: 'rc-test' } });
  const w = await prisma.workspace.create({ data: { tenantId: t.id, name: 'w' } });
  return w.id;
}

beforeEach(async () => {
  await prisma.readerComment.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.tenant.deleteMany({ where: { name: 'rc-test' } });
});

afterAll(async () => {
  await prisma.readerComment.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.tenant.deleteMany({ where: { name: 'rc-test' } });
});

describe('入库四道闸（服务端必须自己再跑一遍——用户装的可能是旧版插件）', () => {
  it('正常评论逐条留存，不像提问那样要求 ≥2 人说过', async () => {
    const wsId = await ws();
    const r = await ingestReaderComments(wsId, META, [
      { text: '这个颜色也太好看了吧', kind: 'praise' },
      { text: '请问用的什么相机', kind: 'question' },
    ]);
    expect(r.stored).toBe(2);
    expect(await prisma.readerComment.count({ where: { workspaceId: wsId } })).toBe(2);
  });

  it('夹带个人信息的整条丢弃——不脱敏、不截断（留一半更危险）', async () => {
    const wsId = await ws();
    const r = await ingestReaderComments(wsId, META, [
      { text: '加我微信 zhang123456 详聊' },
      { text: '打我电话 13800138000' },
      { text: '正常的一条评论内容' },
    ]);
    expect(r.stored).toBe(1);
    const rows = await prisma.readerComment.findMany({ where: { workspaceId: wsId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe('正常的一条评论内容');
  });

  it('太短的不留（「哈哈」「+1」没有信息量，还常是表情残渣）', async () => {
    const wsId = await ws();
    const short = 'x'.repeat(MIN_LEN - 1);
    const r = await ingestReaderComments(wsId, META, [{ text: short }]);
    expect(r.stored).toBe(0);
  });

  it('未知 kind 落到 other，不让整批失败（旧版插件不传 kind）', async () => {
    const wsId = await ws();
    await ingestReaderComments(wsId, META, [
      { text: '没有分类的一条评论' },
      { text: '分类值是乱写的一条', kind: 'whatever' },
    ]);
    const rows = await prisma.readerComment.findMany({ where: { workspaceId: wsId } });
    expect(rows.map((r) => r.kind)).toEqual(['other', 'other']);
  });
});

describe('去重：同一条作品下同一句话只留一行', () => {
  it('重复采集是覆盖不是累加', async () => {
    const wsId = await ws();
    await ingestReaderComments(wsId, META, [{ text: '这个多少钱能买到' }]);
    await ingestReaderComments(wsId, META, [{ text: '这个多少钱能买到' }]);
    expect(await prisma.readerComment.count({ where: { workspaceId: wsId } })).toBe(1);
  });

  it('只差空格/标点的同一句话算同一条（不归一就会重复显示）', async () => {
    const wsId = await ws();
    const r = await ingestReaderComments(wsId, META, [
      { text: '这个多少钱能买到' },
      { text: '这个多少钱能买到？' },
      { text: '这个 多少钱 能买到' },
    ]);
    expect(r.stored).toBe(1);
    expect(commentTextHash('这个多少钱能买到？')).toBe(commentTextHash('这个 多少钱 能买到'));
  });

  it('不同作品下的同一句话是两条信号，各留各的', async () => {
    const wsId = await ws();
    await ingestReaderComments(wsId, META, [{ text: '这个多少钱能买到' }]);
    await ingestReaderComments(wsId, { ...META, workKey: 'v456' }, [{ text: '这个多少钱能买到' }]);
    expect(await prisma.readerComment.count({ where: { workspaceId: wsId } })).toBe(2);
  });
});

describe('保留期与配额（隐私政策里写死的两个数）', () => {
  it(`超过 ${COMMENT_TEXT_PURGE_DAYS} 天的正文被物理删除，不是归档`, async () => {
    const wsId = await ws();
    await ingestReaderComments(wsId, META, [{ text: '一条会过期的评论' }]);
    await prisma.readerComment.updateMany({
      where: { workspaceId: wsId },
      data: { collectedAt: new Date(Date.now() - (COMMENT_TEXT_PURGE_DAYS + 1) * 86_400_000) },
    });

    const purged = await purgeExpiredComments(wsId);
    expect(purged).toBe(1);
    // 「删」必须是真没了，不能只是标记——政策原文是「自动物理删除」
    expect(await prisma.readerComment.count({ where: { workspaceId: wsId } })).toBe(0);
  });

  it('保留期内的不动', async () => {
    const wsId = await ws();
    await ingestReaderComments(wsId, META, [{ text: '一条还没过期的评论' }]);
    await prisma.readerComment.updateMany({
      where: { workspaceId: wsId },
      data: { collectedAt: new Date(Date.now() - (COMMENT_TEXT_PURGE_DAYS - 1) * 86_400_000) },
    });
    expect(await purgeExpiredComments(wsId)).toBe(0);
    expect(await prisma.readerComment.count({ where: { workspaceId: wsId } })).toBe(1);
  });

  it('工作区配额封顶，超出删最旧的', async () => {
    const wsId = await ws();
    // 直接造到上限，省掉逐条入库的开销
    const old = new Date(Date.now() - 30 * 86_400_000);
    await prisma.readerComment.createMany({
      data: Array.from({ length: MAX_READER_COMMENTS_PER_WORKSPACE }, (_, i) => ({
        workspaceId: wsId, platform: 'douyin', scope: 'own', workKey: 'seed',
        text: `历史评论第 ${i} 条`, kind: 'other', textHash: `seed${i}`, collectedAt: old,
      })),
    });

    await ingestReaderComments(wsId, META, [{ text: '刚采到的一条新评论' }]);

    expect(await prisma.readerComment.count({ where: { workspaceId: wsId } }))
      .toBe(MAX_READER_COMMENTS_PER_WORKSPACE);
    // 被挤掉的是最旧的那条，新的留下
    expect(await prisma.readerComment.count({ where: { workspaceId: wsId, text: '刚采到的一条新评论' } })).toBe(1);
  });
});

describe('🔒 红线：评论正文绝不进生成语料池', () => {
  it('入库的读者原声不会出现在 loadExemplars 的原句样本里', async () => {
    const t = await prisma.tenant.create({ data: { name: 'rc-test' } });
    const w = await prisma.workspace.create({ data: { tenantId: t.id, name: 'w' } });
    const acc = await prisma.creatorAccount.create({
      data: { workspaceId: w.id, name: 'a', platform: 'douyin', personaCard: '{}', styleFingerprint: '{}' },
    });

    // 一条足够长、完全够格当"文风样本"的评论——正因为它够格，才必须靠红线挡住而不是靠长度挡住
    const juicy = '我上周照着你说的方法试了一遍，第一天没什么动静，第三天突然爆了，'
      + '所以到底是算法延迟还是我前面几条拖累了权重啊，能不能出一期讲讲这个'.repeat(2);
    await ingestReaderComments(w.id, { ...META, accountId: acc.id }, [{ text: juicy.slice(0, MAX_COMMENT_TEXT_LEN) }]);
    expect(await prisma.readerComment.count({ where: { workspaceId: w.id } })).toBe(1);

    const exemplars = await loadExemplars(acc.id, 'douyin');
    expect(exemplars).toEqual([]);

    await prisma.readerComment.deleteMany({ where: { workspaceId: w.id } });
    await prisma.creatorAccount.deleteMany({ where: { id: acc.id } });
    await prisma.workspace.deleteMany({ where: { id: w.id } });
    await prisma.tenant.deleteMany({ where: { id: t.id } });
  });
});
