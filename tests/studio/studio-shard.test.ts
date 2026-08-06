import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { prisma } from '@/lib/db';
import { encryptKey } from '@/lib/crypto';

// 创作工坊分片的三件事：
// 1) 导出 key 三级解析（env → 租户 BYOK claude 渠道 → 禁用+可操作指引），修「导出死胡同」；
// 2) 技能一键成品（actRunSkill / actSkillSaveVersion）；
// 3) 采纳终稿时把偏好学习交给 recordDiffPreference（语义 diff），字数摘要只留给 UI。
//
// lib/skills 与 lib/memory/diff 由并行分片实现，这里按**固定契约**打桩（不是 mock prisma——
// 数据库全程真 SQLite）；Anthropic API 照 tests/compliance/export-chain.test.ts 的方式 stub。

const session = { memberId: 'm1', tenantId: 't1', workspaceId: 'w1', accountId: 'a1', memberName: '张三', role: 'owner', plan: 'pro' };
vi.mock('@/lib/session', () => ({ getSession: async () => session, getSessionOrNull: async () => session }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

// ── 并行分片契约桩 ──
const h = vi.hoisted(() => ({
  runSkillCalls: [] as Record<string, unknown>[],
  runSkillResult: { ok: true, output: '默认产出', outputKind: 'text', mocked: true, skillName: '演示技能', riskLevel: 'pass', hits: [] } as unknown,
  diffCalls: [] as Record<string, unknown>[],
  diffThrows: false,
}));
vi.mock('@/lib/skills', () => ({
  listInstalledSkills: async () => [],
  runSkill: async (opts: Record<string, unknown>) => {
    h.runSkillCalls.push(opts);
    return h.runSkillResult;
  },
}));
vi.mock('@/lib/memory/diff', () => ({
  recordDiffPreference: async (opts: Record<string, unknown>) => {
    h.diffCalls.push(opts);
    if (h.diffThrows) throw new Error('diff 模块内部错误（契约上不该抛，这里故意抛来测兜底）');
  },
}));

// ── 极简 pptx 构造（与 export-chain.test.ts 同款，够 verifyAigcLabelInFile 校验用）──
function crc32(buf: Buffer) { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; }
function zip(files: { name: string; body: string }[]) {
  const L: Buffer[] = [], C: Buffer[] = []; let off = 0;
  for (const f of files) {
    const n = Buffer.from(f.name), raw = Buffer.from(f.body), comp = deflateRawSync(raw), crc = crc32(raw);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50,0); lh.writeUInt16LE(8,8); lh.writeUInt32LE(crc,14); lh.writeUInt32LE(comp.length,18); lh.writeUInt32LE(raw.length,22); lh.writeUInt16LE(n.length,26);
    L.push(lh,n,comp);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50,0); ch.writeUInt16LE(8,10); ch.writeUInt32LE(crc,16); ch.writeUInt32LE(comp.length,20); ch.writeUInt32LE(raw.length,24); ch.writeUInt16LE(n.length,28); ch.writeUInt32LE(off,42);
    C.push(ch,n); off += 30+n.length+comp.length;
  }
  const cd = Buffer.concat(C), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50,0); e.writeUInt16LE(files.length,8); e.writeUInt16LE(files.length,10); e.writeUInt32LE(cd.length,12); e.writeUInt32LE(off,16);
  return Buffer.concat([...L, cd, e]);
}
const GOOD_PPTX = () => zip([{ name: 'ppt/slides/slide1.xml', body: '<p:sld><a:p><a:r><a:t>正文——本内容由人工智能生成</a:t></a:r></a:p></p:sld>' }]);

// stub Anthropic API，并记录每次调用送出的 x-api-key（三级解析的核心断言点）
let KEYS_SEEN: string[] = [];
beforeAll(() => {
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = String(url);
    const key = (init?.headers as Record<string, string>)?.['x-api-key'] ?? '';
    KEYS_SEEN.push(key);
    if (u.endsWith('/v1/messages')) {
      return new Response(JSON.stringify({ content: [
        { type: 'text', text: '做好了' },
        { type: 'bash_code_execution_tool_result', content: { content: [{ type: 'bash_code_execution_output', file_id: 'file_x' }] } },
      ]}), { status: 200 });
    }
    if (u.includes('/v1/files/file_x/content')) return new Response(GOOD_PPTX(), { status: 200 });
    if (u.includes('/v1/files/file_x')) return new Response(JSON.stringify({ filename: '成稿.pptx' }), { status: 200 });
    throw new Error('unexpected ' + u);
  });
});

