import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { at, between } from '../helpers/anchor';

// 侧栏那张「客户端有新版」卡的文案（2026-09-01 用户截图反馈：
// 「这个点击一键升级，不会直接升级」）。
//
// 能不能自己更新，取决于**用户手上那一版**有没有更新器（1.2.5 起才有），
// 不是最新版有没有。两档说两种话，说错任何一种都在骗人：
//   · 老客户端被告知「会自动更新」→ 他等一辈子也等不到；
//   · 新客户端被劝「去下载覆盖安装」→ 把人推去走更差的那条路。
const SRC = readFileSync(join(process.cwd(), 'components/DesktopDownloadCard.tsx'), 'utf8');

describe('桌面客户端更新提示的文案分档', () => {
  it('🔒 判据用的是**客户端自己的版本**，不是最新版', () => {
    const line = between(SRC, 'const selfUpdating', ';');
    expect(line, '没按 client.version 判断 —— 换成别的量都会让某一档说错话').toContain('client.version');
    expect(line).toContain('SELF_UPDATE_SINCE');
  });

  it('🔒 分界线钉在 1.2.5（updater 进壳的那一版）', () => {
    expect(SRC).toMatch(/SELF_UPDATE_SINCE\s*=\s*'1\.2\.5'/);
  });

  it('🔒 老客户端：说要手动装，且必须说破「之后就自动了」', () => {
    // 只写「去下载覆盖安装」而不说后续，用户会以为这产品永远得手动升级——
    // 用户 2026-09-01 的原话正是冲着这个来的。
    const manual = between(SRC, 'return (\n      <div className="desktop-card">\n        <Link href="/desktop"', '</div>');
    expect(manual).toMatch(/手动/);
    expect(manual, '没说破「之后自动」——这正是用户反馈的那句话').toMatch(/之后.*自动|以后.*自动/);
  });

  it('🔒 新客户端：不给「去下载」的链接（那是更差的路）', () => {
    const auto = between(SRC, 'if (selfUpdating) {', '    }');
    expect(auto).toMatch(/自己提示|自动/);
    expect(auto, '给新客户端挂了下载链接 —— 等于把人从一键更新推回手动覆盖').not.toContain('href="/desktop"');
  });

  it('🔒 文件头的说明不许再写「桌面壳没有自动更新」（1.2.5 起已经有了）', () => {
    at(SRC, '1.2.5');
    expect(SRC).not.toContain('Tauri updater 插件没装');
  });
});
