import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, between } from '../helpers/anchor';

// 「登记发布」不许抹掉插件已经采到的数（2026-08-30 修）。
//
// ── 缺陷 ──
// actBackfill 原来是：
//   const metricsJson = toJson({ views: v, likes: l, comments: 0, shares: 0 });
//   ... update: { metrics: metricsJson, needsBackfill: false }      // 整包替换
// 两个错叠在一起：
//   ① 表单只有播放量、点赞两个输入框（Backfill.tsx），comments/shares 的 0 是代码补的——
//      把「没问过」写成了「观测到 0」；
//   ② 整包替换会把插件已采到的 collects / danmaku / coins / completion / impressions /
//      sources 全部抹掉。
//
// 真实路径：用户先用插件回填过一条 B站作品（评论 122、收藏 34、完播 42%），
// 几天后看到 /data 顶部「N 篇缺发布链接」的提醒，去「登记发布」贴上同一条链接、
// 填播放和赞 → 命中 accountId_platformItemId 唯一键 → 那些数当场消失。
// 用户不会知道是自己那次「登记」干的。
//
// 同一文件 11 行之下的 actUpdateMetrics 写着一模一样的道理并且做对了：
//「不铺 prev 的话，用户手改一次播放量就会把这些字段整片抹掉」。
const ROOT = process.cwd();
const code = (p: string) => readFileSync(join(ROOT, p), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('actBackfill：只写表单真的问过的项，且合并已有值', () => {
  const src = code('app/(app)/data/actions.ts');
  const fn = between(src, 'export async function actBackfill', 'export async function');

  it('🔒 不再凭空写 comments / shares', () => {
    expect(fn, '表单没有这两个输入框，写 0 等于把「没问过」说成「观测到 0」')
      .not.toMatch(/comments:\s*0/);
    expect(fn).not.toMatch(/shares:\s*0/);
  });

  it('🔒 先读已有值再合并（不铺 prev 就是整片抹掉）', () => {
    expect(fn, '没有先查已有记录').toContain('publishRecord.findUnique');
    expect(fn, '没有铺 prev').toMatch(/\{\s*\.\.\.prev,/);
  });

  it('🔒 表单只覆盖它自己问的两项', () => {
    const m = /const merged: Metrics = \{ \.\.\.prev, ([^}]*) \}/.exec(fn);
    expect(m, '合并那一行的形状变了，这条守卫要跟着改').toBeTruthy();
    const keys = m![1].split(',').map((x) => x.split(':')[0].trim()).filter(Boolean);
    expect(keys.sort(), '覆盖的字段数对不上表单里的输入框数').toEqual(['likes', 'views']);
  });

  it('🔒 快照写合并后的完整值，不是只写这次填的两项', () => {
    // authoritativeMetrics 是**整份挑一条快照**、不做跨快照合并
    //（lib/insight/source-priority.ts:76-77）。只写 {views, likes} 的话，
    // 这条手填快照一旦当选权威，评论/收藏/完播就在整页上凭空消失。
    const snap = between(fn, 'performanceSnapshot.create', '});');
    expect(snap, '快照又只写了这次填的两项').not.toMatch(/toJson\(\{\s*views/);
    expect(snap).toContain('metricsJson');
  });

  it('🔒 needsBackfill 的口径没被改坏（没链接才算缺链接）', () => {
    expect(fn).toContain('needsBackfill: platformItemId === null');
  });

  it('这条纪律在同文件的另一个入口上早就写着（两处必须一致）', () => {
    const upd = between(src, 'export async function actUpdateMetrics', 'export async function');
    expect(upd, 'actUpdateMetrics 也退回不铺 prev 了').toMatch(/\.\.\.prev,/);
  });

  it('🔒 authoritativeMetrics 确实是整份挑一条（上面那条守卫的前提）', () => {
    // 前提没了就该重写那条守卫，而不是让它继续绿着
    const sp = code('lib/insight/source-priority.ts');
    expect(before(sp, 'return parseJson<Metrics>(pick ? pick.metrics : fallbackMetricsJson, {});', 200))
      .toContain('pickAuthoritativeSnapshot(snapshots, publishedAt)');
  });
});
