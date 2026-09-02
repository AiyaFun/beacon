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

// 客户端相对网页多出来的四件事。逐条对着 desktop/src-tauri 核过：
// 托盘 + 关闭收起(prevent_close)、autostart 插件、dataDirectory="webview"。
// 没有通知插件，所以这里绝不能写「消息提醒」。
const DESKTOP_EXTRAS: Array<[string, string]> = [
  ['独立窗口', '有自己的图标和任务栏位置，不会被一堆标签页淹掉'],
  ['托盘常驻', '点关闭只是收进托盘，后台照常待命，随手点回来'],
  ['开机自启', '开机自动在后台起来，不用每次去找入口'],
  ['独立本地缓存', '登录态存在客户端自己的数据目录，清浏览器缓存不影响它'],
  ['自动更新（1.2.5 起）', '有新版会自己弹提示，点一下原地升级——不用再回这页手动下载覆盖'],
];

// 三者分工。网页版与客户端两列几乎完全相同——这正是要让人一眼看到的结论。
// 采集那三行的口径按实际实现写：自有后台数据只能插件；公众号/视频号服务端没路；
// 其余平台服务端能自动采，插件只是补采。
const SPLIT_MATRIX: string[][] = [
  ['选题、起稿、改稿、配图、发布', '✓', '✓', '—'],
  ['看数据、竞对监控、作战报告', '✓', '✓', '—'],
  ['派 AI 任务、定时任务', '✓', '✓', '—'],
  ['抓你自己后台的经营数据', '—', '—', '✓ 只能靠它'],
  ['抓公众号 / 视频号竞对', '—', '—', '✓ 只能靠它'],
  ['抓其他平台竞对', '✓ 服务端自动', '✓ 同左', '✓ 可补采'],
  ['独立窗口 / 托盘 / 开机自启', '—', '✓', '—'],
  ['连这台机器上的整机版', '手动输地址', '✓ 自动探测并记住', '—'],
];

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

      {/* 【不适用就别占版面】SaaS 用户没有「本机服务」这台机器，原先那格会印出一个
          巨大的「不适用」压在首屏——说了等于没说。缺席的东西直接不渲染，
          栅格随之从四列收成三列。 */}
      <div className={`grid ${localService ? 'grid-4' : 'grid-3'}`} style={{ marginBottom: 16 }}>
        <Stat label="客户端版本" value={m ? `v${m.version}` : '—'} foot={m ? '桌面壳' : '还没打包'} />
        <Stat label="可下载" value={builds.length} foot={builds.length ? [...new Set(builds.map((b) => DESKTOP_OS_LABEL[b.os]))].join(' · ') : '无'} />
        <Stat label="服务端版本" value={`v${pkg.version}`} foot="网页与功能本体" />
        {localService && (
          <Stat
            label="本机服务更新"
            value={appliance ? `v${appliance.version}` : '—'}
            foot={appliance ? '可一键更新' : '未发布更新包'}
          />
        )}
      </div>

      {/* 【这一页首先要回答「我到底要不要装」】
          客户端是 Tauri 壳，装进去的就是同一套网页界面——功能一模一样，没有客户端专属能力。
          真实差别只有「怎么打开」和「能不能自动连本机整机版」两类，多写一个字都是夸大。
          更要紧的是说破它**替代不了采集插件**：采集要用你自己浏览器里的登录态，
          客户端是独立 WebView 装不了扩展。不写清楚的话，装完客户端等数据自己进来的人会一直等。 */}
      <Card
        title="客户端和网页，差在哪"
        sub="功能一模一样 · 差别只在怎么打开、能不能连本机"
        style={{ marginBottom: 16 }}
      >
        <div className="grid grid-4" style={{ gap: 10 }}>
          {DESKTOP_EXTRAS.map(([t, d]) => (
            <div key={t} className="card" style={{ padding: 12 }}>
              <b className="small">{t}</b>
              <p className="small muted" style={{ margin: '4px 0 0', lineHeight: 1.7 }}>{d}</p>
            </div>
          ))}
        </div>

        <div className="divider" />
        <b className="small">哪件事该用哪个</b>
        <div className="table-wrap" style={{ marginTop: 8 }}>
          <table className="table">
            <thead>
              <tr>
                <th style={{ minWidth: 190 }}>要做的事</th>
                <th style={{ minWidth: 88 }}>网页版</th>
                <th style={{ minWidth: 96 }}>桌面客户端</th>
                <th style={{ minWidth: 130 }}>采集插件</th>
              </tr>
            </thead>
            <tbody>
              {SPLIT_MATRIX.map((row) => (
                <tr key={row[0]}>
                  <td className="small">{row[0]}</td>
                  {row.slice(1).map((cell, i) => (
                    <td key={i} className="small" style={{ color: cell === '—' ? 'var(--text-3)' : undefined }}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="small muted" style={{ margin: '10px 0 0', lineHeight: 1.9 }}>
          注意<b>客户端替代不了插件</b>：采集用的是你自己浏览器里的登录态，
          而客户端是独立窗口、装不了浏览器扩展。想让数据自动回流，
          插件仍要装在你日常用的 Chrome 里 ——{' '}
          <Link href="/extension" style={{ color: 'var(--brand)', fontWeight: 600 }}>去装采集插件</Link>。
        </p>
      </Card>

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

          {/* 【桌面壳没有自动更新，别让人以为有】Tauri updater 插件没装，更新 = 重新下载覆盖安装。
              侧栏会在有新版时提醒（靠壳跳转时带的版本标记认出来），但真正的动作在这里说明。
              整机版服务那套「一键增量更新」是服务端的事，两件事别混为一谈。 */}
          <div className="divider" />
          <div className="stack" style={{ gap: 6 }}>
            <b className="small">怎么更新</b>
            <p className="small muted" style={{ lineHeight: 1.9, margin: 0 }}>
              客户端<b>不会自动更新</b>。有新版时，侧栏会出现一行「客户端有新版」提醒你；
              回到这一页重新下载，<b>覆盖安装即可</b>（macOS 拖进「应用程序」选替换，Windows 直接装在原位）。
              你的登录态和本地缓存都留着，装完还是同一个工作区。
              客户端只是外壳，<b>网页功能本身一直是最新的</b>，不更新客户端也不会少功能——
              更新带来的是壳自己的修复。
            </p>
          </div>

          <div className="divider" />
          <div className="stack" style={{ gap: 6 }}>
            <b className="small">装好之后</b>
            <p className="small muted" style={{ lineHeight: 1.9, margin: 0 }}>
              首次打开会问你「连到哪一个烽火台」：
              <b>连云端账号</b>就是现在这个站点，和浏览器里同一个工作区；
              <b>连本机整机版</b>要先在这台机器上装过整机版服务。选过一次就记住了，之后直接进。
            </p>
          </div>

          {/* 【两个平台待遇不同，别写成一句话】
              macOS：2026-08-28 起已用 Developer ID 签名 + 苹果公证（notarization），
              Gatekeeper 判定 source=Notarized Developer ID —— 双击直接开，**不要再写右键打开那套**，
              那是没签名时的绕行办法，现在写它反而让用户以为这软件有问题。
              Windows：代码签名证书一年好几千，现阶段不买，SmartScreen 必然弹。
              而它的默认界面**只有一个「不运行」按钮**，「仍要运行」藏在「更多信息」后面——
              不说破的话多数人到这一步就放弃了，等于包发了但装不上。所以这一侧要写得很细。 */}
          <div className="divider" />
          <div className="grid grid-2" style={{ gap: 10 }}>
            <div className="card" style={{ padding: 12 }}>
              <b className="small">🍎 macOS · 已签名并公证</b>
              <p className="small muted" style={{ margin: '6px 0 0', lineHeight: 1.9 }}>
                拖进「应用程序」双击即可，没有任何安全提示。
                签名主体：厦门云词数字科技，已通过 Apple 公证。
              </p>
            </div>
            <div className="card" style={{ padding: 12 }}>
              <b className="small">🪟 Windows · 会弹提示，按这三步</b>
              <ol className="small muted" style={{ margin: '6px 0 0', paddingLeft: 18, lineHeight: 1.9 }}>
                <li>浏览器提示「不常下载」→ 点 <b>保留</b></li>
                <li>双击后蓝屏「Windows 已保护你的电脑」→ 点左下角 <b>更多信息</b></li>
                <li>展开后点 <b>仍要运行</b></li>
              </ol>
              <p className="small muted" style={{ margin: '6px 0 0', lineHeight: 1.8 }}>
                Windows 端<b>没有代码签名</b>，所以会拦——不是软件有问题，
                可对照下方 sha256 自行校验文件完整性。
              </p>
            </div>
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
