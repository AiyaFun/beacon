import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { loadParserSources, loadBackendSources, loadRecipeRunner } from '@/lib/browser/local-collect';
import { SELF_PROFILE_PLATFORMS, SELF_BACKEND_PLATFORMS } from '@/lib/browser-task/kinds';


// 2026-09-04 真机：桌面执行器把浏览器拉起来了、任务也领到了，却卡在
// 「这个安装包里没有带插件解析器文件（extension/content）」——因为 Dockerfile 的运行阶段
// 是**逐个 COPY 的白名单**，extension/ 从来没被拷进去。本地跑一切正常（文件就在仓库里），
// 只有生产容器里没有。这类「本地有、镜像没有」的洞只能靠机器判据挡。
describe('🔒 执行器要的解析器必须随镜像发出去', () => {
  it('Dockerfile 的运行阶段拷了 extension/content', () => {
    const df = fs.readFileSync(path.join(process.cwd(), 'Dockerfile'), 'utf8');
    const stage = df.lastIndexOf('FROM ');
    expect(stage, 'Dockerfile 里没有 FROM——slice(-1) 会切出整个文件让下一条恒绿').toBeGreaterThan(0);
    const runtime = df.slice(stage);
    expect(runtime, 'Dockerfile 运行阶段没拷 extension/content：/api/ingest/executor 在生产会恒失败')
      .toMatch(/COPY\s+--from=builder\s+\/app\/extension\/content\s+\.\/extension\/content/);
  });

  it('每个能派自有回填的平台都真的读得出解析器', () => {
    for (const p of SELF_PROFILE_PLATFORMS) {
      const r = loadParserSources(p);
      expect(r.ok, `${p} 的解析器读不出来：${r.ok ? '' : r.error}`).toBe(true);
      if (r.ok) expect(r.scripts.length, `${p} 的脚本包是空的`).toBeGreaterThanOrEqual(2);
    }
  });

  // 2026-09-16：桌面客户端也进创作者后台、也按配方采——后台脚本与配方执行器同样要随镜像发出去
  it('Dockerfile 的运行阶段也拷了 extension/tools（配方执行器 recipe-run.js 在那儿）', () => {
    const df = fs.readFileSync(path.join(process.cwd(), 'Dockerfile'), 'utf8');
    const runtime = df.slice(df.lastIndexOf('FROM '));
    expect(runtime).toMatch(/COPY\s+--from=builder\s+\/app\/extension\/tools\s+\.\/extension\/tools/);
  });

  it('每个创作者后台平台都读得出后台脚本包，且 self-backend.js 排在最后（可选模块要先把配置放进 __beaconBackendExtras）', () => {
    for (const p of SELF_BACKEND_PLATFORMS) {
      const r = loadBackendSources(p);
      // 公众号是可选模块：这个树里有文件就该读得出；没有就该如实拒绝，而不是给一个少了配置的脚本包
      const hasWechat = fs.existsSync(path.join(process.cwd(), 'extension/content/self-backend-wechat.js'));
      if (p === 'wechat' && !hasWechat) { expect(r.ok).toBe(false); continue; }
      expect(r.ok, `${p} 的后台脚本读不出来：${r.ok ? '' : r.error}`).toBe(true);
      if (r.ok) {
        expect(r.scripts.length).toBeGreaterThanOrEqual(3);
        expect(r.scripts[r.scripts.length - 1]).toContain('__beaconBackendProbe');
        if (p === 'wechat') expect(r.scripts[r.scripts.length - 2]).toContain('__beaconBackendExtras');
      }
    }
    expect(loadBackendSources('x').ok, 'X 没有创作者后台').toBe(false);
  });

  it('配方执行器读得出，且包成「给 recipe 就返回结果」的函数（插件那份 recipe-run.js 原样包一层）', () => {
    const r = loadRecipeRunner();
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (r.ok) {
      expect(r.fn.startsWith('(recipe) => { window.__beaconRecipe = recipe; return (')).toBe(true);
      expect(r.fn).toContain("mode: 'learn'");
      expect(r.fn).toContain("mode: 'scrape'");
    }
  });
});
