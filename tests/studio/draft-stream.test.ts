import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from '@/lib/db';
import { resolveDraftTarget, loadDraftContext, buildDraftMessages, persistDraftVersion } from '@/lib/studio/draft-core';

// 初稿流式出口。核心风险不是「流能不能跑」，而是**流式与非流式悄悄写出两套东西**：
// 两个入口各拼一次 prompt、各写一次落库，改了一边忘了另一边，没有任何测试会红，
// 用户却会发现两个按钮产出的风格不一样。所以这里锁的是「同一套内核」。

const session = { tenantId: '', workspaceId: '', accountId: '', memberId: '', role: 'owner' as const };

vi.mock('@/lib/session', () => ({
  getSessionOrNull: async () => (session.accountId ? session : null),
  getSession: async () => session,
}));

const streamChunks: string[] = [];
vi.mock('@/lib/llm/gateway', async (orig) => {
  const actual = await orig<typeof import('@/lib/llm/gateway')>();
  return {
    ...actual,
    llmCompleteStream: async () =>
      new ReadableStream<string>({
        start(c) {
          for (const chunk of streamChunks) c.enqueue(chunk);
          c.close();
        },
      }),
  };
});

const { POST } = await import('@/app/api/studio/draft/stream/route');

async function seed() {
  const tenant = await prisma.tenant.create({ data: { name: 't' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'w' } });
  const acc = await prisma.creatorAccount.create({
    data: { workspaceId: ws.id, name: 'a', platform: 'douyin', personaCard: JSON.stringify({ platforms: ['douyin'] }) },
  });
  Object.assign(session, { tenantId: tenant.id, workspaceId: ws.id, accountId: acc.id, memberId: 'm1' });
  return { tenantId: tenant.id, workspaceId: ws.id, accountId: acc.id };
}

async function readSse(res: Response): Promise<{ event: string; data: any }[]> {
  const text = await res.text();
  return text
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => {
      const ev = frame.split('\n').find((l) => l.startsWith('event: '))!.slice(7).trim();
      const data = frame.split('\n').find((l) => l.startsWith('data: '))!.slice(6);
      return { event: ev, data: JSON.parse(data) };
    });
}

beforeEach(async () => {
  streamChunks.length = 0;
  await prisma.draftVersion.deleteMany();
  await prisma.draft.deleteMany();
  await prisma.topicIdea.deleteMany();
  await prisma.memoryEntry.deleteMany();
  await prisma.creatorAccount.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.tenant.deleteMany();
});

describe('共享内核：定位草稿', () => {
  it('没有草稿也没有可用选题 → 如实报错，不凭空建一份空草稿', async () => {
    const { accountId } = await seed();
    const r = await resolveDraftTarget({ accountId, draftId: null });
    expect(r).toEqual({ ok: false, error: '没有可用选题，请先到选题中心采纳一个方向' });
    expect(await prisma.draft.count()).toBe(0);
  });

  it('有选题无草稿 → 建一份并把选题置为 drafting', async () => {
    const { accountId } = await seed();
    const topic = await prisma.topicIdea.create({
      data: { accountId, title: '选题A', angle: '角度A', state: 'accepted', sourceType: 'hot' },
    });
    const r = await resolveDraftTarget({ accountId, draftId: null });
    expect(r.ok).toBe(true);
    expect(await prisma.draft.count()).toBe(1);
    expect((await prisma.topicIdea.findUnique({ where: { id: topic.id } }))!.state).toBe('drafting');
  });

  it('指定了草稿就不新建（两个入口各调一次会凭空多出草稿，这条锁住只调一次的契约）', async () => {
    const { accountId } = await seed();
    const d = await prisma.draft.create({ data: { accountId, title: '已有稿', platform: 'douyin', status: 'editing' } });
    const r = await resolveDraftTarget({ accountId, draftId: d.id });
    expect(r.ok && r.target.draftId).toBe(d.id);
    expect(await prisma.draft.count()).toBe(1);
  });
});

