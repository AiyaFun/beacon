import { describe, it, expect, vi, beforeAll } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { prisma } from '@/lib/db';

// 导出链路的端到端闸门：RBAC → 红线硬闸 → AIGC 标识校验回环。
// stub 掉 Anthropic API（导出走官方 Messages API + Agent Skill），跑真实的 server action，
// 因为这三道闸的缺陷恰恰都不在单个函数里，而在「函数明明存在、就是没人在导出路径上调用它」——
// 只测 hasRedline()/verifyAigcLabelInFile() 本身永远发现不了，必须端到端跑 actExportDeliverable。


const session = { memberId: 'm1', tenantId: 't1', workspaceId: 'w1', accountId: 'a1', memberName: '张三', role: 'owner', plan: 'pro' };
vi.mock('@/lib/session', () => ({ getSession: async () => session, getSessionOrNull: async () => session }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

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
const pptxWith = (t: string[]) => zip([{ name: 'ppt/slides/slide1.xml', body: `<p:sld><a:p>${t.map(x=>`<a:r><a:t>${x}</a:t></a:r>`).join('')}</a:p></p:sld>` }]);

// stub 掉 Anthropic API：模型「不听话」时产出什么，由 ARTIFACT 决定
let ARTIFACT: Buffer = Buffer.alloc(0);
let PROMPT_SEEN = '';
beforeAll(() => {
  process.env.BEACON_ANTHROPIC_API_KEY = 'sk-ant-stub';
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/v1/messages')) {
      PROMPT_SEEN = JSON.parse(String(init?.body)).messages[0].content;
      return new Response(JSON.stringify({ content: [
        { type: 'text', text: '做好了' },
        { type: 'bash_code_execution_tool_result', content: { content: [{ type: 'bash_code_execution_output', file_id: 'file_x' }] } },
      ]}), { status: 200 });
    }
    if (u.includes('/v1/files/file_x/content')) return new Response(ARTIFACT, { status: 200 });
    if (u.includes('/v1/files/file_x')) return new Response(JSON.stringify({ filename: '成稿.pptx' }), { status: 200 });
    throw new Error('unexpected ' + u);
  });
});

async function mkDraft(content: string) {
  await prisma.tenant.upsert({ where: { id: 't1' }, create: { id: 't1', name: '测试租户', plan: 'pro' }, update: {} });
  await prisma.workspace.upsert({ where: { id: 'w1' }, create: { id: 'w1', tenantId: 't1', name: '主工作区' }, update: {} });
  await prisma.creatorAccount.upsert({ where: { id: 'a1' }, create: { id: 'a1', workspaceId: 'w1', name: '测试账号', platform: 'douyin' }, update: {} });
  const d = await prisma.draft.create({ data: { accountId: 'a1', title: '三种做图方式对比', platform: 'douyin', status: 'editing' } });
  await prisma.draftVersion.create({ data: { draftId: d.id, seq: 1, authorType: 'ai', content } });
  return d.id;
}

describe('全链路：actExportDeliverable', () => {
  it('【原缺陷复现】模型没保留标识 → 修复前照常交付，修复后必须拦下', async () => {
    const { actExportDeliverable } = await import('@/app/(app)/studio/actions');
    const id = await mkDraft('# 三种做图方式对比\n\n## AI 生成\n成本低、速度快。');
    ARTIFACT = pptxWith(['三种做图方式对比', 'AI 生成成本低速度快']); // 模型漏了标识
    const r = await actExportDeliverable(id, 'pptx');
    expect(r.ok).toBe(false);
    expect(r.dataBase64).toBeUndefined();
  });

  it('模型保留了标识 → 放行且 labelVerified=true', async () => {
    const { actExportDeliverable } = await import('@/app/(app)/studio/actions');
    const id = await mkDraft('讲讲做图方式。');
    ARTIFACT = pptxWith(['三种做图方式对比', '——本内容由', '人工智能生成']);
    const r = await actExportDeliverable(id, 'pptx');
    expect(r.ok).toBe(true);
    expect(r.labelVerified).toBe(true);
    expect(r.dataBase64).toBeTruthy();
  });

  it('PDF → 已下线（无法自动校验 AIGC 标识，绝不交付可能违法的文件）', async () => {
    const { actExportDeliverable } = await import('@/app/(app)/studio/actions');
    const id = await mkDraft('讲讲做图方式。');
    // PDF 正文是子集字体的字形 ID，标识是否真进文件校验不了 → 服务端硬闸直接拒绝该格式，
    // 不再「放行 + warning」。@ts-expect-error：'pdf' 已不在 ExportableFormat 类型里（编译期也挡）。
    // @ts-expect-error 故意传一个已下线的格式，验证服务端运行时也拒绝（防绕过 UI 直接请求）
    const r = await actExportDeliverable(id, 'pdf');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('暂不支持');
  });
});

describe('全链路：红线硬闸', () => {
  beforeAll(async () => {
    for (const w of [
      { word: '国家级', tier: 'legal', action: 'block', suggestion: '（专业级 / 高规格）', category: 'x' },
      { word: '最佳', tier: 'legal', action: 'block', suggestion: '（合适的 / 推荐的）', category: 'x' },
      { word: '最好', tier: 'legal', action: 'warn', suggestion: '（建议）', category: 'x' },
    ]) await prisma.sensitiveWord.create({ data: { ...w, enabled: true } });
  });

  it('【原缺陷复现】命中红线 → 修复前照常导出，修复后拒绝 + 中文原因', async () => {
    const { actExportDeliverable } = await import('@/app/(app)/studio/actions');
    const id = await mkDraft('本产品是国家级方案，效果很好。');
    ARTIFACT = pptxWith(['x', '——本内容由人工智能生成']);
    const r = await actExportDeliverable(id, 'pptx');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('国家级');
  });

  it('不误伤：warn 级词（最好）不拦', async () => {
    const { actExportDeliverable } = await import('@/app/(app)/studio/actions');
    const id = await mkDraft('这是我用过最好的方法之一，建议先看看。');
    ARTIFACT = pptxWith(['x', '——本内容由人工智能生成']);
    const r = await actExportDeliverable(id, 'pptx');
    expect(r.ok).toBe(true);
  });
});

describe('全链路：RBAC', () => {
  it('viewer 不能导出', async () => {
    const { actExportDeliverable } = await import('@/app/(app)/studio/actions');
    const id = await mkDraft('正文');
    session.role = 'viewer';
    await expect(actExportDeliverable(id, 'pptx')).rejects.toThrow('权限不足');

    session.role = 'owner';
  });

  it('viewer 不能发布 / 不能改写 / 不能存终稿，但能诊断', async () => {
    const a = await import('@/app/(app)/studio/actions');
    const id = await mkDraft('正文');
    session.role = 'viewer';
    await expect(a.actRegisterPublish(id)).rejects.toThrow('权限不足：只读无权发布内容');
    await expect(a.actRewrite('正文', 'douyin')).rejects.toThrow('权限不足');
    await expect(a.actDraft(id)).rejects.toThrow('权限不足');
    await expect(a.actSaveHumanVersion(id, '新正文')).rejects.toThrow('权限不足');
    await expect(a.actCoachOptimize('正文', 'douyin')).rejects.toThrow('权限不足');
    const d = await a.actCoachDiagnose('这是一段用于诊断的正文内容。', 'douyin');
    expect('error' in d).toBe(false);
    session.role = 'owner';
  });
});
