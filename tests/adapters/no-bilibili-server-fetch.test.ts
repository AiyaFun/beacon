import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// B 站**没有服务端适配器**，这是刻意的（2026-09-02 删掉 BilibiliAdapter 时钉住）：
//   · api.bilibili.com/robots.txt 是 Disallow: /——服务端直连它违反本项目自己的 robots 规矩；
//   · 它的 wbi 签名是技术措施本身，算签名 = 规避技术措施（与去伪装 UA 是同一条理由）。
// 这条替代了原来的 competitor-real-honesty.test.ts（那份守的是「B 站适配器失败要响」，
// 适配器没了，守卫也换成「不许再长出来」）。

const ROOT = process.cwd();
function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(f)) out.push(p);
  }
  return out;
}

describe('🔒 服务端不许直连 api.bilibili.com', () => {
  it('lib/ 与 app/ 里没有任何 api.bilibili.com 的调用（插件那侧是用户自己的浏览器，不在此列）', () => {
    // 先剥注释再断言：拒绝实现的理由（写着这个域名）必须留在注释里，守的是代码
    const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const hits = [...walk(join(ROOT, 'lib')), ...walk(join(ROOT, 'app'))]
      .filter((p) => /api\.bilibili\.com/.test(strip(readFileSync(p, 'utf8'))))
      .map((p) => p.slice(ROOT.length + 1));
    expect(hits, '服务端出现了 api.bilibili.com').toEqual([]);
  });

  it('BilibiliAdapter / BEACON_BILIBILI_ENABLED 不再存在', () => {
    const src = readFileSync(join(ROOT, 'lib/adapters/competitor-real.ts'), 'utf8');
    expect(src).not.toMatch(/class BilibiliAdapter/);
    expect(src).not.toMatch(/BEACON_BILIBILI_ENABLED/);
  });
});
