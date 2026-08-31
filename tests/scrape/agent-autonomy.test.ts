import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { browseFailureHint } from '@/lib/agent/tools-local';
import { traceFingerprint, SUGGEST_AFTER_RUNS } from '@/lib/skill/distill';
import { SITE_STOPPED_REASON } from '@/lib/scrape/recipe';

// 补 Hermes 那半段（2026-08-29 批五）：采集专属诊断回灌、技能自动建议、事前计划。
//
// 这三件的共同点是：**能力早就有了，缺的是「什么时候用它」那一下**。
//   · run.ts 早就在如实回灌工具错误，但错误里没有可自省的东西——一句「打开页面失败」推不出下一步；
//   · ProcedureSkill 早就能从真实轨迹提炼，但要用户自己想起来去点那个按钮；
//   · appendStep 早就有步骤流，但那是**事后**的，前几十秒用户看到的是白屏。

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('采集失败要给「下一步试什么」，不是一句报错', () => {
  it('连不上浏览器：明说别重试（浏览器起来之前重试多少次都一样）', () => {
    const h = browseFailureHint('连不上本机浏览器（http://127.0.0.1:9222）', true);
    expect(h).toContain('不要重试');
    expect(h).toContain('启动采集浏览器');
  });

  it('🔒 robots 拒绝：明说不要换个写法再试', () => {
    const h = browseFailureHint('站点的 robots.txt 声明不允许抓取 /x', true);
    expect(h).toContain('不要换个写法再试');
    // 绕 robots 是明确不做的事，建议里不能出现任何暗示可以绕的说法
    expect(h).not.toMatch(/换个(网址|地址|路径)试/);
  });

  it('🔒 敏感站点：这是产品边界不是故障，别让它换网址接着试', () => {
    const h = browseFailureHint('这类站点（医疗／金融／票务）的个人信息敏感度过高，不做采集', true);
    expect(h).toContain('产品边界');
    expect(h).toContain('别再换网址试');
  });

  it('🔒 被风控拦下：明说现在不要重试（重试只会让情况更糟）', () => {
    const h = browseFailureHint('这个站点这次要求人机验证或提示访问过于频繁（页面要求人机验证）', true);
    expect(h).toContain('不要重试');
  });

  it('🔒 登录墙：明说不要替他输密码', () => {
    const h = browseFailureHint('这个页面要求登录（页面上有密码输入框）', true);
    expect(h).toContain('不要替他输入任何账号密码');
  });

  it('分档给建议，不是永远同一份（永远同一份会在「网址打错」时也建议去登录）', () => {
    const a = browseFailureHint('连不上本机浏览器', true);
    const b = browseFailureHint('这个页面要求登录（地址是登录页）', true);
    const c = browseFailureHint('打开页面失败', true);
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('兜底那份按有没有配方给不同的话（没配方时让它先建一个）', () => {
    expect(browseFailureHint('打开页面失败', true)).toContain('就绪选择器');
    expect(browseFailureHint('打开页面失败', false)).toContain('先建一个配方');
  });

  it('🔒 真的接到工具返回里了（写了函数没调用等于没做）', () => {
    const src = read('lib/agent/tools-local.ts');
    expect(src).toContain('browseFailureHint(page.error, !!recipe)');
  });
});

describe('技能自动建议：跑重复了才提醒', () => {
  const src = read('lib/skill/distill.ts');

  it('按工具序列认「同一种做法」，不按用户那句话', () => {
    // 用户每次说的话都不一样（「看看昨天数据」「昨天数据怎么样」），做法却是同一条
    expect(traceFingerprint(['a', 'b'])).toBe(traceFingerprint(['a', 'b']));
    expect(traceFingerprint(['a', 'b'])).not.toBe(traceFingerprint(['b', 'a']));
  });

  it('2 次是巧合，3 次才是习惯', () => {
    expect(SUGGEST_AFTER_RUNS).toBeGreaterThanOrEqual(3);
  });

  it('🔒 只建议、不自动创建（它带着一份可重放的工具白名单，那种东西不该自己长出来）', () => {
    const i = src.indexOf('export async function suggestProcedures');
    const body = src.slice(i);
    expect(body).toContain('notify(');
    expect(body).not.toContain('procedureSkill.create');
  });

  it('🔒 一步就做完的不建议（那本来就是一次工具调用）', () => {
    expect(src).toContain('if (trace.length < 2) continue;');
  });

  it('🔒 已经存过的做法不再提醒，且按白名单比不按名字比（用户会改名）', () => {
    expect(src).toContain('toolAllowlist: true');
    expect(src).toContain('known.has(key)');
  });

  it('🔒 refId 按做法指纹去重（不带的话每轮扫描都新发一条，通知就没人看了）', () => {
    expect(src).toContain('refId: `procedure-suggest:${key}`');
  });

  it('一轮最多提醒几条（一次弹七八条，用户只会全部划掉）', () => {
    expect(src).toContain('if (suggested >= 3) break;');
  });

  it('🔒 真的挂进了定时，且失败不连累记忆优化', () => {
    const h = read('lib/jobs/handlers.ts');
    expect(h).toContain('suggestProcedures(w.id).catch');
    expect(h).toContain('建议存成技能');
  });

  it('🔒 演示工作区不参与（那是只读展台，不该被自动学习改写）', () => {
    const h = read('lib/jobs/handlers.ts');
    // 【锚在调用点，不是 import 那一行】indexOf 找到的第一个是文件顶部的 import，
    // 它前面 200 字符里当然没有 DEMO_WORKSPACE_ID——守卫查错了地方，说的不是它想说的事
    const i = h.indexOf('suggestProcedures(w.id)');
    expect(i, '没找到调用点').toBeGreaterThan(0);
    expect(h.slice(Math.max(0, i - 300), i)).toContain('DEMO_WORKSPACE_ID');
  });
});

describe('事前计划：别让用户对着白屏等', () => {
  const src = read('lib/agent/run.ts');

  it('要求两步以上的活先说计划', () => {
    expect(src).toContain('开工前先说计划');
    expect(src).toContain('两步以上');
  });

  it('🔒 一句话能答的不许列计划（那只是噪音）', () => {
    expect(src).toContain('不要列计划');
  });

  it('🔒 计划不是合同——中途改主意是允许的', () => {
    // 把计划做成结构化数据就得有人保证它和实际执行一致，而模型中途改主意往往是对的
    expect(src).toContain('计划是给用户看的，不是合同');
  });
});

describe('停采不是抓取失败，是不许抓（2026-08-29 彻查时补）', () => {
  it('🔒 有独立一档，且明说不要重试、不要换网址、不要换写法', () => {
    // 不加这一档的话它落进兜底，而兜底建议「设就绪选择器 / 加滚动 / 重新学一次」——
    // 那是在教模型绕过一条**法律边界**
    const h = browseFailureHint('这个站点的权利人已经要求停止采集，我们不再抓取它。', true);
    expect(h).toContain('不要重试');
    expect(h).toContain('不要换网址');
    expect(h).toContain('这不是抓取失败，是不许抓');
    // 绝不能出现兜底那档的技术性建议
    expect(h).not.toContain('就绪选择器');
    expect(h).not.toContain('scrollScreens');
    expect(h).not.toContain('重新学一次');
  });

  it('🔒 与 SITE_STOPPED_REASON 的实际文案对得上（判据靠文案匹配，改一个字就失效）', () => {
    const h = browseFailureHint(SITE_STOPPED_REASON, true);
    expect(h).toContain('已经要求我们停止采集');
  });

  it('指路让站点权利人自己去撤回', () => {
    const h = browseFailureHint(SITE_STOPPED_REASON, true);
    expect(h).toContain('数据移除申请');
  });
});
