import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '@/lib/db';
import { PLATFORMS } from '@/lib/constants';
import { PLATFORM_FORMAT, platformFormatBlock, tidyDraft } from '@/lib/studio/platform-format';
import { buildPlanBlock, buildDraftMessages, loadDraftContext, resolveDraftTarget, DRAFT_HYGIENE_BLOCK } from '@/lib/studio/draft-core';
import { buildOutlinePrompt, buildVoicePrompt } from '@/lib/studio/two-stage';
import { ANGLE_SHAPE_RULES } from '@/lib/topic/scoring';

// 2026-09-15 用户：「点击起稿的内容效果没有很高，请优化一下——已经有对应的格式还有方案」。
// 真机初稿的样子：「### 📌【目标客群：谁会来？】」栏目 + 每段一个 emoji + 「我亲自去体验了一下」（素材库里没有）
// + 「那么问题来了」「欢迎在评论区分享你的看法哦😊」。三处修：
//   ① 平台**格式**（字数/标题/分段/标签/结尾）从一句形容变成可执行说明，所有起稿入口共用；
//   ② 选题**方案**（切入角/答案结构/已知事实/时间窗口/同题参考）进提示词，此前一样都没进；
//   ③ 「怎么写才不像机器」块 + 落库前确定性清洗（markdown 小标题/加粗/字段标签）。

const ROOT = path.resolve(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('① 平台格式', () => {
  it('每个平台都有格式说明，字数区间与段落上限合理', () => {
    for (const key of Object.keys(PLATFORMS)) {
      const f = PLATFORM_FORMAT[key as keyof typeof PLATFORM_FORMAT];
      expect(f, `${key} 没有格式`).toBeTruthy();
      expect(f.kind).toBe(PLATFORMS[key as keyof typeof PLATFORMS].kind);
      expect(f.chars[0]).toBeGreaterThan(0);
      expect(f.chars[1]).toBeGreaterThan(f.chars[0]);
      expect(f.paraMax).toBeGreaterThan(0);
      expect(platformFormatBlock(key)).toContain('【目标平台的格式');
    }
  });

  it('小红书：标题 20 字上限、不要小标题、#话题#、结尾要具体问题；公众号：可以小标题；抖音：不写标题行', () => {
    const xhs = platformFormatBlock('xiaohongshu');
    expect(xhs).toMatch(/上限 20 字/);
    expect(xhs).toMatch(/不要小标题/);
    expect(xhs).toContain('#话题#');
    expect(xhs).toMatch(/具体到能回答的问题/);
    const wx = platformFormatBlock('wechat');
    expect(wx).toMatch(/可以用短句小标题/);
    expect(wx).toMatch(/不用 emoji/);
    const dy = platformFormatBlock('douyin');
    expect(dy).toMatch(/不要写标题行/);
    expect(dy).toMatch(/口播稿/);
    // 认不出的平台退回文章格式，不炸
    expect(platformFormatBlock('nope')).toContain('【目标平台的格式');
  });

  it('清洗：markdown 小标题只留文字、加粗去星号、分割线删掉、字段标签脱掉，#话题# 与序号不动', () => {
    const raw = [
      '### 📌【目标客群：谁会来？】',
      '',
      '**传统影院**：主要面向周末人群。',
      '',
      '---',
      '',
      '标题：真正的标题',
      '1. 第一点',
      '#午休影院# #打工人#',
    ].join('\n');
    const out = tidyDraft(raw, 'xiaohongshu');
    expect(out).not.toMatch(/^#{1,6}\s/m);
    expect(out).not.toContain('**');
    expect(out).not.toMatch(/^---$/m);
    expect(out).toContain('📌【目标客群：谁会来？】'); // 只脱 markdown 记号，文字本身不丢
    expect(out).toContain('传统影院：主要面向周末人群。');
    expect(out).toContain('真正的标题');
    expect(out).not.toContain('标题：');
    expect(out).toContain('1. 第一点');
    expect(out).toContain('#午休影院# #打工人#');
    expect(tidyDraft('', 'douyin')).toBe('');
  });
});

describe('② 选题方案块', () => {
  const topic = {
    id: 't1', title: '1.2 元睡 2.5 小时的午休影院', angle: '从「谁在为午休付费」看这门生意', angleShape: 'list',
    rationale: '本周三个平台都在聊', evidence: '微博在榜 6 小时，抖音尚未出现', windowHint: '抢跑窗口约 30 小时',
    scores: '{}', sourceType: 'hot', sourceRef: null,
  };

  it('切入角 / 答案结构（带判据）/ 已知事实 / 时间窗口 / 为什么值得做 / 同题参考都在', () => {
    const block = buildPlanBlock(topic, [{ title: '午休影院实探', url: null, views: 12000, platform: 'douyin' }]);
    expect(block).toContain('【这条选题的方案');
    expect(block).toContain('从「谁在为午休付费」看这门生意');
    expect(block).toContain(`清单型——${ANGLE_SHAPE_RULES.list}`);
    expect(block).toContain('微博在榜 6 小时');
    expect(block).toContain('不是推测');
    expect(block).toContain('抢跑窗口约 30 小时');
    expect(block).toContain('本周三个平台都在聊');
    expect(block).toMatch(/《午休影院实探》（抖音 · 1\.2万 播放）/);
    expect(block).toMatch(/不许照抄/);
  });

  it('没判定答案结构就不写「答案结构」（不是某个默认形状）；什么都没有就是空串', () => {
    expect(buildPlanBlock({ ...topic, angleShape: null, evidence: null, windowHint: null, rationale: null })).not.toContain('答案结构');
    expect(buildPlanBlock({ ...topic, angleShape: 'other' })).not.toContain('答案结构');
    expect(buildPlanBlock({ ...topic, angle: '', angleShape: null, evidence: null, windowHint: null, rationale: null })).toBe('');
  });

  it('初稿提示词真的带上了方案、格式与「不像机器」块；用户消息带答案结构', async () => {
    await prisma.tenant.deleteMany();
    const tenant = await prisma.tenant.create({ data: { name: 't' } });
    const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'w' } });
    const acc = await prisma.creatorAccount.create({
      data: { workspaceId: ws.id, name: 'a', platform: 'xiaohongshu', personaCard: JSON.stringify({ platforms: ['xiaohongshu'] }) },
    });
    await prisma.topicIdea.create({
      data: { accountId: acc.id, title: '选题A', angle: '角度A', angleShape: 'comparison', evidence: '事实E', windowHint: '窗口W', state: 'accepted', sourceType: 'hot' },
    });
    const r = await resolveDraftTarget({ accountId: acc.id, draftId: null });
    if (!r.ok) throw new Error(r.error);
    expect(r.target.topic?.angleShape).toBe('comparison');
    const ctx = await loadDraftContext({ workspaceId: ws.id, accountId: acc.id, target: r.target });
    expect(ctx.planCtx).toContain('对比型');
    expect(ctx.planCtx).toContain('事实E');
    const { messages } = buildDraftMessages(r.target, ctx);
    const sys = String(messages[0].content);
    expect(sys).toContain('【这条选题的方案');
    expect(sys).toContain('【目标平台的格式（小红书');
    expect(sys).toContain(DRAFT_HYGIENE_BLOCK);
    expect(sys).toContain('只输出正文');
    // 方案排在格式前、格式排在禁用词表前（先说写什么，再说怎么排，最后说别怎么写）
    expect(sys.indexOf('【这条选题的方案')).toBeLessThan(sys.indexOf('【目标平台的格式'));
    expect(sys.indexOf('【目标平台的格式')).toBeLessThan(sys.indexOf('【禁用词表'));
    expect(String(messages[1].content)).toContain('答案结构：对比型');
  });
});

