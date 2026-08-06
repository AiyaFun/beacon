import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { checkDataHealth } from '@/lib/insight/health-check';

// X 纯图/纯视频推文的标题（真机 2026-07-29 发现）。
//
// 原实现是 `text.slice(0,300) || '(无正文)'`：一个账号下所有没配文字的推文**全部同名**。
// 三个后果，一个比一个实际：
//   ① 数据页一整列「(无正文)」，用户认不出哪条是哪条；
//   ② 复盘与 AI 点评引用标题时，「《(无正文)》播放 1211」等于什么都没说；
//   ③ lib/insight/health-check 按标题查重（≥4 字参与判定），「(无正文)」正好 5 字
//      —— 两条纯图推文就被误报成「重复内容」，让用户去处理一个根本不存在的问题。
//
// 所以标题要「能认出来 + 互不相同 + 多次采集之间稳定」。

const COMMON = readFileSync(resolve(process.cwd(), 'extension/content/common.js'), 'utf8');
const X = readFileSync(resolve(process.cwd(), 'extension/content/x.js'), 'utf8');

type Payload = { posts: { platformItemId: string; title: string }[] } | null;

function run(body: string, url = 'https://x.com/aiya'): Payload {
  const dom = new JSDOM(`<html><body>${body}</body></html>`, { url });
  const context = vm.createContext({
    document: dom.window.document,
    location: dom.window.location,
    URLSearchParams: dom.window.URLSearchParams,
    chrome: { runtime: { onMessage: { addListener: () => {} }, sendMessage: () => Promise.resolve({}) }, storage: { sync: { get: () => Promise.resolve({}) } } },
    console, setTimeout,
  });
  vm.runInContext(COMMON, context);
  vm.runInContext(X, context);
  return (context.__beaconParse as () => Payload)();
}

// 一条推文的最小 DOM：id、发表时间、正文（可空）、媒体（可空）
function tweet(opts: { id: string; at?: string; text?: string; media?: string }) {
  return `
    <article data-testid="tweet">
      <a href="https://x.com/aiya/status/${opts.id}"></a>
      ${opts.at ? `<time datetime="${opts.at}"></time>` : ''}
      ${opts.text ? `<div data-testid="tweetText">${opts.text}</div>` : ''}
      ${opts.media ?? ''}
    </article>`;
}

const PHOTO = '<div data-testid="tweetPhoto"><img src="x.jpg"></div>';
const VIDEO = '<div data-testid="videoPlayer"></div>';
const POLL = '<div data-testid="cardPoll"></div>';

describe('X 无正文推文的标题', () => {
  it('有正文时照旧取正文（这条不能被改动波及）', () => {
    const p = run(tweet({ id: '1990000000000001234', at: '2026-07-27T09:00:00.000Z', text: '今天聊聊 Agent 的上下文管理' }));
    expect(p!.posts[0].title).toBe('今天聊聊 Agent 的上下文管理');
  });

  it('纯图推文 → 认得出是什么、哪天发的、哪一条', () => {
    const p = run(tweet({ id: '1990000000000004821', at: '2026-07-27T09:00:00.000Z', media: PHOTO }));
    expect(p!.posts[0].title).toBe('[图片] 07-27 #4821');
  });

  it('纯视频 / 投票 各自认出来', () => {
    expect(run(tweet({ id: '1990000000000009012', at: '2026-07-27T09:00:00.000Z', media: VIDEO }))!.posts[0].title)
      .toBe('[视频] 07-27 #9012');
    expect(run(tweet({ id: '1990000000000003456', at: '2026-07-26T09:00:00.000Z', media: POLL }))!.posts[0].title)
      .toBe('[投票] 07-26 #3456');
  });

  it('认不出媒体类型也不回到老样子（仍带日期与尾号）', () => {
    const p = run(tweet({ id: '1990000000000007777', at: '2026-07-27T09:00:00.000Z' }));
    expect(p!.posts[0].title).toBe('[无正文] 07-27 #7777');
  });

  it('没有 time 元素时省略日期，不产出 "undefined"/"NaN" 这种脏标题', () => {
    const p = run(tweet({ id: '1990000000000005555', media: PHOTO }));
    expect(p!.posts[0].title).toBe('[图片] #5555');
    expect(p!.posts[0].title).not.toMatch(/undefined|NaN|Invalid/);
  });

  it('🔒 同一天的两条纯图推文标题不同 —— 否则会被数据体检误报成「重复内容」', () => {
    const p = run(
      tweet({ id: '1990000000000001111', at: '2026-07-27T09:00:00.000Z', media: PHOTO }) +
      tweet({ id: '1990000000000002222', at: '2026-07-27T18:00:00.000Z', media: PHOTO }),
    );
    const titles = p!.posts.map((x) => x.title);
    expect(new Set(titles).size).toBe(2);

    // 直接拿去过一遍真正的查重逻辑：不该有 duplicate 告警
    const now = Date.parse('2026-07-29T00:00:00.000Z');
    const issues = checkDataHealth(
      titles.map((t, i) => ({
        id: `p${i}`, platform: 'x', title: t,
        publishedAt: new Date('2026-07-27T09:00:00.000Z'),
        needsBackfill: false, metrics: '{"views":100}', snapshots: [],
      })),
      now,
    );
    expect(issues.some((x) => x.kind === 'duplicate')).toBe(false);
  });

  it('🔒 老口径会被误判成重复 —— 用它反证上一条不是白测的', () => {
    const now = Date.parse('2026-07-29T00:00:00.000Z');
    const issues = checkDataHealth(
      ['(无正文)', '(无正文)'].map((t, i) => ({
        id: `p${i}`, platform: 'x', title: t,
        publishedAt: new Date('2026-07-27T09:00:00.000Z'),
        needsBackfill: false, metrics: '{"views":100}', snapshots: [],
      })),
      now,
    );
    expect(issues.some((x) => x.kind === 'duplicate')).toBe(true);
  });

  it('标题在多次采集之间稳定（同一条推文两次解析结果一致）', () => {
    const dom = tweet({ id: '1990000000000004821', at: '2026-07-27T09:00:00.000Z', media: PHOTO });
    expect(run(dom)!.posts[0].title).toBe(run(dom)!.posts[0].title);
  });
});
