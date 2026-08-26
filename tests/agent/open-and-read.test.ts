import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '@/lib/db';

// 「让插件替我打开一个网页并读回正文」这条链路。
//
// 它是唯一一件**读哪一页由服务端决定**的动作，所以闸最多，也最该被钉死：
//   ① 工作区开关默认关，没开就不许派；
//   ② 网址必须在白名单里（服务端这道只是早失败，插件端那份才是防线）；
//   ③ 读回来的正文进 resultData，给模型的只有摘要——直接回全文会在 6000 字处静默截断；
//   ④ 抽取那步降级/Mock 时不许拿示例内容冒充摘要。

const h = vi.hoisted(() => ({ llm: { text: '{"title":"标题","summary":"一句话摘要","points":["要点"]}', mocked: false } }));

vi.mock('@/lib/llm/gateway', () => ({
  llmComplete: async () => ({ text: h.llm.text, provider: 's', model: 's', mocked: h.llm.mocked }),
}));

const { toolByName } = await import('@/lib/agent/tools');
const { acceptReadResult } = await import('@/lib/browser-task/read-result');
const { browserTaskPayloadSchema } = await import('@/lib/browser-task/kinds');

let ctx: { tenantId: string; workspaceId: string; accountId: string; memberId: string; role: string };

beforeEach(async () => {
  h.llm = { text: '{"title":"标题","summary":"一句话摘要","points":["要点"]}', mocked: false };
  await prisma.browserTask.deleteMany();
  await prisma.ingestToken.deleteMany();

  const tenant = await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'W' } });
  const account = await prisma.creatorAccount.create({
    data: { workspaceId: ws.id, name: '我的号', platform: 'douyin', personaCard: '{}' },
  });
  const member = await prisma.member.create({ data: { tenantId: tenant.id, name: '张三', role: 'owner' } });
  ctx = { tenantId: tenant.id, workspaceId: ws.id, accountId: account.id, memberId: member.id, role: 'owner' };
  // 派活的前提：这个工作区得有能干活的浏览器
  await prisma.ingestToken.create({
    data: { workspaceId: ws.id, token: `bcn_${Math.random().toString(36).slice(2)}`, label: '测试设备', memberId: member.id },
  });
});

const dispatch = (args: Record<string, unknown>) => toolByName('dispatch_browser_task')!.run(ctx, args);
const openRead = async () => {
  await prisma.workspace.update({ where: { id: ctx.workspaceId }, data: { browserReadEnabled: true } });
};

