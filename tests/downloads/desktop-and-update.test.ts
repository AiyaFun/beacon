import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pickDesktopBuild, DESKTOP_OS_LABEL, type DesktopManifest } from '@/lib/downloads';
import { NAV, reachableRoutes } from '@/lib/nav';

// 桌面客户端下载 + 整机版一键增量更新（2026-08-27）。
//
// 这一批里**最危险的一段是更新链路**：它会下载代码并在客户机器上执行。
// 六道闸（形态/角色/来源钉死/sha256/不许降级/单例）任何一道被摘掉都是可远程打穿的洞，
// 所以每一道都在这里源码级钉死——它们大多没法在单测里真跑（真跑=真更新一台机器）。

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
// 断言页面文案时必须先剥注释：2026-08-28 就栽过一次——守卫之所以绿，
// 只是因为「右键」两个字活在我自己写的注释里，正文其实没有。
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

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
    const page = read('app/(app)/desktop/DesktopView.tsx');
    // 有包才渲染 <a download>，没包走的是纯文字分支
    expect(page).toMatch(/list\.length === 0 \? \(/);
    expect(page).toMatch(/还没有 \{DESKTOP_OS_LABEL\[os\]\} 安装包/);
  });

  it('两个平台的安装提示各自说对（且断言只看界面文案，不看注释）', () => {
    // 【为什么要剥注释】2026-08-28 改文案时当场撞到：macOS 已签名公证、界面上
    // 「右键打开」那套绕行办法删掉了，而守卫照样绿——因为「右键」「SmartScreen」
    // 这些词还留在**代码注释**里。这就是「被自己的注释骗」那种假绿，
    // 守的是「用户看得见什么」，就必须先把注释剥掉再断言。
    const raw = read('app/(app)/desktop/DesktopView.tsx');
    const page = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // macOS：已签名+公证 → 说「直接双击」，**绝不能**再出现右键绕行那套
    expect(page).toContain('已签名并公证');
    expect(page).not.toContain('右键');

    // Windows：没签名 → 必须如实说，并把 SmartScreen 的三步写全（默认界面只有「不运行」）
    expect(page).toContain('没有代码签名');
    expect(page).toContain('更多信息');
    expect(page).toContain('仍要运行');
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

describe('🔒 签名凭据只许待在会被剥离的路径下', () => {
  // 2026-08-28 用户要求把 macOS 签名证书备份也存进 cnb（私有仓）。
  // 风险不在「私有仓存不存得」，而在**这个仓库的工作分支同时喂 cnb 和 GitHub**：
  // 发布走 `git read-tree -u --reset opensource-clean` 把整棵树搬过去再剥离，
  // 放错地方 = 私钥进公开仓库，而且 git 历史删不掉。
  // 所以放在 deploy/private/ 下——那个路径**本来就在剥离清单里**，不用新增机制。

  it('签名备份放在 deploy/private/ 下（该路径已在 GitHub 发布的剥离清单里）', () => {
    const dir = join(process.cwd(), 'deploy', 'private', 'signing');
    if (!existsSync(dir)) return; // 没存也行（本地可能清掉了），存了就必须在这个位置
    const push = read('.claude/skills/push.md');
    expect(push).toMatch(/git rm -r --cached[^\n]*deploy\/private/);
  });

  it('闸门会拦「签名凭据出现在生产机器上」（rsync 漏排除的兜底）', () => {
    // 2026-08-28 真发生过：部署技能的 rsync 少了 --exclude deploy/private，
    // 签名私钥被同步到公网服务器。文档改了还是会被忘，所以要有机器判据。
    const gate = read('scripts/deploy-gate.sh');
    expect(gate).toMatch(/deploy\/private\/signing/);
    expect(gate).toMatch(/die "签名私钥不该出现在公网机器上/);
    // 部署技能的 exclude 表也得有，否则每次同步上去再被闸门拦，等于每次部署都失败。
    // 技能装在用户主目录（不在仓库里），别的机器上可能没有——**不存在时明确跳过**，
    // 而不是让断言默默变成真（那就是「从不命中」型假绿）。
    const skillPath = join(homedir(), '.claude', 'skills', 'beacon-deploy', 'SKILL.md');
    if (existsSync(skillPath)) {
      expect(readFileSync(skillPath, 'utf8')).toMatch(/--exclude deploy\/private/);
    }
  });

  // ── 2026-08-31：同一件事又发生了一次，所以判据得换个地方 ──────────────
  //
  // 上面那条对 skill 的检查有个 `if (existsSync)` ——**那正是它这次没帮上忙的原因**。
  // exclude 清单只存在于 ~/.claude/skills/beacon-deploy/SKILL.md，而那个 skill 不在仓库里。
  // 换台机器、换个人、或者那个 skill 没装，清单就不存在，同一个错原样再犯：
  // 签名私钥又被 rsync 到了公网服务器（闸门拦住了构建，但那时它已经落盘 70 秒）。
  //
  // 判据从「某个 skill 里写没写」搬到「仓库里有没有这份清单」——它才会跟着代码走。
  it('🔒 排除清单在仓库里，不依赖某个 skill 装没装', () => {
    const list = read('deploy/rsync-exclude.txt');
    expect(list, '签名凭据目录不在排除清单里——这正是两次事故的直接原因')
      .toMatch(/^deploy\/private$/m);
    for (const must of ['.env', '.next-verify', 'deploy/xray-bin', 'deploy.config.json']) {
      expect(list, `${must} 不在排除清单里`).toContain(must);
    }
  });

  it('🔒 构建上下文也排掉（镜像层删不掉，烤进去就永远在）', () => {
    // Dockerfile 是 `COPY . .`：万一 deploy/private 出现在服务器上，
    // 下一次构建就会把私钥烤进镜像层。同一台机器上另一个项目的容器里
    // 就躺着一份两个月前烤进去的 Apple AuthKey——那份删不掉了。
    expect(read('.dockerignore'), '.dockerignore 没排 deploy/private').toMatch(/^deploy\/private$/m);
    expect(read('Dockerfile'), 'Dockerfile 不再是 COPY . . 了，这条守卫的前提要重新想')
      .toMatch(/^COPY \. \.$/m);
  });

  it('绝不提交明文私钥：只许有加密的 .p12 与公开的 .cer', () => {
    const dir = join(process.cwd(), 'deploy', 'private', 'signing');
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      expect(f, `${f} 看起来是明文私钥，绝不能进库`).not.toMatch(/\.(key|pem|p8)$/i);
    }
    // 逐个文件翻内容：PEM 私钥头是最后一道判据（改个扩展名就能骗过上面那条）
    for (const f of readdirSync(dir)) {
      const body = readFileSync(join(dir, f), 'latin1');
      expect(body, `${f} 内含 PEM 私钥`).not.toMatch(/-----BEGIN (RSA |EC )?PRIVATE KEY-----/);
    }
  });
});

// ── 下载入口的可发现性 + 页面得讲清楚差别（2026-08-28）────────────────────
// 起因：侧栏那张下载卡是可关闭的，关掉之后用户就再也找不到这一页了。
// 所以入口必须**同时**固定在设置菜单里（账号菜单从 nav 的「设置」组渲染），
// 且标签要一眼看得出是下载，不能只写「桌面客户端」让人以为是台什么设备。
describe('下载客户端的入口与说明', () => {
  it('设置组里有 /desktop，且标签写明是下载', () => {
    const nav = read('lib/nav.ts');
    const settings = nav.slice(nav.indexOf("title: '设置'"));
    const line = settings.split('\n').find((l) => l.includes("href: '/desktop'"));
    expect(line, '/desktop 必须留在设置组里：侧栏卡片可关闭，它是关掉后唯一的入口').toBeTruthy();
    expect(line!).toMatch(/label: '[^']*下载[^']*'/);
  });

  it('页面把「和网页有什么区别」讲清楚了', () => {
    const page = stripComments(read('app/(app)/desktop/DesktopView.tsx'));
    // 结论先行：功能一样、不装也不影响
    // 「功能一模一样」在卡片副标题里；正文那段解释 2026-08-29 按用户要求删掉了，
    // 结论靠副标题 + 下面的对照表承载，所以这里不再断言那段正文。
    expect(page).toContain('功能一模一样');
    // 对照表三列都在
    for (const col of ['网页版', '桌面客户端', '采集插件']) expect(page).toContain(col);
    // 最容易被误解的一条：客户端不能替代采集插件
    expect(page).toContain('客户端替代不了插件');
  });
});
