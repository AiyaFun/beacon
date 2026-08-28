import Link from 'next/link';
import { headers } from 'next/headers';
import { Card, Stat } from '@/components/ui';
import { HubHeader } from '@/components/HubHeader';
import { Icon } from '@/components/icons';
import { can } from '@/lib/edition';
import { getSession } from '@/lib/session';
import { can as canRole } from '@/lib/rbac';
import {
  readDesktopManifest, pickDesktopBuild, readApplianceManifest,
  DESKTOP_OS_LABEL, type DesktopBuild,
} from '@/lib/downloads';
import { ApplianceUpdateCard } from './ApplianceUpdateCard';
import pkg from '@/package.json';

export const dynamic = 'force-dynamic';

// 桌面客户端下载页（2026-08-27）。
//
// 【一个包，两种用法】壳是双模式的（desktop/ui/index.html）：探到本机整机版就进本机，
// 探不到就让用户选云端账号或自建地址。所以这一页对 SaaS 用户与整机版客户都成立——
// 此前壳写死 localhost:3070，SaaS 用户装了只会看到「本机服务还没在跑」。
//
// 【只给真实存在的包放按钮】Tauri 不能交叉编译：Mac 包只能在 Mac 上出、Win 包只能在
// Win 上出，所以某个平台缺席是常态。缺的那个如实写「还没有」，绝不放一个 404 的按钮。

function osIcon(os: DesktopBuild['os']): string {
  return os === 'mac' ? '🍎' : '🪟';
}

function archLabel(arch: string): string {
  return arch === 'aarch64' ? 'Apple 芯片 (M 系列)' : 'Intel / x64';
}

export default async function DesktopPage() {
  const s = await getSession();
  const m = readDesktopManifest();
  const ua = (await headers()).get('user-agent');
  const recommended = pickDesktopBuild(m, ua);

  // 本机服务的一键更新只对整机版/私有化有意义：SaaS 的服务在我们机房，
  // 用户既没有那台机器也不该有那个按钮
  const localService = can('passwordLogin'); // appliance / private（与本机形态同一批）
  const appliance = localService ? readApplianceManifest() : null;
  const canUpdate = canRole(s.role, 'byok.manage'); // owner/admin：与密钥同级

  const builds = m?.builds ?? [];
  const macBuilds = builds.filter((b) => b.os === 'mac');
  const winBuilds = builds.filter((b) => b.os === 'win');

  return (
    <>
      <HubHeader
        title="桌面客户端"
        hint="独立窗口、托盘常驻、开机自启 · 装不装都不影响功能，浏览器里一样用"
        action={
          <Link href="/extension" className="btn btn-sm btn-ghost">
            <Icon.download size={13} /> 采集插件
          </Link>
        }
      />

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="客户端版本" value={m ? `v${m.version}` : '—'} foot={m ? '桌面壳' : '还没打包'} />
        <Stat label="可下载" value={builds.length} foot={builds.length ? [...new Set(builds.map((b) => DESKTOP_OS_LABEL[b.os]))].join(' · ') : '无'} />
        <Stat label="服务端版本" value={`v${pkg.version}`} foot="网页与功能本体" />
        <Stat
          label="本机服务更新"
          value={localService ? (appliance ? `v${appliance.version}` : '—') : '不适用'}
          foot={localService ? (appliance ? '可一键更新' : '未发布更新包') : 'SaaS 由平台维护'}
        />
      </div>

      {!m ? (
        <Card title="还没有可下载的安装包" sub="打包之后这里会出现下载按钮">
          <p className="small muted" style={{ lineHeight: 1.9 }}>
            桌面壳要在<b>对应操作系统上</b>构建（Tauri 不支持交叉编译）：
            Mac 上 <code className="mono">cd desktop &amp;&amp; npm run build</code> 出 .dmg，
            Windows 上同样命令出 .msi / .exe；之后在项目根目录跑一次
            <code className="mono"> npm run pack:desktop</code> 收集产物，这一页就有下载了。
            详见 <code className="mono">desktop/README.md</code>。
          </p>
        </Card>
      ) : (
        <Card
          title="下载安装包"
          sub={recommended ? `已按你的系统推荐：${DESKTOP_OS_LABEL[recommended.os]}` : '选一个和你系统匹配的'}
        >
          <div className="grid grid-2" style={{ gap: 12 }}>
            {[{ os: 'mac' as const, list: macBuilds }, { os: 'win' as const, list: winBuilds }].map(({ os, list }) => (
              <div key={os} className="card" style={{ padding: 14 }}>
                <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ fontSize: 20 }}>{osIcon(os)}</span>
                  <b>{DESKTOP_OS_LABEL[os]}</b>
                  {recommended?.os === os && <span className="badge badge-brand">推荐给你</span>}
                </div>
                {list.length === 0 ? (
                  // 缺哪个平台就如实说，不放按钮——放一个 404 的下载键比不放糟得多
                  <p className="small muted" style={{ lineHeight: 1.8 }}>
                    还没有 {DESKTOP_OS_LABEL[os]} 安装包。
                    {os === 'win'
                      ? 'Windows 包必须在 Windows 机器上构建，做好后会出现在这里。'
                      : 'macOS 包必须在 Mac 上构建，做好后会出现在这里。'}
                  </p>
                ) : (
                  <div className="stack" style={{ gap: 8 }}>
                    {list.map((b) => (
                      <div key={b.file} className="row-between" style={{ gap: 8, flexWrap: 'wrap' }}>
                        <span className="small">
                          {b.os === 'mac' ? archLabel(b.arch) : b.ext.toUpperCase()}
                          <span className="muted">　{b.sizeMB} MB</span>
                        </span>
                        {/* download 属性 + 直链静态文件：不经服务端中转，大文件不占 Node 内存 */}
                        <a className="btn btn-sm btn-primary" href={b.file} download>
                          <Icon.download size={13} /> 下载
                        </a>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="divider" />
          <div className="stack" style={{ gap: 6 }}>
            <b className="small">装好之后</b>
            <p className="small muted" style={{ lineHeight: 1.9, margin: 0 }}>
              首次打开会问你「连到哪一个烽火台」：
              <b>连云端账号</b>就是现在这个站点，和浏览器里同一个工作区；
              <b>连本机整机版</b>要先在这台机器上装过整机版服务。选过一次就记住了，之后直接进。
              <br />
              ⚠️ 安装包<b>没有代码签名</b>（Mac 公证要 Apple 开发者账号、Windows 要代码签名证书）：
              macOS 首次打开请<b>右键 →「打开」</b>，或到「系统设置 → 隐私与安全性 → 仍要打开」；
              Windows 会弹 SmartScreen，点「更多信息 → 仍要运行」。
            </p>
          </div>

          {builds.length > 0 && (
            <details className="small" style={{ marginTop: 10 }}>
              <summary className="muted" style={{ cursor: 'pointer' }}>校验值（sha256）</summary>
              <div className="stack" style={{ gap: 4, marginTop: 6 }}>
                {builds.map((b) => (
                  <div key={b.file} className="mono" style={{ fontSize: 11, wordBreak: 'break-all' }}>
                    {b.file.split('/').pop()}
                    <br />
                    <span className="muted">{b.sha256}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </Card>
      )}

      {/* 本机服务的一键增量更新：只有整机版/私有化才有这台机器 */}
      {localService && (
        <ApplianceUpdateCard
          current={pkg.version}
          latest={appliance?.version ?? null}
          sizeMB={appliance?.sizeMB ?? null}
          notes={appliance?.notes ?? []}
          canUpdate={canUpdate}
        />
      )}
    </>
  );
}
