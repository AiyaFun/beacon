import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

// 两个从没真机校准过的内容脚本接上采集自学习回路的「写了没接」守卫（2026-09-15）。
//
// ── 背景 ──
// extension/content/publish-fill.js（往创作后台的表单里填标题/正文）和
// extension/content/comments.js（读屏幕上已显示的评论）的选择器都是照文档手写的，
// 没有一条经过真机校准。插件早就有一条自学习回路：采不到字段 → __beaconReportParseMiss
// 上传脱敏骨架 → 服务端学出选择器 → 规则包下发 → __beaconRuleSelectorsSync 同步读取。
// 但这条回路此前只有主解析器（common.js）在用，这两个脚本一直没接——
// 填不进去就一直填不进去，改版了也没人知道。
//
// ── 这里钉什么 ──
// 1. 字面量：scope / field 由服务端钉死（'publish' + publish.title/publish.body，
//    'comments' + comments.container/comments.item），改一个字服务端就认不出来。
// 2. 顺序：下发规则只做兜底，必须排在手写候选**之后**——下发规则是应急补丁，
//    不该盖过主解析器（common.js 里 beaconRuleSelectors 的原话）。
// 3. 发布按钮**不许**看学习规则：输入框选错了用户看得见、改得掉；按钮选错了是替用户
//    点了删除/退出或把半成品发出去，不可逆。
// 4. comments.js 必须保持同步：sw.js 读 `res?.result` 是同步取值，IIFE 一旦异步化，
//    返回的就是 Promise，整条采集链静默拿空。
// 5. 上报是旁路：两个脚本都要 typeof 守卫，common.js 缺席时主流程照常。

const ROOT = process.cwd();
const PUBLISH = readFileSync(resolve(ROOT, 'extension/content/publish-fill.js'), 'utf8');
const COMMENTS = readFileSync(resolve(ROOT, 'extension/content/comments.js'), 'utf8');

/**
 * 取一个两空格缩进的顶层函数声明（IIFE 里的一层）的整段源码，到它自己的 `\n  }` 为止。
 * 与 tests/ingest/comment-scope.test.ts 里取 extractText 的写法同一口径。
 */
function fnSource(src: string, name: string, file: string): string {
  const m = src.match(new RegExp(`\\n {2}(?:async )?function ${name}\\([\\s\\S]*?\\n {2}\\}`));
  if (!m) throw new Error(`没在 ${file} 里找到 function ${name}`);
  return m[0];
}

/** 剥掉行注释与块注释：断言要落在代码上，不能被一句「说明文字」撑绿。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** a 必须出现，且在 b 之前。 */
function expectBefore(src: string, a: string, b: string, why: string) {
  const ia = src.indexOf(a);
  const ib = src.indexOf(b);
  expect(ia, `没找到「${a}」`).toBeGreaterThan(-1);
  expect(ib, `没找到「${b}」`).toBeGreaterThan(-1);
  expect(ia, why).toBeLessThan(ib);
}

