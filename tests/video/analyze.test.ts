import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '@/lib/db';
import {
  analyzeVideo,
  checkVideoUrl,
  pickChannel,
  CHANNEL_BASIS,
  basisOf,
  normalizeTranscript,
  textCarrierState,
  textCarrierLines,
  TEXT_CARRIER_HEADING,
  TRANSCRIPT_SOURCE_PLATFORMS,
} from '@/lib/video/analyze';
import { inlineSource, clampFps, videoPart, looksVideoCapable, MAX_INLINE_VIDEO_BYTES } from '@/lib/llm/ark';
import { loadExemplars } from '@/lib/account-context';

// 视频/作品拆解。这套用例里最重要的三条，每一条守的都是一个「错了就看不出来」的失败：
//   ① 拆解产物绝不进生成语料池（与剪藏同一条线，见 tests/clip/clip.test.ts）
//   ② 没看视频就绝不能有时间线 —— 编造的分镜带着时间戳，用户几乎不可能识别出来
//   ③ 没配方舟渠道时不许落库 —— 存一条空壳比报错糟糕得多

const BRIEF = {
  summary: '一条讲露营装备的测评',
  hook: '开场直接甩出「三千块全踩坑」的结论',
  beats: [{ at: '0:00-0:03', what: '甩结论' }, { at: '0:03-0:15', what: '逐件拆包' }],
  points: ['结果前置，3 秒内给结论', '每件装备配一个失败场景'],
  uncertain: ['具体价格视频里未明确'],
  takeaway: '可以借鉴「结论前置」这一层',
};

beforeEach(async () => {
  await prisma.tenant.deleteMany({});
  await prisma.tenant.create({ data: { id: 't1', name: 'T', plan: 'free' } });
  await prisma.workspace.create({ data: { id: 'w1', tenantId: 't1', name: 'W' } });
  await prisma.creatorAccount.create({
    data: { id: 'a1', workspaceId: 'w1', name: '测试号', platform: 'douyin', status: 'active' },
  });
});
afterEach(() => vi.restoreAllMocks());

async function mockVideo(payload: unknown = BRIEF) {
  const gw = await import('@/lib/llm/gateway');
  return vi.spyOn(gw, 'llmVideo').mockResolvedValue({ ok: true, text: JSON.stringify(payload), model: 'doubao-seed-x' });
}
async function mockVision(payload: unknown = { ...BRIEF, beats: [] }) {
  const gw = await import('@/lib/llm/gateway');
  return vi.spyOn(gw, 'llmVision').mockResolvedValue({ ok: true, text: JSON.stringify(payload), model: 'doubao-vision-x' });
}

const FILE = { kind: 'inline' as const, dataUri: 'data:video/mp4;base64,AAAA', bytes: 1024, mime: 'video/mp4' };

describe('checkVideoUrl · 平台作品页不是视频源', () => {
  // 用户第一反应一定是贴作品链接。不挡的话他要等 90 秒才拿到一句看不懂的方舟报错。
  it.each([
    ['https://www.douyin.com/video/123', '抖音'],
    ['https://www.bilibili.com/video/BV1xx', 'B站'],
    ['https://www.youtube.com/watch?v=abc', 'YouTube'],
    ['https://www.xiaohongshu.com/explore/123', '小红书'],
  ])('%s → 拒绝，并告诉他下载后上传', (url, name) => {
    const r = checkVideoUrl(url);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain(name);
    expect(r.error).toContain('下载');
  });

  it('🔒 拒绝理由里必须写明「不去解也不去绕」——这是红线，不是技术限制', () => {
    const r = checkVideoUrl('https://www.douyin.com/video/123');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/不去解|不去绕/);
  });

  it('普通 CDN 直链放行', () => {
    expect(checkVideoUrl('https://cdn.example.com/a/b.mp4?sign=x').ok).toBe(true);
  });

  it('非 http(s) 一律拒绝（file:// / data: 都不许当视频源）', () => {
    expect(checkVideoUrl('file:///etc/passwd').ok).toBe(false);
    expect(checkVideoUrl('not-a-url').ok).toBe(false);
  });
});

