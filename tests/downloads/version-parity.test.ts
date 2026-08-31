import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// 插件与桌面客户端的版本必须一致（2026-08-29 用户拍板）。
//
// 【为什么要统一】两个装在同一个人机器上的东西，一个 0.9.12 一个 1.2.2，
// 报障时说「我用的 1.2.2」根本分不清他说的是哪个。统一之后这句话才有信息量。
//
// 【统一的方向只有一个】插件往上追桌面。反过来是**降级**——
// 桌面更新通道有一道「不许降级」的闸，而 Chrome 应用商店也**只接受版本号递增**的上传。
// 把桌面从 1.2.2 改成 0.9.x，等于让已经装了 1.2.2 的用户永远收不到更新。
//
// 【必须说破的代价】锁死一致意味着：**只改了桌面、插件一个字没动，也要重新上架一次**，
// 而 Chrome 商店审核要好几天。这是用户明确要的取舍，写在这里免得将来有人以为是疏忽。
// 真要省这一次审核，正确做法是**两边一起发版**（改桌面时顺带把插件也带上），
// 而不是偷偷让版本号分叉。

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const json = <T>(p: string) => JSON.parse(read(p)) as T;

const SEMVER = /^\d+\.\d+\.\d+$/;

function cmp(a: string, b: string): number {
  const [x, y] = [a.split('.').map(Number), b.split('.').map(Number)];
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

describe('插件与桌面版本一致', () => {
  const ext = json<{ version: string }>('extension/manifest.json').version;
  const desk = json<{ version: string }>('desktop/package.json').version;

  it('两边都是规范的三段版本号', () => {
    expect(ext, '插件版本号形状不对').toMatch(SEMVER);
    expect(desk, '桌面版本号形状不对').toMatch(SEMVER);
  });

  it('🔒 版本号相等', () => {
    expect(
      ext,
      `插件 ${ext} 与桌面 ${desk} 版本不一致。统一的方向只有一个：`
      + '插件往上追桌面（反过来是降级，桌面更新通道有「不许降级」的闸，'
      + 'Chrome 商店也只接受递增上传）。改完记得重跑 npx tsx scripts/pack-extension.ts。',
    ).toBe(desk);
  });

  it('🔒 桌面那四处仍然自洽（统一版本不能把既有的四处一致性搞坏）', () => {
    const tauri = json<{ version: string }>('desktop/src-tauri/tauri.conf.json').version;
    const cargo = read('desktop/src-tauri/Cargo.toml').match(/^version = "([^"]+)"/m)?.[1];
    const shell = read('desktop/ui/index.html').match(/const CLIENT_VERSION = '([^']+)'/)?.[1];
    for (const [name, v] of [['tauri.conf.json', tauri], ['Cargo.toml', cargo], ['index.html', shell]] as const) {
      expect(v, `${name} 与 desktop/package.json 对不上`).toBe(desk);
    }
  });
});

describe('下载清单必须跟着版本走', () => {
  const ext = json<{ version: string }>('extension/manifest.json').version;
  const dl = json<{ version: string; zip: string; sha256: string }>('public/downloads/downloads.manifest.json');

  it('🔒 清单版本 = manifest 版本（改了版本没重打包，下载页会指向不存在的文件）', () => {
    expect(
      dl.version,
      '下载清单还是旧版本——改完 manifest 要重跑 npx tsx scripts/pack-extension.ts',
    ).toBe(ext);
  });

  it('🔒 清单里的 zip 真的存在（这个项目栽过一次：把旧包贴成新版，不报错还打印成功）', () => {
    const files = readdirSync(join(ROOT, 'public', 'downloads'));
    expect(files, `清单指向 ${dl.zip}，但这个文件不在 public/downloads 里`)
      .toContain(dl.zip.replace('/downloads/', ''));
  });

  it('🔒 sha256 是真算出来的，不是抄来的', async () => {
    const { createHash } = await import('node:crypto');
    const real = createHash('sha256')
      .update(readFileSync(join(ROOT, 'public', 'downloads', dl.zip.replace('/downloads/', ''))))
      .digest('hex');
    expect(dl.sha256, '清单里的 sha256 与真实文件对不上').toBe(real);
  });
});

describe('版本只能往前走', () => {
  it('🔒 桌面下载清单不许落后于源码版本（落后 = 用户下到的是旧包）', () => {
    const desk = json<{ version: string }>('desktop/package.json').version;
    const dm = json<{ version: string }>('public/downloads/desktop.manifest.json');
    // ⚠️ 允许清单**落后**——它指向的是真实存在的 dmg/exe 文件名与 sha256，
    // 源码升了版但还没打包时，清单就该停在上一版。
    // 但**绝不允许清单超前**：那意味着它指向一个还不存在、或内容对不上的包
    //（这个项目栽过一次：收集脚本把旧 exe 贴成新版，sha256 贴错且不报错）。
    expect(cmp(dm.version, desk), `下载清单 ${dm.version} 超前于源码 ${desk}`).toBeLessThanOrEqual(0);
  });
});