describe('③ 深度模式两段都吃到方案与格式', () => {
  it('大纲段带方案块并要求按答案结构列；成稿段用格式块取代一句话形态，并带「不像机器」块', () => {
    const outline = buildOutlinePrompt({ platformName: '小红书', topicTitle: 'T', planBlock: '【这条选题的方案】\n- 答案结构：清单型' });
    expect(outline).toContain('【这条选题的方案】');
    expect(outline).toMatch(/按那个结构列/);
    const voice = buildVoicePrompt({ platformName: '小红书', outline: 'o', styleHint: '一句话形态', formatBlock: platformFormatBlock('xiaohongshu'), hygieneBlock: DRAFT_HYGIENE_BLOCK });
    expect(voice).toContain('【目标平台的格式（小红书');
    expect(voice).not.toContain('一句话形态');
    expect(voice).toContain('【怎么写才不像机器】');
    // 没给格式块时行为不变（老调用点）
    expect(buildVoicePrompt({ platformName: '抖音', outline: 'o', styleHint: '一句话形态' })).toContain('目标平台形态：一句话形态');
  });
});

describe('🔒 接线守卫：每个起稿出口都过同一套', () => {
  it('流式路由落库前 tidyDraft；普通/深度/想法深度/派生四处都用 tidyDraft 或 formatBlock；工作流初稿也清洗', () => {
    const route = strip(read('app/api/studio/draft/stream/route.ts'));
    expect(route).toMatch(/(const|let) content = tidyDraft\(full, target\.platform\)/);
    const actions = strip(read('app/(app)/studio/actions.ts'));
    expect((actions.match(/tidyDraft\(/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect((actions.match(/formatBlock: platformFormatBlock\(platform\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((actions.match(/hygieneBlock: DRAFT_HYGIENE_BLOCK/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(actions).toMatch(/planBlock: ctx\.planCtx/);
    expect(actions, '派生改写不该再只给一句风格形容').not.toMatch(/目标平台风格要求：\$\{style\}/);
    const wf = strip(read('lib/workflow/run.ts'));
    expect(wf).toMatch(/tidyDraft\(res\.text, target\.target\.platform\)/);
  });

  it('普通初稿的提示词里不再只有一句 PLATFORM_STYLE，而是 platformFormatBlock', () => {
    const core = strip(read('lib/studio/draft-core.ts'));
    const fn = core.slice(core.indexOf('export function buildDraftMessages'), core.indexOf('export function persistDraftVersion'));
    expect(fn).toMatch(/platformFormatBlock\(target\.platform\)/);
    expect(fn).toMatch(/ctx\.planCtx/);
    expect(fn).toMatch(/DRAFT_HYGIENE_BLOCK/);
    expect(fn).not.toMatch(/钩子-正文-引导/); // 模板化结构指令已去掉
  });
});