describe('pickChannel · 按手上有什么降级', () => {
  it('有视频走 video；只有封面走 cover；只有文案走 text', () => {
    expect(pickChannel({ source: FILE, coverDataUri: null, text: null })).toBe('video');
    expect(pickChannel({ source: null, coverDataUri: 'data:image/jpeg;base64,x', text: null })).toBe('cover');
    expect(pickChannel({ source: null, coverDataUri: null, text: '这是一段足够长的作品文案内容，用来验证纯文案档也能跑通分析' })).toBe('text');
  });

  it('什么都没有 → null（不硬跑一次模型）', () => {
    expect(pickChannel({ source: null, coverDataUri: null, text: '短' })).toBeNull();
  });

  it('视频优先于封面 —— 有视频就不该退到封面档', () => {
    expect(pickChannel({ source: FILE, coverDataUri: 'data:image/jpeg;base64,x', text: 'xxxxxxxxxxxxxxxxxxxxxx' })).toBe('video');
  });
});

describe('analyzeVideo · 视频档', () => {
  it('落库：报告进 content，摘要/要点/用处各就各位', async () => {
    await mockVideo();
    const r = await analyzeVideo({ workspaceId: 'w1', accountId: 'a1', source: FILE, title: '露营装备测评' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.channel).toBe('video');
    expect(r.points).toHaveLength(2);

    const row = await prisma.inspirationItem.findFirst({ where: { workspaceId: 'w1' } });
    expect(row?.source).toBe('clip'); // 与剪藏同属资讯库，共用 /library 出口
    expect(row?.content).toContain('节奏时间线');
    expect(row?.content).toContain('0:00-0:03');
    expect(row?.summary).toContain('露营装备');
  });

  it('报告顶部写明分析依据，且必须提到看了完整视频', async () => {
    await mockVideo();
    const r = await analyzeVideo({ workspaceId: 'w1', source: FILE });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report).toContain(CHANNEL_BASIS.video);
  });

  // 2026-07-31 真机实测逮到的：方舟视频理解按 fps 抽帧读画面，**收不到音轨**
  //（doubao-seed-evolving 对明确带旁白的视频直接回「无音轨」）。
  // 依据行原本写着「画面 + 口播 + 字幕」= 我们自己在夸大分析依据，
  // 恰恰是这行字本来要防的事。口播能不能读到取决于视频有没有硬字幕。
  it('🔒 依据行不许承诺「口播」——模型听不见声音', () => {
    expect(CHANNEL_BASIS.video).not.toMatch(/口播 \+|\+ 口播|含口播/);
    expect(CHANNEL_BASIS.video).toContain('不含音轨');
    expect(CHANNEL_BASIS.video).toContain('硬字幕');
  });

  it('🔒 video 档的 prompt 必须明说「听不到声音」，否则模型会顺着编旁白', async () => {
    const spy = await mockVideo();
    await analyzeVideo({ workspaceId: 'w1', source: FILE });
    const system = String(spy.mock.calls[0][1][0].content);
    expect(system).toContain('听不到任何声音');
    expect(system).toContain('不许臆测');
  });

  it('存疑项一定渲染出来（哪怕模型没给，也要说一句）', async () => {
    await mockVideo({ ...BRIEF, uncertain: [] });
    const r = await analyzeVideo({ workspaceId: 'w1', source: FILE });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report).toContain('没说清的');
  });
});

