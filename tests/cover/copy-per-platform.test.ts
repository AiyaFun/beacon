import { describe, it, expect, vi } from 'vitest';
import { COVER_SPECS, coverSpec, specForPlatform } from '@/lib/cover/specs';

// 封面文案要按**版式和读者**写，不能一套小红书通吃。
//
// 【这条守的是一个不会报错的错】此前 deriveCoverMeta 里写死
//   「你是小红书封面文案策划。…mainTitle ≤14字…subTitle ≤12字」
// 于是给 X（推特）出 16:9 横版封面时，模型照样按小红书的「口语＋悬念」来写——
// 而那种文案缩到时间线上的指甲盖小图里根本读不完。
// 没有任何报错，只是每一张非小红书封面的文案都不对味。

const h = vi.hoisted(() => ({ system: '' as string }));
vi.mock('@/lib/llm/gateway', () => ({
  llmComplete: async (_t: unknown, _fn: unknown, messages: { role: string; content: string }[]) => {
    h.system = messages.find((m) => m.role === 'system')?.content ?? '';
    // 故意每次都回一个超长副标题：验「不要副标题」的版式在出口真的截掉了
    return {
      text: JSON.stringify({ mainTitle: '主标题', subTitle: '模型不听话硬塞的副标题', palette: '' }),
      provider: 'scripted', model: 'scripted', mocked: false,
    };
  },
}));

const { deriveCoverMeta } = await import('@/lib/cover/prompt');

describe('每个版式都有自己的文案口径', () => {
  it('🔒 一条都不许漏（漏了会悄悄套用小红书那套）', () => {
    expect(COVER_SPECS.length, '一个规格都没扫到').toBeGreaterThan(5);
    for (const s of COVER_SPECS) {
      expect(s.copy?.persona, `${s.label} 没写文案口径`).toBeTruthy();
      expect(s.copy.titleMax, `${s.label} 的标题上限不合理`).toBeGreaterThan(0);
      expect(s.copy.note, `${s.label} 没写这个版式特有的要求`).toBeTruthy();
    }
  });

  it('🔒 横版与竖版的要求必须真的不同（不然等于没分）', () => {
    const xhs = coverSpec('xhs-3-4').copy;
    const wide = coverSpec('wide-16-9').copy;
    expect(wide.persona, '横版的口径和小红书一模一样').not.toBe(xhs.persona);
    expect(wide.titleMax, '横版小图上字数该更少').toBeLessThan(xhs.titleMax);
  });
});

describe('提示词按版式拼，不再写死小红书', () => {
  it('给 X（推特）出封面时，提示词里不该出现小红书', async () => {
    await deriveCoverMeta(null, '正文', '兜底标题', specForPlatform('x'));
    expect(h.system, '给推特出封面却在按小红书写文案').not.toContain('小红书');
    expect(h.system).toContain('X（推特）');
    expect(h.system, '没把这个版式的字数上限写进去').toContain('≤10字');
  });

  it('给小红书出封面时仍然是小红书那套（别把老行为改坏）', async () => {
    await deriveCoverMeta(null, '正文', '兜底标题', specForPlatform('xiaohongshu'));
    expect(h.system).toContain('小红书');
    expect(h.system).toContain('≤14字');
  });

  it('不传 spec 时回落到默认，行为与以前一致', async () => {
    await deriveCoverMeta(null, '正文', '兜底标题');
    expect(h.system, '老调用被改坏了').toContain('小红书');
  });

  it('每个平台都拼得出自己的提示词（不是只有那两个特例）', async () => {
    for (const [platform, must] of [
      ['douyin', '抖音'], ['bilibili', 'B站'], ['wechat', '公众号'],
      ['youtube', 'X（推特）'], ['shipinhao', '视频号'],
    ] as const) {
      await deriveCoverMeta(null, '正文', '兜底标题', specForPlatform(platform));
      expect(h.system, `${platform} 的提示词里没有「${must}」`).toContain(must);
    }
  });
});

describe('🔒 不要副标题的版式，出口真的截掉', () => {
  it('公众号 2.35:1 太扁，模型硬塞副标题也不许上图', async () => {
    // 副标题是会被**画到图上、随封面发布**的，多出一行就是把扁版式挤坏。
    // 只在提示词里说「不要副标题」挡不住不听话的模型。
    const r = await deriveCoverMeta(null, '正文', '兜底标题', coverSpec('wechat-235-1'));
    expect(r.meta.subTitle, '模型硬塞的副标题被画上图了').toBe('');
    expect(r.meta.mainTitle).toBe('主标题');
  });

  it('要副标题的版式照常保留', async () => {
    const r = await deriveCoverMeta(null, '正文', '兜底标题', coverSpec('xhs-3-4'));
    expect(r.meta.subTitle, '该有副标题的版式被截没了').toBeTruthy();
  });
});

// ── 「写了没接」守卫 ─────────────────────────────────────────────
//
// 上面所有用例都是**直接调 deriveCoverMeta** 并自己把 spec 递进去的。
// 要是 runCover 那个真入口忘了传 spec，整套按平台分的口径在产品里根本不生效，
// 而这个文件依旧全绿——本项目栽过好几次的那一种假绿。
// 所以必须有一条从**真入口**打进去的。
describe('真入口 runCover 确实把版式带下去了', () => {
  it('给 X（推特）出封面，抽文案那一步不该按小红书写', async () => {
    const { runCover } = await import('@/lib/cover/run');
    const { prisma } = await import('@/lib/db');
    const t = await prisma.tenant.create({ data: { name: 'cover-wire', plan: 'free' } });

    // 出图端点用假的：这条只关心「抽文案时提示词长什么样」，出不出得来图无所谓
    const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0x12, 0xff, 0xd9]).toString('base64');
    vi.stubEnv('BEACON_IMAGE_LLM_MODEL', 'test-seedream');
    vi.stubEnv('BEACON_IMAGE_LLM_API_KEY', 'k');
    vi.stubEnv('BEACON_IMAGE_LLM_BASE_URL', 'https://example.test/api/v3');
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ data: [{ b64_json: JPEG }] }), { status: 200 }));

    h.system = '';
    await runCover({ tenantId: t.id, platform: 'x', instruction: '正文', fallbackTitle: '兜底标题' });

    expect(h.system, '真入口根本没走到抽文案这一步，这条守卫是空的').toBeTruthy();
    expect(h.system, 'runCover 没把版式带下去 —— 给推特出封面还在按小红书写').not.toContain('小红书');
    expect(h.system).toContain('X（推特）');
  });
});