beforeEach(async () => {
  // 外部 shell 可能带着这把 env 进来，会把 BYOK 用例全部短路掉
  delete process.env.BEACON_ANTHROPIC_API_KEY;
  KEYS_SEEN = [];
  h.runSkillCalls.length = 0;
  h.diffCalls.length = 0;
  h.diffThrows = false;
  session.role = 'owner';
  await prisma.modelProvider.deleteMany({});
});

async function mkDraft(versions: { authorType: 'ai' | 'human'; content: string }[] = [{ authorType: 'ai', content: '一段正文。' }]) {
  await prisma.tenant.upsert({ where: { id: 't1' }, create: { id: 't1', name: '测试租户', plan: 'pro' }, update: {} });
  await prisma.workspace.upsert({ where: { id: 'w1' }, create: { id: 'w1', tenantId: 't1', name: '主工作区' }, update: {} });
  await prisma.creatorAccount.upsert({ where: { id: 'a1' }, create: { id: 'a1', workspaceId: 'w1', name: '测试账号', platform: 'douyin' }, update: {} });
  const d = await prisma.draft.create({ data: { accountId: 'a1', title: '测试草稿', platform: 'douyin', status: 'editing' } });
  for (let i = 0; i < versions.length; i++) {
    await prisma.draftVersion.create({ data: { draftId: d.id, seq: i + 1, authorType: versions[i].authorType, content: versions[i].content } });
  }
  return d.id;
}

async function addClaudeProvider(apiKey: string, status: string, vendor = 'claude') {
  return prisma.modelProvider.create({
    data: {
      tenantId: 't1', label: `${vendor}-${status}`, vendor,
      baseUrl: 'https://api.anthropic.com/v1', apiKeyEnc: encryptKey(apiKey), model: 'claude-3-5-sonnet',
      region: 'overseas', status,
    },
  });
}