describe('🔒 没看视频就不许有时间线', () => {
  // 这条是本模块最危险的失败形态：模型顺着 JSON 结构编一条带时间戳的分镜出来，
  // 看上去和真的一模一样。prompt 里禁过一次，代码这里必须再挡一道。
  it('封面档即使模型硬塞了 beats，报告里也不能出现时间线', async () => {
    await mockVision({ ...BRIEF, beats: [{ at: '0:00-0:05', what: '编造的开场' }] });
    const r = await analyzeVideo({ workspaceId: 'w1', source: null, coverDataUri: 'data:image/jpeg;base64,x', title: 'x' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.channel).toBe('cover');
    expect(r.report).not.toContain('节奏时间线');
    expect(r.report).not.toContain('编造的开场');
    expect(r.report).not.toContain('0:00-0:05');
  });

  it('封面档的依据说明里必须说破「没有看视频内容」', async () => {
    await mockVision();
    const r = await analyzeVideo({ workspaceId: 'w1', source: null, coverDataUri: 'data:image/jpeg;base64,x' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report).toContain('没有看视频内容');
    expect(CHANNEL_BASIS.cover).not.toContain('**'); // 纯文本：Chrome 通知里 ** 会显示成星号
  });
});

describe('字幕轨：补上模型听不见的那一半', () => {
  const TR = [
    { at: 0, text: '三千块买的露营装备，全踩坑' },
    { at: 5, text: '第一件，这个帐篷' },
    { at: 12, text: '看着结实，一阵风就塌' },
  ];

  it('封面档 + 字幕轨 → 依据行要说清「口播有了」，不能还写成只有封面', async () => {
    await mockVision();
    const r = await analyzeVideo({ workspaceId: 'w1', source: null, coverDataUri: 'data:image/jpeg;base64,x', transcript: TR });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report).toContain(basisOf('cover', true));
    expect(r.report).toContain('字幕轨');
  });

  it('口播时间线由代码从字幕轨直接渲染，原文一字不改', async () => {
    await mockVision();
    const r = await analyzeVideo({ workspaceId: 'w1', source: null, coverDataUri: 'data:image/jpeg;base64,x', transcript: TR });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report).toContain('## 口播时间线（平台字幕轨原文）');
    expect(r.report).toContain('`0:00` 三千块买的露营装备，全踩坑');
    expect(r.report).toContain('`0:12` 看着结实，一阵风就塌');
  });

  it('🔒 有字幕轨也不放开画面分镜——字幕说的是「说了什么」不是「画面上有什么」', async () => {
    await mockVision({ ...BRIEF, beats: [{ at: '0:00-0:05', what: '编造的开场画面' }] });
    const r = await analyzeVideo({ workspaceId: 'w1', source: null, coverDataUri: 'data:image/jpeg;base64,x', transcript: TR });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report).not.toContain('节奏时间线（画面）');
    expect(r.report).not.toContain('编造的开场画面');
  });

  it('🔒 封面档带字幕时，prompt 必须禁止拿字幕去描述画面', async () => {
    const spy = await mockVision();
    await analyzeVideo({ workspaceId: 'w1', source: null, coverDataUri: 'data:image/jpeg;base64,x', transcript: TR });
    const system = String(spy.mock.calls[0][1][0].content);
    expect(system).toContain('不许据此描述任何画面');
  });

  it('normalizeTranscript：丢空行、按时间排序、去掉非法时间戳', () => {
    const out = normalizeTranscript([
      { at: 9, text: '后说的' },
      { at: 1, text: '  先说的  ' },
      { at: 3, text: '   ' },
      { at: -1, text: '负数时间' },
      { at: NaN, text: '非数字' },
    ] as never);
    expect(out).toEqual([
      { at: 1, text: '先说的' },
      { at: 9, text: '后说的' },
    ]);
  });

  it('没有字幕轨时，依据行不许凭空提字幕', () => {
    expect(basisOf('cover', false)).not.toContain('字幕轨');
    expect(basisOf('video', true)).toContain('字幕轨');
  });

  it('纯文案档也能只靠字幕轨跑起来（没封面没视频）', async () => {
    const gw = await import('@/lib/llm/gateway');
    vi.spyOn(gw, 'llmComplete').mockResolvedValue({
      text: JSON.stringify({ ...BRIEF, beats: [] }), mocked: false, model: 'x', provider: 'x',
    } as never);
    const r = await analyzeVideo({ workspaceId: 'w1', source: null, transcript: TR });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.channel).toBe('text');
    expect(r.report).toContain('三千块买的露营装备');
  });
});

