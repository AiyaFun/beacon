import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '@/lib/db';
import {
  vetScreenshot, MAX_SCREENSHOT_CHARS, recordParserIncident, purgeParserScreenshots,
} from '@/lib/ingest/parser-learn';

// 解析自学习的「失败现场截图」（2026-08-26，插件 0.9.9）。
//
// 【守的四件事】
// ① 截图是附件不是主料：不合法/超限**丢字段不打回**，骨架照常入库；
// ② 只截用户正看着的页面：sw.js 的 active 闸 + 两端体积上限同一数值；
// ③ 视觉描述只是参考语境：选择器仍要过 verifyAgainstSkeleton 机器闸；
// ④ 30 天清空 + 三份隐私政策都披露（承诺与代码必须对得上）。

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');

const JPEG = `data:image/jpeg;base64,${'A'.repeat(200)}`;

let workspaceId: string;

beforeEach(async () => {
  await prisma.parserIncident.deleteMany();
  const tenant = await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'W' } });
  workspaceId = ws.id;
});

describe('vetScreenshot：附件闸', () => {
  it('合法的 JPEG/PNG/WebP dataUrl 放行', () => {
    expect(vetScreenshot(JPEG)).toBe(JPEG);
    expect(vetScreenshot('data:image/png;base64,iVBOR')).toBe('data:image/png;base64,iVBOR');
    expect(vetScreenshot('data:image/webp;base64,UklGR')).toBe('data:image/webp;base64,UklGR');
  });

  it('不是图片、不是 dataUrl、超限、非字符串：一律丢成空串（不抛错不打回）', () => {
    expect(vetScreenshot('data:text/html;base64,PGh0bWw+'), 'text/html 伪装成截图').toBe('');
    expect(vetScreenshot('https://evil.example.com/a.jpg'), '外链不收，只收内联字节').toBe('');
    expect(vetScreenshot(`data:image/jpeg;base64,${'A'.repeat(MAX_SCREENSHOT_CHARS + 1)}`)).toBe('');
    expect(vetScreenshot(12345)).toBe('');
    expect(vetScreenshot(null)).toBe('');
    // base64 之外的字符（比如闭合引号搞注入）不放行
    expect(vetScreenshot('data:image/jpeg;base64,AA"><script>')).toBe('');
  });
});

describe('入库：附件丢了主料还在，首份不被覆盖', () => {
  it('截图不合法时事件照常创建，screenshot 存空串', async () => {
    const r = await recordParserIncident({
      workspaceId, platform: 'douyin', scope: 'rival', field: 'followers',
      skeleton: { tag: 'div' }, screenshot: 'not-a-data-url',
    });
    expect(r.created).toBe(true);
    const row = await prisma.parserIncident.findUnique({ where: { id: r.id } });
    expect(row!.screenshot).toBe('');
    expect(row!.skeleton, '骨架必须不受附件影响').not.toBe('');
  });

  it('同指纹第二次上报带了别的截图：首份保留（与骨架同一政策，别每次都写大字段）', async () => {
    const first = await recordParserIncident({
      workspaceId, platform: 'douyin', scope: 'rival', field: 'followers',
      skeleton: { tag: 'div' }, screenshot: JPEG,
    });
    const second = await recordParserIncident({
      workspaceId, platform: 'douyin', scope: 'rival', field: 'followers',
      skeleton: { tag: 'div' }, screenshot: 'data:image/jpeg;base64,BBBB',
    });
    expect(second.id).toBe(first.id);
    const row = await prisma.parserIncident.findUnique({ where: { id: first.id } });
    expect(row!.screenshot).toBe(JPEG);
  });

  it('首次没截到、后续补上了：收下（首份为空不算「已有」）', async () => {
    const first = await recordParserIncident({
      workspaceId, platform: 'douyin', scope: 'rival', field: 'followers', skeleton: { tag: 'div' },
    });
    await recordParserIncident({
      workspaceId, platform: 'douyin', scope: 'rival', field: 'followers',
      skeleton: { tag: 'div' }, screenshot: JPEG,
    });
    const row = await prisma.parserIncident.findUnique({ where: { id: first.id } });
    expect(row!.screenshot).toBe(JPEG);
  });
});