describe('任务A：导出 key 三级解析（修死胡同）', () => {
  // 一把 key 都没有时，导出**不再是死胡同也不再报错**：两种格式都有本地渲染器
  // （lib/deliverable/registry.ts），Anthropic 渠道降级为「有就用、没有也不影响」的可选增强。
  // 本 describe 剩下的用例仍然要保证：三级解析取到哪把 key、以及**死 key 绝不被打出去**。
  it('env 无 + BYOK 无 → 走本地渲染，导出照常成功，且一个字节都没往外发', async () => {
    const { actExportDeliverable } = await import('@/app/(app)/studio/actions');
    const id = await mkDraft();
    const r = await actExportDeliverable(id, 'pptx');
    expect(r.ok).toBe(true);
    expect(r.labelVerified).toBe(true); // 标识由本地渲染器写入，照样过校验回环
    expect(KEYS_SEEN.length).toBe(0); // 没 key 就没有任何出网调用
  });

  it('env 无 + 租户有 claude 渠道 → 用 status=ok 的那把（untested 的和别家 vendor 的都不选）', async () => {
    const { actExportDeliverable } = await import('@/app/(app)/studio/actions');
    await mkDraft(); // 先建租户
    await addClaudeProvider('sk-ant-untested', 'untested');
    await addClaudeProvider('sk-ant-ok', 'ok');
    await addClaudeProvider('sk-deepseek', 'ok', 'deepseek');
    const id = await mkDraft();
    const r = await actExportDeliverable(id, 'pptx');
    expect(r.ok).toBe(true);
    expect(KEYS_SEEN.every((k) => k === 'sk-ant-ok')).toBe(true);
  });

  it('claude 渠道只有 untested → 也用（宁可调用报错，不锁死功能）', async () => {
    const { actExportDeliverable } = await import('@/app/(app)/studio/actions');
    await mkDraft();
    await addClaudeProvider('sk-ant-untested', 'untested');
    const id = await mkDraft();
    const r = await actExportDeliverable(id, 'pptx');
    expect(r.ok).toBe(true);
    expect(KEYS_SEEN[0]).toBe('sk-ant-untested');
  });

  it('claude 渠道只有 failed（连通性测试挂了/key 被吊销）+ 无 env → 不点亮，绝不拿死 key', async () => {
    const { hasExportClaudeKey } = await import('@/app/(app)/studio/export-key');
    const { actExportDeliverable } = await import('@/app/(app)/studio/actions');
    await mkDraft(); // 先建租户
    await addClaudeProvider('sk-ant-revoked', 'failed');
    expect(await hasExportClaudeKey('t1')).toBe(false); // 死 key 不算「有渠道」
    const id = await mkDraft();
    const r = await actExportDeliverable(id, 'pptx');
    // 导出不受影响（本地渲染兜底），但那把被吊销的 key **绝不能被拿去调用**——
    // 这才是本用例真正守的不变量，与「按钮点不点得亮」无关。
    expect(r.ok).toBe(true);
    expect(KEYS_SEEN.length).toBe(0);
  });

  it('同时有 failed 和 untested → 跳过 failed 取 untested（对齐 gateway 的 status:{not:failed}）', async () => {
    const { actExportDeliverable } = await import('@/app/(app)/studio/actions');
    await mkDraft();
    await addClaudeProvider('sk-ant-revoked', 'failed');
    await addClaudeProvider('sk-ant-untested', 'untested');
    const id = await mkDraft();
    const r = await actExportDeliverable(id, 'pptx');
    expect(r.ok).toBe(true);
    expect(KEYS_SEEN.every((k) => k === 'sk-ant-untested')).toBe(true);
  });

  it('env 有 → 优先于 BYOK', async () => {
    const { actExportDeliverable } = await import('@/app/(app)/studio/actions');
    process.env.BEACON_ANTHROPIC_API_KEY = 'sk-ant-env';
    await mkDraft();
    await addClaudeProvider('sk-ant-ok', 'ok');
    const id = await mkDraft();
    const r = await actExportDeliverable(id, 'pptx');
    expect(r.ok).toBe(true);
    expect(KEYS_SEEN[0]).toBe('sk-ant-env');
  });

  it('页面侧可用性判断与 action 同口径', async () => {
    const { hasExportClaudeKey } = await import('@/app/(app)/studio/export-key');
    await mkDraft();
    expect(await hasExportClaudeKey('t1')).toBe(false);
    await addClaudeProvider('sk-ant-ok', 'ok');
    expect(await hasExportClaudeKey('t1')).toBe(true);
  });
});