describe('文本载体体检：口播没有文本载体 → 检索读不到', () => {
  // 确定性判断（字幕轨有没有），不过模型、不烧配额。
  // 这套用例守两件事：真缺时必须出声；**取不到字幕的平台不许出声**（unknown 不许冒充 no）。
  const YT = 'https://www.youtube.com/watch?v=abc123';
  const COVER = 'data:image/jpeg;base64,x';
  const TR = [{ at: 0, text: '开场先甩结论' }, { at: 6, text: '第一件事' }];

  async function report(over: Partial<Parameters<typeof analyzeVideo>[0]>) {
    await mockVision();
    const r = await analyzeVideo({ source: null, coverDataUri: COVER, ...over, workspaceId: 'w1' });
    expect(r.ok).toBe(true);
    return r.ok ? r.report : '';
  }

  it('YouTube 视频 + 插件去要过字幕但是空的 → 报告里出提示，并说清「检索读不到」和该怎么补', async () => {
    const rep = await report({ originUrl: YT, transcript: [] });
    expect(rep).toContain(TEXT_CARRIER_HEADING);
    expect(rep).toContain('没有文本载体');
    expect(rep).toContain('AI 检索');
    expect(rep).toMatch(/标题|简介/);
    expect(rep).toMatch(/评论区置顶/);
  });

  it('🔒 取不到字幕的平台（抖音）就算 transcript 是空数组，也不许报「你没上字幕」', async () => {
    // 抖音的字幕轨插件根本没去要过（extension/content/work.js 只处理 youtube/bilibili）。
    // 报缺失＝把「我们取不到」说成「用户没上」，正是 unknown 冒充 no。
    const rep = await report({ originUrl: 'https://www.douyin.com/video/7123', transcript: [] });
    expect(rep).not.toContain(TEXT_CARRIER_HEADING);
    expect(rep).not.toContain('没有文本载体');
  });

  it('🔒 上传档根本没查过字幕轨（不传 transcript 字段）→ 也不许报缺失', async () => {
    // /api/video/analyze 的上传通道从不传 transcript。清洗后的数组分不出这一档
    // （normalizeTranscript(null) 也是 []），所以判据必须看原始入参在不在。
    await mockVideo();
    const r = await analyzeVideo({ workspaceId: 'w1', source: FILE, originUrl: YT });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report).not.toContain(TEXT_CARRIER_HEADING);
  });

  it('有字幕轨时不出任何提示（不说「你有字幕，很好」这种废话）', async () => {
    const rep = await report({ originUrl: YT, transcript: TR });
    expect(rep).toContain('## 口播时间线（平台字幕轨原文）'); // 字幕确实用上了
    expect(rep).not.toContain(TEXT_CARRIER_HEADING);
  });

  it('B站视频页判 missing，B站专栏（不是视频、没有口播）判 unknown', () => {
    const arg = { checked: true, hasTranscript: false };
    expect(textCarrierState({ ...arg, originUrl: 'https://www.bilibili.com/video/BV1xx' })).toEqual({
      state: 'missing',
      platform: 'B站',
    });
    expect(textCarrierState({ ...arg, originUrl: 'https://www.bilibili.com/read/cv12345' }).state).toBe('unknown');
    expect(textCarrierState({ ...arg, originUrl: 'https://www.youtube.com/@somechannel' }).state).toBe('unknown');
    expect(textCarrierState({ ...arg, originUrl: 'https://youtu.be/abc123' }).state).toBe('missing');
  });

  it('三档：有字幕=ok、没查过=unknown、没链接=unknown', () => {
    expect(textCarrierState({ originUrl: YT, checked: true, hasTranscript: true }).state).toBe('ok');
    expect(textCarrierState({ originUrl: YT, checked: false, hasTranscript: false }).state).toBe('unknown');
    expect(textCarrierState({ originUrl: null, checked: true, hasTranscript: false }).state).toBe('unknown');
  });

  it('🔒 白名单只有插件真去要过字幕的两家——多一家就是在替别的平台下结论', () => {
    expect(Object.keys(TRANSCRIPT_SOURCE_PLATFORMS).sort()).toEqual(['bilibili', 'youtube']);
  });

  it('🔒 提示措辞：不许暗示我们听到了音轨，也不许承诺补了字幕就会被引用', () => {
    const text = textCarrierLines('YouTube').join('\n');
    expect(text).toContain('听不见声音'); // 与 CHANNEL_BASIS.video 同一口径：我们只看画面
    expect(text).not.toMatch(/听到|听得到|音频转写|识别出的语音/);
    // 断言里不许跟着「引用」写死：改成「就会被 AI 检索引用」这种插了字的承诺，
    // 收窄的正则会漏掉（第一版就漏了）。这里只认承诺句式本身。
    expect(text).not.toMatch(/就会被|就能被|一定(会|能)|必(然|定)|保证/);
  });
});

