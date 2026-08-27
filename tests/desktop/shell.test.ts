import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// 桌面壳（Tauri 2）的三条契约。壳是独立子项目，vitest 不跑 Rust——
// 这里守的是「别人改文件时最容易顺手破坏、破坏后又完全静默」的三处。
const root = join(__dirname, '..', '..');

describe('桌面壳契约', () => {
  it('引导页必须用 no-cors 探测 /api/health（改成普通 fetch 会被跨源拦死，壳永远“没连上”）', () => {
    const html = readFileSync(join(root, 'desktop/ui/index.html'), 'utf8');
    expect(html).toMatch(/\/api\/health/);
    // 注意钉的是 fetch 选项本身，不是注释里的字样（注释也写了 no-cors，会骗过宽断言）
    expect(html).toMatch(/mode: 'no-cors'/);
    // 端口可覆盖：整机版允许改 BEACON_PORT，壳靠 ?port= 跟上
    expect(html).toMatch(/URLSearchParams\(location\.search\)\.get\('port'\)/);
  });

  it('关窗必须收进托盘而不是退出（服务在后台，窗口只是视图）', () => {
    const rs = readFileSync(join(root, 'desktop/src-tauri/src/main.rs'), 'utf8');
    expect(rs).toMatch(/CloseRequested/);
    // 带调用括号：裸 /prevent_close/ 会被改名成 prevent_closeX 之类的子串骗过
    expect(rs).toMatch(/api\.prevent_close\(\)/);
    expect(rs).toMatch(/window\.hide\(\)/);
  });

  it('desktop 目录绝不进 Docker 构建上下文（src-tauri/target 近 1GB，会撑爆服务器构建）', () => {
    const ignore = readFileSync(join(root, '.dockerignore'), 'utf8');
    const lines = ignore.split('\n').map((l) => l.trim());
    expect(lines).toContain('desktop');
  });
});