describe('publish-fill.js 接上了自学习回路', () => {
  const fill = stripComments(fnSource(PUBLISH, 'fillTask', 'publish-fill.js'));
  const code = stripComments(PUBLISH);

  it('三个字面量都在：同步读规则 + 两个字段名（服务端按这两个字段名下发）', () => {
    expect(code).toContain('__beaconRuleSelectorsSync');
    expect(fill).toContain("'publish.title'");
    expect(fill).toContain("'publish.body'");
  });

  it('上报走 __beaconReportParseMiss，scope 是 publish', () => {
    expect(code).toMatch(/__beaconReportParseMiss\(\s*platform,\s*'publish',/);
  });

  it('🔒 下发规则在手写候选之后才试（顺序不能反：下发规则是应急补丁，不该盖过主解析器）', () => {
    expectBefore(fill, 'pick(conf.title)', "learnedSelectors('publish.title')", '标题：学来的排在手写之前了');
    expectBefore(fill, 'pick(conf.body)', "learnedSelectors('publish.body')", '正文：学来的排在手写之前了');
    // learnedSelectors 真的是从规则包读的，不是个空壳
    expect(stripComments(fnSource(PUBLISH, 'learnedSelectors', 'publish-fill.js'))).toContain('__beaconRuleSelectorsSync(platform, field)');
  });

  it('🔒 上报发生在剪贴板降级之前，且降级文案一句没丢（报了不等于填上了）', () => {
    expectBefore(fill, "reportMiss('publish.title')", 'copyFallback(task)', '上报要在降级之前');
    expectBefore(fill, "reportMiss('publish.body')", 'copyFallback(task)', '上报要在降级之前');
    expect(fill).toContain('内容已复制到剪贴板，手动粘贴即可');
    expect(fill).toContain('只填进了');
    expect(PUBLISH).toContain('没认出发布按钮');
  });

  it('两个入口都有 typeof 守卫（common.js 缺席时填充照常）', () => {
    expect(code).toContain("typeof globalThis.__beaconRuleSelectorsSync !== 'function'");
    expect(code).toContain("typeof globalThis.__beaconReportParseMiss !== 'function'");
  });

  it('🔒 发布按钮不看学习规则（选错按钮不可逆，代价与输入框不对称）', () => {
    const btn = stripComments(fnSource(PUBLISH, 'findPublishButton', 'publish-fill.js'));
    expect(btn).not.toContain('__beaconRuleSelectorsSync');
    expect(btn).not.toContain('__beaconRuleSelectors');
    expect(btn).not.toContain('learnedSelectors');
    // 仍然是按文字认按钮
    expect(btn).toMatch(/PUBLISH_BUTTON_TEXT\.test\(/);
    expect(btn).toMatch(/PUBLISH_BUTTON_DENY\.test\(/);
  });
});

describe('comments.js 接上了自学习回路', () => {
  const code = stripComments(COMMENTS);
  const findContainer = stripComments(fnSource(COMMENTS, 'findContainer', 'comments.js'));
  const readItems = stripComments(fnSource(COMMENTS, 'readItems', 'comments.js'));

  it('两个字段名与 scope 都在（服务端按它们下发）', () => {
    expect(findContainer).toContain("'comments.container'");
    expect(readItems).toContain("'comments.item'");
    expect(code).toMatch(/__beaconReportParseMiss\(\s*platform,\s*'comments',/);
    expect(stripComments(fnSource(COMMENTS, 'learnedSelectors', 'comments.js'))).toContain('__beaconRuleSelectorsSync(platform, field)');
  });

  it('🔒 findContainer：手写 containers 先跑，学来的在后，两轮都空才上报', () => {
    expectBefore(findContainer, 'rules.containers', "learnedSelectors('comments.container')", '容器：学来的排在手写之前了');
    expectBefore(findContainer, "learnedSelectors('comments.container')", "reportMiss('comments.container'", '容器：上报要在学来的也试过之后');
  });

  it('🔒 readItems：手写 items 先跑，学来的在后，零命中才上报（以容器命中的选择器为根）', () => {
    expectBefore(readItems, 'rules.items', "learnedSelectors('comments.item')", '条目：学来的排在手写之前了');
    expectBefore(readItems, "learnedSelectors('comments.item')", "reportMiss('comments.item'", '条目：上报要在学来的也试过之后');
    expect(readItems).toMatch(/reportMiss\('comments\.item',\s*container\.sel\)/);
    // shadowRoot 容器（B站）不上报：按选择器从 document 取根拿到的是 shadow 宿主，骨架是空树
    expect(readItems).toMatch(/!container\.shadow[\s\S]{0,40}reportMiss\('comments\.item'/);
  });

  it('两个入口都有 typeof 守卫（executeScript 注入时 common.js 未必在）', () => {
    expect(code).toContain("typeof globalThis.__beaconRuleSelectorsSync !== 'function'");
    expect(code).toContain("typeof globalThis.__beaconReportParseMiss !== 'function'");
  });

  it('🔒 保持同步：不许出现 async / await，不许用异步版 __beaconRuleSelectors(', () => {
    // sw.js:collectComments 读 `res?.result` 是同步取值——IIFE 一旦 async，拿到的是 Promise。
    expect(code).not.toMatch(/\basync\b/);
    expect(code).not.toMatch(/\bawait\b/);
    expect(code).not.toMatch(/__beaconRuleSelectors\(/);
  });

  it('🔒 extractText 仍没有整条 textContent 兜底（学来的条目那条退路只住在 readItems 里）', () => {
    const extractText = stripComments(fnSource(COMMENTS, 'extractText', 'comments.js'));
    expect(extractText).not.toContain('textContent)');
    expect(extractText).not.toContain('root.textContent');
  });

  it('PLATFORM_RULES 六个平台一个不少（接回路不许顺手动这张表）', () => {
    const m = COMMENTS.match(/const PLATFORM_RULES = (\{[\s\S]*?\n {2}\});/);
    if (!m) throw new Error('没能取出 PLATFORM_RULES');
    const rules = vm.runInNewContext(`(${m[1]})`) as Record<string, unknown>;
    expect(Object.keys(rules).sort()).toEqual(['bilibili', 'douyin', 'tiktok', 'x', 'xiaohongshu', 'youtube']);
  });
});