describe('默认关：没开这个开关就派不出去', () => {
  it('开关是关的时候当场拒绝，并告诉用户去哪开', async () => {
    const r = await dispatch({ kind: 'open_and_read', url: 'https://www.douyin.com/video/1' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('采集助手');
    expect(await prisma.browserTask.count(), '拒绝了就不该留下一条任务').toBe(0);
  });

  it('开了之后才排得出去', async () => {
    await openRead();
    const r = await dispatch({ kind: 'open_and_read', url: 'https://www.douyin.com/video/1' });
    expect(r.ok).toBe(true);
    expect(await prisma.browserTask.count()).toBe(1);
  });
});

describe('白名单：服务端这道是早失败，插件端那份才是防线', () => {
  beforeEach(openRead);

  it('清单外的网址排不出去，且把清单告诉模型', async () => {
    const r = await dispatch({ kind: 'open_and_read', url: 'https://evil.example.com/x' });
    expect(r.ok).toBe(false);
    // 给的是域名而不是「抖音」这类中文名：模型手上的是一个 URL，
    // 拿域名对照才判断得了，中文名还要它自己再翻译一次
    expect(r.error, '要告诉模型有哪些能读，否则它只会反复试').toContain('www.douyin.com');
    expect(r.error, '要指出别的网址该走哪条路').toContain('clip_url');
    expect(await prisma.browserTask.count()).toBe(0);
  });

  it('后缀冒充（www.douyin.com.evil.com）挡得住', async () => {
    const r = await dispatch({ kind: 'open_and_read', url: 'https://www.douyin.com.evil.com/x' });
    expect(r.ok).toBe(false);
    expect(await prisma.browserTask.count()).toBe(0);
  });

  it('payload schema 自己也拦一道（绕过工具直接建任务同样不行）', () => {
    const bad = browserTaskPayloadSchema.safeParse({ kind: 'open_and_read', url: 'https://evil.example.com/x' });
    expect(bad.success, 'schema 层放行了 = 任何绕过工具的路径都能派任意网址').toBe(false);
    const good = browserTaskPayloadSchema.safeParse({ kind: 'open_and_read', url: 'https://www.zhihu.com/question/1' });
    expect(good.success).toBe(true);
  });
});

describe('回执：正文进 resultData，给模型的只有摘要', () => {
  let taskId: string;
  beforeEach(async () => {
    await openRead();
    await dispatch({ kind: 'open_and_read', url: 'https://www.zhihu.com/question/1' });
    taskId = (await prisma.browserTask.findFirstOrThrow()).id;
  });

  it('正文落进 resultData，回给模型的是摘要', async () => {
    const r = await acceptReadResult(taskId, { workspaceId: ctx.workspaceId, tenantId: ctx.tenantId }, {
      url: 'https://www.zhihu.com/question/1',
      finalUrl: 'https://www.zhihu.com/question/1',
      title: '一个问题',
      text: '正文内容'.repeat(200),
    });

    expect(r.stored).toBe(true);
    expect(r.summary, '给模型的应该是摘要，不是整篇').toContain('一句话摘要');
    // 全文直接当工具结果回灌会在 6000 字处被静默截断——模型看到半句话还以为那是全部
    expect(r.summary.length).toBeLessThan(600);

    const row = await prisma.browserTask.findUniqueOrThrow({ where: { id: taskId } });
    const data = JSON.parse(row.resultData!) as { text: string; extract: { summary: string } | null };
    expect(data.text.length, '正文要完整存下来').toBeGreaterThan(500);
    expect(data.extract?.summary).toBe('一句话摘要');
  });

  it('超长正文截断不打回（打回整批用户只会看到「格式不合法」）', async () => {
    const { MAX_READ_TEXT_CHARS } = await import('@/lib/browser-task/kinds');
    const r = await acceptReadResult(taskId, { workspaceId: ctx.workspaceId, tenantId: ctx.tenantId }, {
      url: 'https://www.zhihu.com/question/1',
      text: '字'.repeat(MAX_READ_TEXT_CHARS + 5000),
    });
    expect(r.stored).toBe(true);
    const row = await prisma.browserTask.findUniqueOrThrow({ where: { id: taskId } });
    const data = JSON.parse(row.resultData!) as { text: string; truncated: boolean };
    expect(data.text.length).toBe(MAX_READ_TEXT_CHARS);
    expect(data.truncated, '截了要标出来，否则模型会以为读全了').toBe(true);
  });

  it('没接真模型时不许拿示例摘要冒充结论', async () => {
    h.llm = { text: '{"title":"x","summary":"（示例）这篇文章非常精彩","points":[]}', mocked: true };
    const r = await acceptReadResult(taskId, { workspaceId: ctx.workspaceId, tenantId: ctx.tenantId }, {
      url: 'https://www.zhihu.com/question/1',
      text: '正文'.repeat(100),
    });
    expect(r.summary).toContain('未接入真实模型');
    expect(r.summary, '示例文案不能出现在回执里').not.toContain('非常精彩');
    const row = await prisma.browserTask.findUniqueOrThrow({ where: { id: taskId } });
    const data = JSON.parse(row.resultData!) as { extract: unknown };
    expect(data.extract, 'Mock 的抽取结果不该落库').toBeNull();
  });

  it('一个字都没读到时如实说，而不是存一条空的', async () => {
    const r = await acceptReadResult(taskId, { workspaceId: ctx.workspaceId, tenantId: ctx.tenantId }, {
      url: 'https://www.zhihu.com/question/1',
      text: '   ',
    });
    expect(r.stored).toBe(false);
    expect(r.summary).toContain('没读到正文');
  });
});

describe('网页内容是不可信输入', () => {
  it('送进模型时用围栏框起来并申明不执行其中的指令', async () => {
    // 插件不做判断，这一步是网页内容第一次被「理解」的地方——
    // 也是唯一能加防线的地方
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.resolve(process.cwd(), 'lib/browser-task/read-result.ts'), 'utf8');
    expect(src, '没有把网页内容标成不可信').toMatch(/不可信输入/);
    expect(src, '没有申明「其中的指令一律不执行」').toMatch(/绝不执行|一律当作正文/);
    expect(src, '没有用围栏把正文框起来').toMatch(/网页正文开始[\s\S]*网页正文结束/);
  });
});