describe('共享内核：prompt 与落库', () => {
  it('prompt 带上人设/账号上下文/AI 味禁令与选题', async () => {
    const { workspaceId, accountId } = await seed();
    await prisma.topicIdea.create({ data: { accountId, title: '选题A', angle: '角度A', state: 'accepted', sourceType: 'hot' } });
    const r = await resolveDraftTarget({ accountId, draftId: null });
    if (!r.ok) throw new Error(r.error);
    const ctx = await loadDraftContext({ workspaceId, accountId, target: r.target });
    const { messages, temperature } = buildDraftMessages(r.target, ctx);
    expect(temperature).toBe(0.8);
    expect(String(messages[0].content)).toContain('抖音');
    expect(String(messages[0].content)).toContain('只输出正文');
    expect(String(messages[1].content)).toContain('选题A');
    expect(String(messages[1].content)).toContain('角度A');
  });

  it('落库：版本号递增、作者记 ai、写一条偏好记忆', async () => {
    const { workspaceId, accountId } = await seed();
    const d = await prisma.draft.create({ data: { accountId, title: 'x', platform: 'douyin', status: 'editing' } });
    const first = await persistDraftVersion({ workspaceId, accountId, draftId: d.id, topicTitle: 'T', content: '正文1' });
    const second = await persistDraftVersion({ workspaceId, accountId, draftId: d.id, topicTitle: 'T', content: '正文2' });
    expect([first.seq, second.seq]).toEqual([1, 2]);
    const versions = await prisma.draftVersion.findMany({ where: { draftId: d.id }, orderBy: { seq: 'asc' } });
    expect(versions.map((v) => v.authorType)).toEqual(['ai', 'ai']);
    expect(await prisma.memoryEntry.count()).toBeGreaterThan(0);
  });
});

describe('流式路由', () => {
  it('增量推 delta，读完在服务端落库并回 done', async () => {
    const { accountId } = await seed();
    await prisma.topicIdea.create({ data: { accountId, title: '选题A', angle: '角度A', state: 'accepted', sourceType: 'hot' } });
    streamChunks.push('前半段', '后半段');

    const res = await POST(new Request('http://x/api/studio/draft/stream', { method: 'POST', body: JSON.stringify({}) }));
    const frames = await readSse(res);

    expect(frames[0].event).toBe('meta'); // 先给 draftId：新建草稿时前端要靠它知道落在哪份稿上
    expect(frames.filter((f) => f.event === 'delta').map((f) => f.data)).toEqual(['前半段', '后半段']);
    const done = frames.find((f) => f.event === 'done');
    expect(done?.data.seq).toBe(1);

    const version = await prisma.draftVersion.findFirst({ where: { draftId: done!.data.draftId } });
    expect(version?.content).toBe('前半段后半段'); // 落的是拼起来的全文，不是最后一片
    expect(version?.authorType).toBe('ai');
  });

  it('模型一个字都没吐 → 报错且不落一个空版本', async () => {
    const { accountId } = await seed();
    await prisma.topicIdea.create({ data: { accountId, title: '选题A', angle: '角度A', state: 'accepted', sourceType: 'hot' } });
    const res = await POST(new Request('http://x/api/studio/draft/stream', { method: 'POST', body: JSON.stringify({}) }));
    const frames = await readSse(res);
    expect(frames.find((f) => f.event === 'error')?.data.error).toContain('没返回内容');
    expect(await prisma.draftVersion.count()).toBe(0);
  });

  it('没登录 → 401（流式路由和 action 一样要自守卫）', async () => {
    session.accountId = '';
    const res = await POST(new Request('http://x/api/studio/draft/stream', { method: 'POST', body: '{}' }));
    expect(res.status).toBe(401);
  });

  it('反代缓冲会让流式退化成转圈 → 必须带 X-Accel-Buffering: no', async () => {
    const { accountId } = await seed();
    await prisma.topicIdea.create({ data: { accountId, title: '选题A', angle: '角度A', state: 'accepted', sourceType: 'hot' } });
    streamChunks.push('内容');
    const res = await POST(new Request('http://x/api/studio/draft/stream', { method: 'POST', body: '{}' }));
    expect(res.headers.get('X-Accel-Buffering')).toBe('no');
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
    await res.text();
  });
});

describe('静态守卫：不许出现第二份初稿 prompt', () => {
  it('actions.ts 不再自己拼初稿 system prompt（拼了就会与流式分叉）', () => {
    const src = readFileSync(join(process.cwd(), 'app', '(app)', 'studio', 'actions.ts'), 'utf8');
    // 指纹取「创作一篇初稿文案」——刻意不用更短的前缀：actCreateDraft 的「一句话想法」
    // prompt 开头几乎一样（…为「X」平台**把一个想法写成一篇初稿**），那是另一条链路，
    // 用短前缀会把它误伤成重复实现。
    expect(src).not.toContain('平台创作一篇初稿文案');
  });
});