describe('🔒 失败就是失败，绝不落一条空壳', () => {
  it('没配方舟渠道 → 报错且库里一条都不许有', async () => {
    const gw = await import('@/lib/llm/gateway');
    vi.spyOn(gw, 'llmVideo').mockResolvedValue({ ok: false, reason: 'not_configured', error: '未配置火山方舟渠道' });
    const r = await analyzeVideo({ workspaceId: 'w1', source: FILE });
    expect(r.ok).toBe(false);
    expect(await prisma.inspirationItem.count()).toBe(0);
  });

  it('模型返回合法 JSON 但什么都没说 → 报错，且提示多半是取不到视频', async () => {
    await mockVideo({});
    const r = await analyzeVideo({ workspaceId: 'w1', source: FILE });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('取不到');
    expect(await prisma.inspirationItem.count()).toBe(0);
  });

  it('文案档撞上 Mock 降级 → 当失败处理（不给用户存一份看不出来的示例拆解）', async () => {
    const gw = await import('@/lib/llm/gateway');
    vi.spyOn(gw, 'llmComplete').mockResolvedValue({
      text: JSON.stringify(BRIEF), mocked: true, model: 'beacon-mock-v1', provider: 'mock',
    } as never);
    const r = await analyzeVideo({ workspaceId: 'w1', source: null, text: '这是一段足够长的作品文案内容，用来验证纯文案档也能跑通分析' });
    expect(r.ok).toBe(false);
    expect(await prisma.inspirationItem.count()).toBe(0);
  });
});

describe('🔒 合规护栏：拆解产物绝不进入生成语料池', () => {
  it('拆解入库之后，「像我一样写」的原句样本仍然一条都取不到它', async () => {
    await mockVideo();
    await analyzeVideo({ workspaceId: 'w1', accountId: 'a1', source: FILE, title: '露营装备测评' });

    const stored = await prisma.inspirationItem.findFirst({ where: { workspaceId: 'w1' } });
    expect(stored?.content).toContain('结果前置'); // 确实存进去了

    const exemplars = await loadExemplars('a1');
    expect(exemplars).toHaveLength(0);
    expect(JSON.stringify(exemplars)).not.toContain('结果前置');
  });

  it('报告尾部带来源声明与「勿直接复用」', async () => {
    await mockVideo();
    const r = await analyzeVideo({ workspaceId: 'w1', source: FILE, mode: 'rival', rivalName: '某同行' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report).toContain('归原作者所有');
    expect(r.report).toContain('勿直接复用');
  });
});

describe('同一条作品重复分析 → 更新而不是堆重复', () => {
  it('同 workspace 同 originUrl 只留一条', async () => {
    await mockVideo();
    const url = 'https://www.douyin.com/video/999';
    await analyzeVideo({ workspaceId: 'w1', source: FILE, originUrl: url, title: '第一次' });
    await analyzeVideo({ workspaceId: 'w1', source: FILE, originUrl: url, title: '第二次' });
    expect(await prisma.inspirationItem.count()).toBe(1);
    const row = await prisma.inspirationItem.findFirst({ where: { workspaceId: 'w1' } });
    expect(row?.title).toBe('第二次');
  });
});

describe('lib/llm/ark · 输入侧闸门', () => {
  it('超过大小上限 → 明确告诉他多大、上限多少', () => {
    const big = new Uint8Array(MAX_INLINE_VIDEO_BYTES + 1);
    const r = inlineSource(big, 'video/mp4');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('上限');
    expect(r.error).toContain('压');
  });

  it('非视频格式 → 拒绝', () => {
    expect(inlineSource(new Uint8Array(10), 'image/png').ok).toBe(false);
    expect(inlineSource(new Uint8Array(10), 'video/mp4').ok).toBe(true);
  });

  it('带 charset 之类参数的 mime 也认', () => {
    expect(inlineSource(new Uint8Array(10), 'video/mp4; codecs=avc1').ok).toBe(true);
  });

  it('fps 钳在方舟的 [0.2, 5] 区间内', () => {
    expect(clampFps(99)).toBe(5);
    expect(clampFps(0)).toBe(0.2);
    expect(clampFps(undefined)).toBe(1);
    expect(clampFps(NaN)).toBe(1);
    expect(clampFps(2.5)).toBe(2.5);
  });

  it('videoPart 产出方舟口径的 video_url 片段', () => {
    const p = videoPart({ kind: 'url', url: 'https://x/a.mp4' }, 3);
    expect(p).toEqual({ type: 'video_url', video_url: { url: 'https://x/a.mp4', fps: 3 } });
  });

  it('模型能力判断只作提示：纯文本豆包判 false，seed/vision 判 true', () => {
    expect(looksVideoCapable('doubao-pro-32k')).toBe(false);
    expect(looksVideoCapable('doubao-seed-2.0-pro')).toBe(true);
    expect(looksVideoCapable('doubao-1.5-vision-pro')).toBe(true);
  });
});
