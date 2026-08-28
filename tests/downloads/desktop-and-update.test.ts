import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pickDesktopBuild, DESKTOP_OS_LABEL, type DesktopManifest } from '@/lib/downloads';
import { NAV, reachableRoutes } from '@/lib/nav';

// 桌面客户端下载 + 整机版一键增量更新（2026-08-27）。
//
// 这一批里**最危险的一段是更新链路**：它会下载代码并在客户机器上执行。
// 六道闸（形态/角色/来源钉死/sha256/不许降级/单例）任何一道被摘掉都是可远程打穿的洞，
// 所以每一道都在这里源码级钉死——它们大多没法在单测里真跑（真跑=真更新一台机器）。

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

afterEach(() => vi.unstubAllEnvs());

describe('下载入口不会指向空气', () => {
  it('/desktop 有侧栏入口（不是孤儿页）', () => {
    const hrefs = new Set(NAV.flatMap((g) => g.items.map((i) => i.href)));
    expect(hrefs.has('/desktop') || reachableRoutes(NAV).has('/desktop')).toBe(true);
  });

  it('清单读不到时不渲染侧栏下载卡（点进去是空页面比没入口糟）', () => {
    const shell = read('components/TenantShell.tsx');
    expect(shell).toMatch(/if \(!m\) return undefined;/);
    const bar = read('components/TaskSidebar.tsx');
    expect(bar).toMatch(/\{desktop && <DesktopDownloadCard/);
  });

  it('缺某个平台的包时只说明、不放下载按钮', () => {
    const page = read('app/(app)/desktop/page.tsx');
    // 有包才渲染 <a download>，没包走的是纯文字分支
    expect(page).toMatch(/list\.length === 0 \? \(/);
    expect(page).toMatch(/还没有 \{DESKTOP_OS_LABEL\[os\]\} 安装包/);
  });

  it('未签名要如实写明（不写用户会以为包坏了）', () => {
    const page = read('app/(app)/desktop/page.tsx');
    expect(page).toContain('没有代码签名');
    expect(page).toContain('右键');
    expect(page).toContain('SmartScreen');
  });
});

describe('pickDesktopBuild：猜不出就不猜', () => {
  const m: DesktopManifest = {
    name: 'x', version: '1.0.0',
    builds: [
      { os: 'mac', arch: 'aarch64', file: '/a.dmg', ext: 'dmg', sizeMB: 1, sha256: 'x' },
      { os: 'win', arch: 'x64', file: '/a.msi', ext: 'msi', sizeMB: 1, sha256: 'y' },
    ],
  };

  it('Mac UA → mac 包；Windows UA → win 包', () => {
    expect(pickDesktopBuild(m, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')?.os).toBe('mac');
    expect(pickDesktopBuild(m, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')?.os).toBe('win');
  });

  it('Linux / 无 UA / 无清单 → null（不硬塞一个装不上的包）', () => {
    expect(pickDesktopBuild(m, 'Mozilla/5.0 (X11; Linux x86_64)')).toBeNull();
    expect(pickDesktopBuild(m, null)).toBeNull();
    expect(pickDesktopBuild(null, 'Macintosh')).toBeNull();
  });

  it('同平台多架构时不猜（Mac 的 UA 区分不出 M 芯片与 Intel）', () => {
    const two: DesktopManifest = {
      ...m,
      builds: [
        { os: 'mac', arch: 'aarch64', file: '/a.dmg', ext: 'dmg', sizeMB: 1, sha256: 'x' },
        { os: 'mac', arch: 'x64', file: '/b.dmg', ext: 'dmg', sizeMB: 1, sha256: 'y' },
      ],
    };
    expect(pickDesktopBuild(two, 'Macintosh; Intel Mac OS X')).toBeNull();
  });

  it('DESKTOP_OS_LABEL 两个平台都有说法', () => {
    expect(DESKTOP_OS_LABEL.mac).toBeTruthy();
    expect(DESKTOP_OS_LABEL.win).toBeTruthy();
  });
});

describe('🔒 更新链路六道闸（摘掉任何一道都是可远程打穿的洞）', () => {
  const lib = () => read('lib/appliance/update.ts');
  const sh = () => read('deploy/appliance/update.sh');

  it('闸①形态：check 与 start 都 assertCan', () => {
    const s = lib();
    expect(s.match(/assertCan\('passwordLogin'\)/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('闸②角色：两个 action 都要 byok.manage', () => {
    const a = read('app/(app)/desktop/actions.ts');
    expect(a.match(/requireRole\(s, 'byok\.manage'\)/g)?.length).toBe(2);
  });

  it('闸③来源钉死：updateOrigin 只读 env/常量，startApplianceUpdate 不收 URL 参数', () => {
    const s = lib();
    expect(s).toMatch(/process\.env\.BEACON_UPDATE_ORIGIN/);
    // 函数签名不许有参数——收了参数就是「谁能调这个 action，谁就能让客户机器执行他的代码」
    expect(s).toMatch(/export async function startApplianceUpdate\(\): Promise<StartUpdate>/);
    expect(s).toMatch(/export async function checkApplianceUpdate\(\): Promise<UpdateCheck>/);
    // 起脚本时也不许把 URL 拼进 argv
    expect(s).toMatch(/spawn\('bash', \[script, '--fetch'\]/);
    // shell 侧同样只认 env/默认值，不认命令行传 URL
    expect(sh()).toMatch(/ORIGIN="\$\{BEACON_UPDATE_ORIGIN:-https:\/\/beacon\.iyunci\.cn\}"/);
  });

  it('闸④sha256：脚本里校验与解包对的是同一个文件，且不一致必须 die', () => {
    const s = sh();
    expect(s).toMatch(/shasum -a 256 "\$TMP\/pkg\.tar\.gz"|sha256sum "\$TMP\/pkg\.tar\.gz"/);
    expect(s).toMatch(/\[ "\$GOT" = "\$NEW_SHA" \] \|\| die/);
    // 解包的必须是刚校验过的那一个文件
    expect(s).toMatch(/tar -xzf "\$TMP\/pkg\.tar\.gz"/);
    // 校验必须在解包之前（顺序反了等于没校验）
    expect(s.indexOf('"$GOT" = "$NEW_SHA"')).toBeLessThan(s.indexOf('tar -xzf "$TMP/pkg.tar.gz"'));
  });

  it('闸⑤不许降级/同版：hasUpdate 为假时拒绝', () => {
    expect(lib()).toMatch(/if \(!check\.hasUpdate\)/);
    expect(sh()).toMatch(/\[ "\$CUR_VER" != "\$NEW_VER" \] \|\| die/);
  });

  it('闸⑥单例：state 文件在就拒绝再起一次', () => {
    expect(lib()).toMatch(/existsSync\(join\(root, UPDATE_STATE_FILE\)\)/);
    // 脚本必须保证异常退出也清掉状态文件，否则下次更新被永久挡住
    expect(sh()).toMatch(/trap .*cleanup.* EXIT/);
  });
});

describe('🔒 覆盖时绝不动用户的密钥与数据', () => {
  it('rsync 排除 .env / 数据库 / 证书', () => {
    const s = read('deploy/appliance/update.sh');
    const rsyncBlock = s.slice(s.indexOf('rsync -a'), s.indexOf('|| die "覆盖失败"'));
    for (const must of ['.env', '.env.*', 'prisma/*.db', 'deploy/certs', 'node_modules']) {
      expect(rsyncBlock, `rsync 缺 --exclude ${must}`).toContain(`--exclude '${must}'`);
    }
  });

  it('打包侧同样不把这些打进包（两层都拦，任一层写错都不可逆）', async () => {
    // 从常量模块取，**不 import 打包脚本**——那是顶层就执行的脚本，
    // import 它等于在测试里真打一次包（产物每跑一次测试就变一次，真发生过）
    const { APPLIANCE_EXCLUDE } = await import('@/lib/appliance/package-exclude');
    for (const must of ['.env', '.env.*', 'prisma/*.db', 'deploy/certs', 'node_modules', '.git']) {
      expect(APPLIANCE_EXCLUDE, `打包排除清单缺 ${must}`).toContain(must);
    }
  });

  it('打包脚本用的是那份共享清单，没有自己抄一份（抄一份必漂移）', () => {
    const s = read('scripts/pack-appliance.ts');
    expect(s).toMatch(/import \{ APPLIANCE_EXCLUDE \} from '\.\.\/lib\/appliance\/package-exclude'/);
    expect(s).not.toMatch(/const APPLIANCE_EXCLUDE\s*=/);
  });

  it('打包脚本打完真的翻一遍包（写了 --exclude 不等于生效）', () => {
    const s = read('scripts/pack-appliance.ts');
    expect(s).toMatch(/tar', \['-tzf'/);
    expect(s).toMatch(/leaked\.length > 0/);
    expect(s).toMatch(/rmSync\(outPath, \{ force: true \}\)/); // 发现泄漏要删掉产物，不能留在那儿等人误发
  });
});

describe('🔒 自我覆盖防护：rsync 会覆盖运行中的 update.sh', () => {
  it('--fetch 模式先把自己复制到临时文件再 exec（bash 边读边执行）', () => {
    const s = read('deploy/appliance/update.sh');
    expect(s).toMatch(/BEACON_UPDATE_REEXEC/);
    expect(s).toMatch(/exec bash "\$SELF_COPY"/);
    // re-exec 之后 BASH_SOURCE 不再指向工程目录，ROOT 必须能被 env 带过去
    expect(s).toMatch(/ROOT="\$\{BEACON_UPDATE_ROOT:-/);
  });
});

describe('桌面壳：双模式（此前写死 localhost，SaaS 用户装了打不开）', () => {
  const html = () => read('desktop/ui/index.html');

  it('本机探不到时给云端/自建的出口，不是只留一句「服务没在跑」', () => {
    const s = html();
    // 【必须钉 id="..." 而不是裸字符串】裸字符串在下面的 $('pick-cloud') 里也出现一次，
    // 把按钮的 id 改掉、界面上那个出口没了，裸匹配照样绿（mutation 当场抓到的假绿）
    expect(s).toMatch(/id="pick-cloud"/);
    expect(s).toMatch(/id="custom-go"/);
    expect(s).toMatch(/id="pick-local"/);
    // 光有按钮不够，得真的接上处理函数
    expect(s).toMatch(/\$\('pick-cloud'\)\.onclick/);
    expect(s).toMatch(/localStorage/); // 选过要记住
  });

  it('记住的地址仍然要探活（记着一个连不上的地址直接跳过去=用户看到浏览器错误页）', () => {
    const s = html();
    expect(s).toMatch(/if \(await alive\(saved\)\) return enter\(saved\)/);
    expect(s).toMatch(/id="reset"/); // 连不上要能换
    expect(s).toMatch(/\$\('reset'\)\.onclick/);
  });

  it('整机版用户零改变：首屏仍先探本机、通了直接进', () => {
    const s = html();
    expect(s).toMatch(/if \(await alive\(LOCAL\)\) return enter\(LOCAL\)/);
  });
});

describe('产物与清单', () => {
  it('打包脚本都挂进了 npm scripts', () => {
    const p = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(p.scripts['pack:desktop']).toContain('pack-desktop');
    expect(p.scripts['pack:appliance']).toContain('pack-appliance');
  });

  it('appliance 清单若已生成，字段齐全且 sha256 是 64 位十六进制', () => {
    const p = join(process.cwd(), 'public', 'downloads', 'appliance.manifest.json');
    if (!existsSync(p)) return; // 还没打包：不强求（CI 上可能没跑过 pack）
    const m = JSON.parse(readFileSync(p, 'utf8')) as { version: string; file: string; sha256: string };
    expect(m.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(m.file).toMatch(/^\/downloads\/beacon-appliance-.+\.tar\.gz$/);
    expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('🔒 每次部署都刷新增量更新包（不靠人记得）', () => {
  // 病灶：整机版客户点「一键更新」读的是 appliance.manifest.json，它描述的是**打包那一刻**的代码。
  // 忘了重打就部署 → 站上挂旧包 → 版本号没变时客户查到「已经是最新版」，新修的东西永远到不了
  // 他机器上。这类错不报错、不变红，只会安静地让升级通道失效。
  // 所以两层：本地 deploy-prepare.sh 无条件重打 + 服务端闸门兜底拦「漏跑」。

  it('deploy-prepare.sh 无条件重打更新包（不做「有没有变」的判断）', () => {
    const s = read('scripts/deploy-prepare.sh');
    expect(s).toMatch(/npm run --silent pack:appliance/);
    // 桌面包相反：没有构建产物时必须跳过，硬打会把已有清单清空
    expect(s).toMatch(/跳过（站上保留现有清单）/);
  });

  it('闸门里有「分发产物」这一道，且拦三种硬错', () => {
    const s = read('scripts/deploy-gate.sh');
    expect(s).toMatch(/闸门 2\/4：分发产物/);
    expect(s).toMatch(/缺 \$MF/);                 // 清单不存在
    expect(s).toMatch(/更新包版本对不上/);          // package.json 与清单版本不一致
    expect(s).toMatch(/但文件不在（rsync 漏传/);    // 清单指向的 tar 包没传到
  });

  it('这道闸必须排在需要容器/数据库的闸门之前（旧镜像没起来时也要能报出来）', () => {
    const s = read('scripts/deploy-gate.sh');
    expect(s.indexOf('闸门 2/4：分发产物')).toBeLessThan(s.indexOf('WEB_ID='));
    expect(s.indexOf('WEB_ID=')).toBeLessThan(s.indexOf('闸门 3/4：schema 漂移'));
  });

  it('产物与清单一律不进 git（一个 dmg 6MB、更新包 13MB，进了公开历史就删不掉）', () => {
    const ig = read('.gitignore');
    for (const p of [
      'public/downloads/*.dmg', 'public/downloads/*.exe', 'public/downloads/*.msi',
      'public/downloads/*.tar.gz',
      'public/downloads/desktop.manifest.json', 'public/downloads/appliance.manifest.json',
    ]) {
      expect(ig, `.gitignore 缺 ${p}`).toContain(p);
    }
  });
});
