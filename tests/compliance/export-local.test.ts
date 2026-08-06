import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { readZipEntries } from '@/lib/deliverable/zip';
import { AIGC_LABEL } from '@/lib/compliance/aigc';

// 没有 Claude 渠道时的导出链路（本地渲染）。
// 与 export-chain.test.ts 互补：那份验的是「有 Key → 走 Anthropic Agent Skills」这条路，
// 这份验的是**默认路径**——两种格式都不需要任何大模型 Key，且照样过 AIGC 标识校验回环。
//
// 断言里最重要的一条是「一次 fetch 都没发生」：本地渲染一旦悄悄退回海外通道，
// 合规上就是内容出境（PRD §10.5），而功能测试是发现不了的——只有盯住网络出口才发现得了。

const session = { memberId: 'm1', tenantId: 't1', workspaceId: 'w1', accountId: 'a1', memberName: '张三', role: 'owner', plan: 'pro' };
vi.mock('@/lib/session', () => ({ getSession: async () => session, getSessionOrNull: async () => session }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

let fetchCalls: string[] = [];
beforeAll(() => {
  vi.stubGlobal('fetch', async (url: string) => {
    fetchCalls.push(String(url));
    throw new Error(`本地导出路径不该联网：${url}`);
  });
});

beforeEach(() => {
  // 本文件专测「没有 Claude Key」，而 @next/env 会在 import server action 时把 .env 灌回来
  delete process.env.BEACON_ANTHROPIC_API_KEY;
  fetchCalls = [];
});

async function mkDraft(content: string, title = '三种做图方式对比') {
  await prisma.tenant.upsert({ where: { id: 't1' }, create: { id: 't1', name: '测试租户', plan: 'pro' }, update: {} });
  await prisma.workspace.upsert({ where: { id: 'w1' }, create: { id: 'w1', tenantId: 't1', name: '主工作区' }, update: {} });
  await prisma.creatorAccount.upsert({ where: { id: 'a1' }, create: { id: 'a1', workspaceId: 'w1', name: '测试账号', platform: 'douyin' }, update: {} });
  const d = await prisma.draft.create({ data: { accountId: 'a1', title, platform: 'douyin', status: 'editing' } });
  await prisma.draftVersion.create({ data: { draftId: d.id, seq: 1, authorType: 'ai', content } });
  return d.id;
}

const STRUCTURED = [
  '## 成本',
  '- AI 生成最便宜',
  '- 外包最贵',
  '## 可控性',
  '- 模板最稳',
  '## 结论',
  '- 混着用',
].join('\n');

describe('无 Claude Key 的导出（默认路径）', () => {
  it('演示文稿：本地渲染成功，标识经真校验，且全程零联网', async () => {
    const { actExportDeliverable } = await import('@/app/(app)/studio/actions');
    const id = await mkDraft(STRUCTURED);
    const r = await actExportDeliverable(id, 'pptx');
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.labelVerified).toBe(true);
    expect(r.filename).toBe('三种做图方式对比.pptx');
    expect(fetchCalls, '本地导出不该有任何出网请求').toEqual([]);

    const buf = Buffer.from(r.dataBase64!, 'base64');
    const entries = readZipEntries(buf);
    expect(entries.map((e) => e.name)).toContain('ppt/presentation.xml');
    // 稿子自带 3 个二级标题 → 封面 + 3 页
    expect(entries.filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))).toHaveLength(4);
    // 隐式标识（第五条）带上了内容编号
    const props = entries.find((e) => e.name === 'docProps/custom.xml')!.data.toString('utf8');
    expect(props).toContain(`t1-${id}`);
  });

  it('Word：同样零 Key 零联网，标识真校验通过', async () => {
    const { actExportDeliverable } = await import('@/app/(app)/studio/actions');
    const id = await mkDraft('讲讲做图方式。', 'Word 稿');
    const r = await actExportDeliverable(id, 'docx');
    expect(r.ok).toBe(true);
    expect(r.labelVerified).toBe(true);
    expect(r.filename).toBe('Word 稿.docx');
    expect(fetchCalls).toEqual([]);
    const text = readZipEntries(Buffer.from(r.dataBase64!, 'base64'))
      .find((e) => e.name === 'word/document.xml')!
      .data.toString('utf8');
    expect(text).toContain(AIGC_LABEL);
  });

  it('图文卡：排版在服务端算好，标识每张都有，零联网', async () => {
    const { actExportCards } = await import('@/app/(app)/studio/actions');
    const id = await mkDraft(STRUCTURED);
    const r = await actExportCards(id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 四套模板一次全排出来（切模板在客户端完成，不再调模型）
    expect(Object.keys(r.byTheme).sort()).toEqual(['magazine', 'night', 'note', 'plain']);
    for (const cards of Object.values(r.byTheme)) {
      expect(cards.length).toBeGreaterThanOrEqual(3); // 封面 + 三个小节
      for (const c of cards) {
        expect(c.w).toBe(1080);
        expect(c.h).toBe(1440);
        const texts = c.ops.filter((o) => o.kind === 'text').map((o) => (o as { text: string }).text);
        expect(texts, '这张卡没有 AIGC 显式标识').toContain(AIGC_LABEL);
      }
    }
    // 隐式标识载荷跟着一起下发（客户端出图后写进 PNG 的 iTXt 分块）
    expect(r.aigcMetadata).toContain(`t1-${id}`);
    expect(fetchCalls).toEqual([]);
  });

  it('图文卡：viewer 不能导出（与文件导出同一道 RBAC）', async () => {
    const { actExportCards } = await import('@/app/(app)/studio/actions');
    const id = await mkDraft(STRUCTURED);
    session.role = 'viewer';
    await expect(actExportCards(id)).rejects.toThrow('权限不足');
    session.role = 'owner';
  });

  it('红线硬闸仍在本地路径上生效（不能因为换了渲染器就绕过合规）', async () => {
    await prisma.sensitiveWord.create({
      data: { word: '国家级', tier: 'legal', action: 'block', suggestion: '（专业级）', category: 'x', enabled: true },
    });
    const { actExportDeliverable, actExportCards } = await import('@/app/(app)/studio/actions');
    const id = await mkDraft('本产品是国家级方案。');
    const r = await actExportDeliverable(id, 'pptx');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('国家级');
    // 图文卡是另一条出口，闸门必须各挂各的——少挂一条就是一个能绕过合规的导出口
    const c = await actExportCards(id);
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.error).toContain('国家级');
  });
});
