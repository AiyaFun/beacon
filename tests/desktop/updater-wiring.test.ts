import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { at, orderedBefore } from '../helpers/anchor';

// 桌面一键更新（2026-09-01）的接线守卫。这条链路会**下载代码并在客户机器上执行**，
// 它的每个环节都值得一颗钉子：
//   conf 钉公钥与端点 → main.rs 查+装 → CI 用一次性钥匙走流程 → 打包机用真钥匙重签。
const ROOT = process.cwd();
const conf = JSON.parse(readFileSync(join(ROOT, 'desktop/src-tauri/tauri.conf.json'), 'utf8')) as {
  version: string;
  bundle: { createUpdaterArtifacts?: boolean };
  plugins?: { updater?: { pubkey?: string; endpoints?: string[] } };
};
const MAIN = readFileSync(join(ROOT, 'desktop/src-tauri/src/main.rs'), 'utf8');
const PACK = readFileSync(join(ROOT, 'scripts/pack-desktop.ts'), 'utf8');
const CI = readFileSync(join(ROOT, '.cnb.yml'), 'utf8'); // 2026-09-01 起 Windows 包走 cnb 自托管 runner，不再用 GitHub Actions

describe('桌面一键更新 · 接线', () => {
  it('🔒 conf：公钥 + 端点 + createUpdaterArtifacts 三件齐', () => {
    expect(conf.plugins?.updater?.pubkey, 'conf 没钉公钥——更新器无从校验签名').toBeTruthy();
    expect(conf.plugins?.updater?.endpoints?.[0]).toBe('https://beacon.iyunci.cn/downloads/desktop-update.json');
    expect(conf.bundle.createUpdaterArtifacts, '不出更新工件，端点永远是空的').toBe(true);
  });

  it('🔒 客户端信任的公钥绝不能是 CI 一次性钥匙的公钥', () => {
    // CI 里的钥匙就在仓库明面上（desktop/ci-throwaway-updater.key）——谁都拿得到。
    // conf 公钥若与它配对，任何人都能给全体客户端签「合法」更新 = 远程代码执行。
    const throwawayPub = readFileSync(join(ROOT, 'desktop/ci-throwaway-updater.key.pub'), 'utf8').trim();
    expect(conf.plugins!.updater!.pubkey!.trim()).not.toBe(throwawayPub);
  });

  it('🔒 打包机上：conf 公钥必须与真钥匙配对（钥匙在场才验，别的机器跳过）', () => {
    const home = process.env.HOME ?? '';
    const realPub = join(home, '.beacon-signing/tauri-updater.key.pub');
    if (!existsSync(realPub)) return; // 非打包机
    expect(conf.plugins!.updater!.pubkey!.trim()).toBe(readFileSync(realPub, 'utf8').trim());
  });

  it('🔒 main.rs：注册了 updater 插件并在启动后台查（查失败静默、装失败必须说话）', () => {
    at(MAIN, 'tauri_plugin_updater::Builder::new().build()');
    at(MAIN, 'check_and_prompt_update');
    // 查不到/没更新 → 直接 return（不弹窗）；这行在任何 dialog 之前
    orderedBefore(MAIN, '_ => return, // 没更新或没查到，都安静', '.blocking_show()');
    // 用户点了「现在更新」之后的失败必须可见
    at(MAIN, '更新没装上');
  });

  it('🔒 pack 脚本：更新工件一律真钥匙重签，钥匙缺席就硬停', () => {
    at(PACK, 'signWithRealKey');
    at(PACK, ".beacon-signing', 'tauri-updater.key'");
    // 文件里有多个 process.exit(1)（「没找到产物」那个在前面），必须锚在本函数体内找
    const gate = at(PACK, '⛔ 更新签名钥匙不在');
    at(PACK, 'process.exit(1)', gate); // 钥匙缺席的分支里确实硬停
    // 两个平台都要过真签名这道闸
    at(PACK, "darwin-");
    at(PACK, "windows-");
  });

  it('🔒 CI：用的是仓库里的一次性钥匙，不是任何 secret / 真钥匙', () => {
    at(CI, 'ci-throwaway-updater.key');
    expect(CI, 'CI 引用了 secrets 里的签名钥匙——违反「签名凭据不进 CI」').not.toMatch(/TAURI_SIGNING[^\n]*secrets\./);
    // 判执行内容前先剥掉 # 注释行——注释里*说明*真钥匙在哪是应该的，脚本里*摸*它才是违规
    //（「被自己的注释骗」是本项目假绿清单里的第五形，这里反着防一次误伤）
    const ciScript = CI.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    expect(ciScript, 'CI 脚本摸到了真钥匙的家（~/.beacon-signing）').not.toContain('.beacon-signing');
  });

  it('🔒 GitHub Actions 桌面构建已废止（2026-09-01 用户拍板改走 cnb）', () => {
    expect(existsSync(join(ROOT, '.github/workflows/desktop-build.yml')),
      'GitHub 桌面构建工作流又回来了——用户拍板过桌面包不再用 GitHub 构建').toBe(false);
  });

  it('🔒 pack 脚本有同发闸：换版本时平台变少 → 按兵不动', () => {
    // 2026-09-01 真发生：deploy-prepare 顺手跑 pack:desktop，把清单写成「1.2.5 只有 mac」——
    // 下载页当场少一个平台。规则是用户拍板的「两个一起发」。
    at(PACK, '同发闸');
    const gate = at(PACK, 'version !== prevVersion');
    // 锚死决定性判据本身（豁免环境变量那一句）——只锚 exit 的话，把条件改成 if(false)
    // 文本还在、闸已死（本条写完当场用这个变异验过一次，第一版就是这么逃逸的）
    at(PACK, "BEACON_DESKTOP_ALLOW_PLATFORM_DROP !== '1'", gate);
    at(PACK, 'process.exit(0)', gate); // 拦下时不写清单、不留孤儿文件、以 0 退出（不阻塞 web 部署）
    orderedBefore(PACK, '同发闸：v', 'const keep = version === prevVersion');
  });

  it('版本四处自洽由 version-parity 守卫（这里只确认 conf 版本是三段式）', () => {
    expect(conf.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
