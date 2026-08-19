import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

// 插件版本号只有一个事实来源：manifest.json。
//
// 【为什么要一条测试】2026-08-07 体检时，设置页顶部的徽标还写着 `v0.5.8`，而 manifest 已经是
// 0.8.3——中间隔了七个版本。更糟的是**同一页**下方「版本与更新」那一行读的是真版本，
// 于是页面自己跟自己打架：用户不知道该信哪个，报障时报上来的版本号还是错的
// （「我用的 0.5.8」会把排查引到一条根本不存在的路上去）。
//
// 写死的版本号有个共同特征：**改的时候一定会忘**。发版脚本只动 manifest，
// HTML 里那份副本没有任何机制提醒你，于是它必然、且只会越来越旧。所以判据是
// 「HTML 里不许出现版本号字面量」，而不是「HTML 里的版本号要等于 manifest」——
// 后者仍然要求人手同步，只是把发现时间从用户投诉提前到 CI，治标不治本。

const EXT = resolve(process.cwd(), 'extension');
const manifest = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8')) as { version: string };

// 形如 v0.8.3 / v1.2 的版本徽标。放过 CSS 里的数值（1.5em、0.8s）——那些不带 v 前缀。
const VERSION_BADGE = /\bv\d+\.\d+(\.\d+)?\b/;

describe('插件版本号只从 manifest 读', () => {
  it('manifest 里有一个像样的版本号（守卫的基准）', () => {
    expect(manifest.version).toMatch(/^\d+\.\d+(\.\d+)?$/);
  });

  it('🔒 扩展页面的 HTML 里没有写死的版本号', () => {
    const pages = readdirSync(EXT).filter((f) => f.endsWith('.html'));
    expect(pages.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const page of pages) {
      readFileSync(join(EXT, page), 'utf8').split('\n').forEach((line, i) => {
        // 注释里可以提版本号（讲历史用），只查真正会渲染出来的内容
        if (/^\s*(<!--|\/\/|\*)/.test(line)) return;
        const m = line.match(VERSION_BADGE);
        if (m) offenders.push(`${page}:${i + 1}  ${m[0]}`);
      });
    }
    expect(
      offenders,
      `这些地方写死了版本号，请改成运行时读 chrome.runtime.getManifest().version：\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('设置页顶部徽标确实是运行时填的', () => {
    expect(readFileSync(join(EXT, 'options.html'), 'utf8')).toContain('id="brandVersion"');
    expect(readFileSync(join(EXT, 'options.js'), 'utf8')).toContain('getManifest().version');
  });
});