describe('任务B：技能一键成品', () => {
  // ⚠️ 语义在本轮被**有意推翻**：原来是「优先最新的人工版」，现在一律取最新版。
  // 旧语义听着体贴，实际是个静默 bug——用户刚点完「按会诊意见改一版」（作者记为 ai），
  // 再点技能，吃的还是更早那份人工稿，刚改的内容被无声丢掉，且不会有任何报错。
  it('actRunSkill：永远取最新一版正文（不再偏爱旧的人工版），带上标题/人设/租户，结果原样透传', async () => {
    const { actRunSkill } = await import('@/app/(app)/studio/actions');
    const id = await mkDraft([
      { authorType: 'ai', content: 'v1-AI初稿' },
      { authorType: 'human', content: 'v2-人工终稿' },
      { authorType: 'ai', content: 'v3-AI又生成的' },
    ]);
    h.runSkillResult = { ok: true, output: '<h1>排好版</h1>', outputKind: 'html', mocked: true, skillName: '微信一键排版', riskLevel: 'warn', hits: [{ word: '最好', tier: 'legal', action: 'warn', start: 0, end: 2 }] };
    const r = await actRunSkill(id, 'skill-1');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output).toBe('<h1>排好版</h1>');
      expect(r.mocked).toBe(true);
      expect(r.hits).toHaveLength(1);
      expect(r.sourceSeq).toBe(3); // 用了第几版必须回给 UI：取错版是不会报错的那种错
    }
    expect(h.runSkillCalls).toHaveLength(1);
    const call = h.runSkillCalls[0];
    expect(call.content).toBe('v3-AI又生成的'); // 就是最新那版，哪怕它是 AI 作者
    expect(call.tenantId).toBe('t1');
    expect(call.skillId).toBe('skill-1');
    expect(call.title).toBe('测试草稿');
    expect(typeof call.persona).toBe('string');
  });

  it('actRunSkill：只有 AI 稿时同样取最新版；空稿/找不到草稿给人话报错', async () => {
    const { actRunSkill } = await import('@/app/(app)/studio/actions');
    const id = await mkDraft([{ authorType: 'ai', content: '只有AI稿' }]);
    await actRunSkill(id, 'skill-1');
    expect(h.runSkillCalls[0].content).toBe('只有AI稿');

    const empty = await mkDraft([]);
    const r1 = await actRunSkill(empty, 'skill-1');
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error).toContain('还没有正文');

    const r2 = await actRunSkill('no-such-draft', 'skill-1');
    expect(r2.ok).toBe(false);
  });

  it('actRunSkill / actSkillSaveVersion：viewer 无权', async () => {
    const a = await import('@/app/(app)/studio/actions');
    const id = await mkDraft();
    session.role = 'viewer';
    await expect(a.actRunSkill(id, 'skill-1')).rejects.toThrow('权限不足');
    await expect(a.actSkillSaveVersion(id, '产出', '技能')).rejects.toThrow('权限不足');
  });

  it('actSkillSaveVersion：seq 顺延、authorType=ai、diff 说明带技能名', async () => {
    const { actSkillSaveVersion } = await import('@/app/(app)/studio/actions');
    const id = await mkDraft([{ authorType: 'ai', content: '初稿' }]);
    const r = await actSkillSaveVersion(id, '排好版的成品', '微信一键排版');
    expect(r.ok).toBe(true);
    expect(r.seq).toBe(2);
    const v = await prisma.draftVersion.findFirst({ where: { draftId: id, seq: 2 } });
    expect(v?.authorType).toBe('ai');
    expect(v?.content).toBe('排好版的成品');
    expect(v?.diffFromPrev).toContain('微信一键排版');
  });
});

describe('任务C：采纳终稿 → 语义偏好学习', () => {
  it('把 AI 初稿与人工终稿交给 recordDiffPreference；UI 的字数摘要照旧存 diffFromPrev', async () => {
    const { actSaveHumanVersion } = await import('@/app/(app)/studio/actions');
    const id = await mkDraft([{ authorType: 'ai', content: 'AI写的初稿，口气很冲。' }]);
    const r = await actSaveHumanVersion(id, '我改后的终稿，语气缓和了，还删了夸张的话。');
    expect(r.ok).toBe(true);
    expect(h.diffCalls).toHaveLength(1);
    expect(h.diffCalls[0]).toMatchObject({
      tenantId: 't1',
      workspaceId: 'w1',
      accountId: 'a1',
      aiDraft: 'AI写的初稿，口气很冲。',
      humanFinal: '我改后的终稿，语气缓和了，还删了夸张的话。',
    });
    const v = await prisma.draftVersion.findFirst({ where: { draftId: id, seq: 2 } });
    expect(v?.diffFromPrev).toMatch(/人工终稿：(扩写 \+\d+|精简 -\d+|等量重写) 字/);
  });

  it('recordDiffPreference 抛错也不阻断采纳（双保险 catch）', async () => {
    const { actSaveHumanVersion } = await import('@/app/(app)/studio/actions');
    const id = await mkDraft([{ authorType: 'ai', content: 'AI稿' }]);
    h.diffThrows = true;
    const r = await actSaveHumanVersion(id, '人工稿');
    expect(r.ok).toBe(true);
    expect(r.seq).toBe(2);
  });

  it('草稿里没有 AI 版本 → 没有可学的基线，不调 recordDiffPreference', async () => {
    const { actSaveHumanVersion } = await import('@/app/(app)/studio/actions');
    const id = await mkDraft([{ authorType: 'human', content: '纯手打第一版' }]);
    const r = await actSaveHumanVersion(id, '手打第二版');
    expect(r.ok).toBe(true);
    expect(h.diffCalls).toHaveLength(0);
  });
});