describe('30 天清空（只清截图列，事件与骨架保留）', () => {
  it('过了保留期清空、没过的不动；清完事件还在', async () => {
    const r = await recordParserIncident({
      workspaceId, platform: 'douyin', scope: 'rival', field: 'followers',
      skeleton: { tag: 'div' }, screenshot: JPEG,
    });
    expect(await purgeParserScreenshots(new Date()), '今天刚截的不该被清').toBe(0);

    const past31Days = new Date(Date.now() + 31 * 24 * 3600_000);
    expect(await purgeParserScreenshots(past31Days)).toBe(1);
    const row = await prisma.parserIncident.findUnique({ where: { id: r.id } });
    expect(row!.screenshot).toBe('');
    expect(row!.skeleton, '骨架必须留着，运维台还要靠它').not.toBe('');
  });

  it('保留期任务真的挂上了这一步（retention.ts 调 purgeParserScreenshots，detail 里报数）', () => {
    expect(read('lib/legal/retention.ts')).toMatch(/purgeParserScreenshots\(\)/);
    expect(read('lib/jobs/handlers.ts')).toContain('解析截图清空');
  });
});

describe('链路源码契约（防静默回退）', () => {
  it('上报路由把 screenshot 传进了 recordParserIncident，且请求体上限已把截图算进去', () => {
    const route = read('app/api/ingest/parser/route.ts');
    expect(route).toMatch(/screenshot: parsed\.data\.screenshot/);
    expect(route).toMatch(/MAX_SKELETON_CHARS \* 3 \+ MAX_SCREENSHOT_CHARS/);
  });

  it('sw.js：只在 sender 标签页正处于前台时才截（captureVisibleTab 拍的是可见页，不是发消息那页）', () => {
    const sw = read('extension/sw.js');
    expect(sw).toMatch(/tab\.active !== true[^)]*\) return null/);
    // parser:miss 分支里先截图后上报
    const branch = sw.slice(sw.indexOf("msg?.type === 'parser:miss'"));
    expect(branch.slice(0, 600)).toMatch(/captureIncidentShot\(_sender\)/);
  });

  it('体积上限两端同一数值（sw.js 的 INCIDENT_SHOT_MAX_CHARS === 服务端 MAX_SCREENSHOT_CHARS）', () => {
    const m = read('extension/sw.js').match(/INCIDENT_SHOT_MAX_CHARS = (\d+)/);
    expect(m, 'sw.js 里必须有明确的体积常量').toBeTruthy();
    expect(Number(m![1])).toBe(MAX_SCREENSHOT_CHARS);
  });

  it('视觉描述只是参考：提示词声明「不能作为类名依据」，且机器验证仍在诊断之后把关', () => {
    const src = read('lib/ingest/parser-learn.ts');
    expect(src).toContain('不能作为类名依据');
    // 顺序：screenshotHint 的调用在 llmComplete 诊断之前，verifyAgainstSkeleton 的调用在诊断之后
    const propose = src.slice(src.indexOf('export async function proposeSelectors'));
    const hintAt = propose.indexOf('screenshotHint(');
    const diagAt = propose.indexOf('llmComplete(');
    const verifyAt = propose.indexOf('verifyAgainstSkeleton(incident.skeleton');
    expect(hintAt, 'proposeSelectors 里要先取视觉描述').toBeGreaterThan(-1);
    expect(diagAt).toBeGreaterThan(hintAt);
    expect(verifyAt, '机器闸必须仍在诊断之后').toBeGreaterThan(diagAt);
  });

  it('承诺与代码对得上：三份隐私政策都披露了截图（前台才截 / 30 天清空）', () => {
    for (const p of ['extension/store/privacy.md', 'app/(public)/legal/privacy/page.tsx', 'scripts/privacy-page.ts']) {
      const s = read(p);
      expect(s, `${p} 要有截图披露`).toContain('失败现场截图');
      expect(s, `${p} 要写明后台不截`).toContain('后台标签页绝不截图');
      expect(s, `${p} 要写明保留期`).toContain('30 天');
    }
    // 政策写 30 天，代码也得是 30 天——两边有一边改了，这里就红
    expect(read('lib/ingest/parser-learn.ts')).toMatch(/SCREENSHOT_RETENTION_DAYS = 30/);
  });

  it('插件版本已随功能抬到 0.9.9+，审核台会渲染截图', () => {
    const manifest = JSON.parse(read('extension/manifest.json')) as { version: string };
    const [maj, min, pat] = manifest.version.split('.').map(Number);
    expect(maj * 10000 + min * 100 + pat).toBeGreaterThanOrEqual(909);
    expect(read('app/(ops)/ops/parser/ParserPanel.tsx')).toMatch(/i\.screenshot/);
  });
});
