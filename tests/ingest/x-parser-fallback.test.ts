import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { before } from '../helpers/anchor';

// 2026-09-04 真机（Chrome 152 + x.com）：X 把页面上的语义锚点**全部拆掉**了——
// document.querySelectorAll('[data-testid]').length === 0，也没有 [lang] / time[datetime] / [role=group]。
// 解析器全靠 data-testid 定位，于是 X 采集对所有人（插件与执行器）静默返回 0 条，
// 报出来的话却是「主页上没读到作品（可能这个号还没发过内容）」——与事实完全不符。
//
// 这里钉住两件事：① 认不到 testid 时退到裸 article（别整条链路瘫掉）；
// ② 退了之后如果一条内容都取不到，**宁可一条不采也不要产出空记录**——
// 空记录会进库、进基线、进榜单、喂给模型，比返回 0 条危险得多（见 beacon-mock-never-persisted）。
const src = fs.readFileSync(path.join(process.cwd(), 'extension/content/x.js'), 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('🔒 X 解析器：锚点被拆掉之后仍然诚实', () => {
  it('testid 找不到推文时退到裸 article（退路只加不减）', () => {
    expect(code).toMatch(/article\[data-testid="tweet"\]/);
    expect(code, '没有裸 article 的退路：X 拆掉 testid 后整条链路返回 0 条').toMatch(/querySelectorAll\('article'\)/);
    expect(code).toMatch(/usingFallback/);
  });

  it('🔒 取不到正文的那一条直接丢掉，绝不产出空记录', () => {
    expect(code, '没有「没正文就跳过」的判据 —— 会把空壳作品写进库').toMatch(/if \(!text\) continue;/);
  });

  it('🔒 退路走了却一条都没解析出来时，报 parser_stale 而不是装作没有内容', () => {
    expect(code).toMatch(/error: 'parser_stale'/);
    // 判据必须同时要求「用了退路」「零结果」「页面上确实有节点」——少一条都会误报
    // 用 before()：锚点没了直接抛，不会用 -1 切出整个文件让下面三条恒绿（假绿第八形）
    const seg = before(code, "error: 'parser_stale'", 300);
    expect(seg).toMatch(/usingFallback/);
    expect(seg).toMatch(/posts\.length === 0/);
    expect(seg).toMatch(/tweetNodes\.length > 0/);
  });

  it('🔒 两条消费路径都把 parser_stale 翻成人话（不透出内部码）', () => {
    const lc = fs.readFileSync(path.join(process.cwd(), 'lib/browser/local-collect.ts'), 'utf8');
    expect(lc, 'COLLECT_FN 没把解析器自报的 error 透出来，会被当成 no_handle').toMatch(/payload && payload\.error/);
    expect(lc).toMatch(/parser_stale/);
    expect(lc).toMatch(/采集浏览器还没登录这个平台/);
    const ex = fs.readFileSync(path.join(process.cwd(), 'desktop/src-tauri/src/executor.rs'), 'utf8');
    expect(ex).toMatch(/"parser_stale"/);
    expect(ex).toMatch(/采集浏览器还没登录这个平台/);
    // 服务端也要兜一道：客户端要重装才更新，而站点改版随时发生。
    // 真机踩到客户端 1.2.8 把 parser_stale 原样交回，用户界面上就显示了这个词。
    const bt = fs.readFileSync(path.join(process.cwd(), 'lib/browser-task/index.ts'), 'utf8');
    expect(bt, '服务端没把执行器的内部错误码翻成人话').toMatch(/humanizeExecutorError/);
    expect(bt).toMatch(/parser_stale:/);
    const ct = bt.slice(bt.indexOf('export async function completeTask('));
    expect(ct.slice(0, 600), 'completeTask 没调用翻译，错误码会原样落库').toMatch(/humanizeExecutorError\(outcome\.error\)/);
  });
});
