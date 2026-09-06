import Link from 'next/link';
import { DesktopExecutorCard } from '@/components/DesktopExecutorCard';
import { Card, Stat, Empty, Fold } from '@/components/ui';

import { Icon } from '@/components/icons';
import { BROWSER_CARDS, storeLinks, storeVersion, storeIsBehind, readDownloadsManifest, type BrowserCard } from '@/lib/downloads';
import { prisma } from '@/lib/db';
import { getSessionOrNull } from '@/lib/session';
import { IngestTokenCard } from '../settings/IngestTokenCard';
import { TrackLink } from '@/components/growth/TrackLink';
import { ExtAutoConfig } from './ExtAutoConfig';
import { listIngestTokens } from '@/lib/ingest/token';
import { HubHeader } from '@/components/HubHeader';
import { getServerLang } from '@/lib/i18n/server';

function StoreButton({ url, label }: { url: string; label: string }) {
  return (
    <TrackLink event="download_click" meta="ext-store" href={url} target="_blank" rel="noreferrer" className="btn btn-sm btn-primary">
      <Icon.arrow size={13} /> {label}
    </TrackLink>
  );
}

function BrowserCardView({
  card,
  chromeUrl,
  zipHref,
  latestVersion,
  isEn,
}: {
  card: BrowserCard;
  chromeUrl: string;
  zipHref: string | null;
  latestVersion: string | null;
  isEn?: boolean;
}) {
  const isComing = card.install === 'coming';
  const isStoreCard = card.install === 'store';
  return (
    <div
      className="card"
      style={{ padding: 16, boxShadow: 'none', background: 'var(--surface-2)', opacity: isComing ? 0.72 : 1 }}
    >
      <div className="row" style={{ gap: 10, alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 24 }}>{card.emoji}</span>
        <div className="stack" style={{ gap: 2 }}>
          <b>{card.name}</b>
          <span className="small muted">{card.engine} {isEn ? 'Engine' : '内核'}</span>
        </div>
        {isComing && <span className="badge badge-amber" style={{ marginLeft: 'auto' }}>{isEn ? 'Coming Soon' : '即将支持'}</span>}
        {!isComing && isStoreCard && chromeUrl && (
          <span className="badge badge-green" style={{ marginLeft: 'auto' }}>{isEn ? 'Store Available' : '商店可装'}</span>
        )}
        {!isComing && !(isStoreCard && chromeUrl) && (
          <span className="badge badge-gray" style={{ marginLeft: 'auto' }}>{isEn ? 'Manual Load' : '手动加载'}</span>
        )}
      </div>
      <p className="small muted" style={{ marginBottom: 12, lineHeight: 1.7, minHeight: 44 }}>{card.note}</p>

      {isComing ? (
        <button className="btn btn-sm" disabled style={{ opacity: 0.6, cursor: 'not-allowed' }}>
          {isEn ? 'Unavailable' : '暂不可用'}
        </button>
      ) : (
        <div className="row wrap" style={{ gap: 8 }}>
          {isStoreCard && chromeUrl && <StoreButton url={chromeUrl} label={isEn ? 'Install from Store' : '商店安装'} />}
          {isStoreCard && !chromeUrl && <span className="badge badge-amber">{isEn ? 'Store in Review' : '商店审核中'}</span>}
          {!isStoreCard && card.chromeStoreOk && chromeUrl && (
            <StoreButton url={chromeUrl} label={isEn ? 'Install Chrome Store Version' : '装 Chrome 商店版'} />
          )}
          {zipHref && (
            <TrackLink event="download_click" meta="ext-zip" href={zipHref} download className="btn btn-sm btn-ghost">
              <Icon.download size={13} /> {isEn ? `Download zip${latestVersion ? ` · v${latestVersion}` : ''}` : `下载 zip${latestVersion ? ` · 最新版 v${latestVersion}` : ''}`}
            </TrackLink>
          )}
        </div>
      )}
    </div>
  );
}

export const dynamic = 'force-dynamic';

export default async function ExtensionPage() {
  // 未登录也能看（2026-09-05）：商店链接与 zip 下载对陌生人开放；令牌/执行器等登录态内容只给登录用户
  const [s, lang] = await Promise.all([getSessionOrNull(), getServerLang()]);
  const isEn = lang === 'en';
  const [workspace, tokens] = s
    ? await Promise.all([
        prisma.workspace.findUnique({
          where: { id: s.workspaceId },
          select: { ingestToken: true, agentToolConfig: true, browserReadEnabled: true },
        }),
        listIngestTokens(s.workspaceId),
      ])
    : [null, { active: [], revoked: [] } as Awaited<ReturnType<typeof listIngestTokens>>];
  const legacyToken = workspace?.ingestToken ?? null;

  const manifest = readDownloadsManifest();
  const links = storeLinks();
  const zipHref = manifest?.latest ?? null;
  const latestVersion = manifest?.version ?? null;
  const storeVer = storeVersion();
  const behind = storeIsBehind(latestVersion); // true=商店落后 / false=同版 / null=不知道，不下结论
  const supportedCount = BROWSER_CARDS.filter((c) => c.install !== 'coming').length;

  return (
    <>
      <HubHeader
        title={isEn ? 'Download Ingest Assistant' : '下载采集助手'}
        hint={isEn ? 'Install the browser extension to send back public metrics while browsing competitor profiles, or sync your own post metrics with one click · Only collects public data visible on screen' : '装上浏览器插件，浏览竞对公开主页时顺手回传公开数据、在自己作品页一键回填表现数据 · 只采你在页面上亲眼可见的公开数据'}
        action={<Link href="/help" className="btn btn-sm btn-ghost"><Icon.help size={13} /> {isEn ? 'Help Guide' : '使用帮助'}</Link>}
      />

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label={isEn ? 'Latest (zip)' : '最新版（zip）'} value={latestVersion ? `v${latestVersion}` : '—'} foot={manifest ? 'Manifest V3' : (isEn ? 'Unpacked' : '未打包')} />
        <Stat
          label={isEn ? 'Store Version' : '商店在架版'}
          value={links.chrome ? (storeVer ? `v${storeVer}` : (isEn ? 'Listed' : '已上架')) : '—'}
          foot={links.chrome ? (storeVer ? (isEn ? 'Updates with review' : '随审核更新') : (isEn ? 'Check store page' : '版本以商店页为准')) : (isEn ? 'Not listed' : '未上架')}
        />
        <Stat label={isEn ? 'Supported Browsers' : '支持浏览器'} value={supportedCount} foot={isEn ? 'All Chromium-based' : 'Chromium 系通用'} />
        <Stat label={isEn ? 'Host Permissions' : 'Host 权限'} value="8" foot={isEn ? 'Public post pages only, no creator backends' : '仅 6 站公开作品页，不含创作者后台'} />
      </div>

      {/* 两条通道并存的说明卡：上架之后最容易产生的困惑就是「我从商店装的，怎么没有新平台」。
          把差别摆在选浏览器之前，用户才知道自己该选哪条。 */}
      {links.chrome && (
        <Card
          title={isEn ? 'Two Ways to Install, Both Maintained' : '两种装法，都保留'}
          sub={isEn ? 'Store version = Stable, auto-updates; zip version = Latest, manual loading. Accounts & data 100% compatible' : '商店版=稳、自动更新；zip 版=最新、手动加载。数据与账号完全通用，随时可换'}
          style={{ marginBottom: 16 }}
        >
          <div className="grid grid-2" style={{ gap: 12 }}>
            <div className="card" style={{ padding: 14, boxShadow: 'none', background: 'var(--surface-2)' }}>
              <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 6 }}>
                <b>{isEn ? '① Chrome Web Store Version' : '① Chrome 应用商店版'}</b>
                <span className="badge badge-green" style={{ marginLeft: 'auto' }}>{storeVer ? `v${storeVer}` : (isEn ? 'Listed' : '已上架')}</span>
              </div>
              <p className="small muted" style={{ lineHeight: 1.7, marginBottom: 10 }}>
                {isEn
                  ? 'One-click install, auto-updates, restored even after PC reinstallation. Because updates require Google review, it may lag behind zip by several days to a couple weeks — fresh platform adapters usually arrive on zip first.'
                  : '一键安装、自动更新，重装电脑也能找回。代价是每次发版都要过 Google 审核，所以它会比 zip 版慢几天到一两周——刚做的平台适配、真机改的选择器通常先到 zip。'}
              </p>
              <StoreButton url={links.chrome} label={isEn ? 'Go to Chrome Web Store' : '前往 Chrome 应用商店'} />
            </div>
            <div className="card" style={{ padding: 14, boxShadow: 'none', background: 'var(--surface-2)' }}>
              <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 6 }}>
                <b>{isEn ? '② Self-hosted zip (Latest Version)' : '② 自托管 zip（最新版）'}</b>
                <span className="badge badge-brand" style={{ marginLeft: 'auto' }}>{latestVersion ? `v${latestVersion}` : (isEn ? 'Unpacked' : '未打包')}</span>
              </div>
              <p className="small muted" style={{ lineHeight: 1.7, marginBottom: 10 }}>
                {isEn
                  ? 'Always the latest version, loaded via developer mode (steps below). Does not auto-update — when an update is available, download and click "Reload" in extensions.'
                  : '永远是最新的一版，走开发者模式加载（步骤见下方卡片）。不自动更新——有新版时需要你重新下载、在扩展页点一下「重新加载」。'}
              </p>
              {zipHref ? (
                <TrackLink event="download_click" meta="ext-zip" href={zipHref} download className="btn btn-sm btn-primary">
                  <Icon.download size={13} /> {isEn ? 'Download Latest zip' : '下载最新版 zip'}
                </TrackLink>
              ) : (
                <span className="badge badge-gray">{isEn ? 'Not packaged yet' : '尚未打包'}</span>
              )}
            </div>
          </div>
          {behind === true && (
            <div className="alert-gradient-amber" style={{ padding: '10px 14px', marginTop: 12 }}>
              <span className="small" style={{ opacity: 0.9, lineHeight: 1.7 }}>
                ⏳ {isEn
                  ? <>Store version is <b>v{storeVer}</b>, self-hosted latest is <b>v{latestVersion}</b>. Install zip for the latest platform support, or wait for store review to pass.</>
                  : <>商店在架的是 <b>v{storeVer}</b>，自托管最新版已到 <b>v{latestVersion}</b>。想先用上新版本的平台适配就装 zip；不急的话等商店审核通过后自动更新即可。</>}
              </span>
            </div>
          )}
          {behind === false && (
            <div className="small muted" style={{ marginTop: 12 }}>
              {isEn ? `✓ Store version matches self-hosted latest (both v${latestVersion}). Either channel provides the same experience.` : `✓ 商店在架版本与自托管最新版一致（都是 v${latestVersion}），两条通道装哪个都一样。`}
            </div>
          )}
          {behind === null && (
            <div className="small muted" style={{ marginTop: 12 }}>
              {isEn ? 'Store version not recorded yet. Check the store page for exact version.' : '商店在架版本号未登记，具体版本以商店页面显示为准。'}
            </div>
          )}
        </Card>
      )}

      <Card
        title={isEn ? 'Select Your Browser' : '选择你的浏览器'}
        sub={isEn ? 'Chrome / Edge / 360 / Brave are all Chromium-based, one package works for all · Only Chrome is in store, others load via developer mode' : 'Chrome / Edge / 360 / Brave 同为 Chromium，同一个包通用 · 仅 Chrome 上架商店，其余走 zip 开发者模式加载'}
        style={{ marginBottom: 16 }}
        action={<span className="badge badge-brand"><Icon.shield size={13} /> {isEn ? 'Minimal Host Permissions · Public Data Only' : '最小主机权限 · 只采可见公开数据'}</span>}
      >
        <div className="grid grid-2" style={{ gap: 12 }}>
          {BROWSER_CARDS.map((card) => (
            <BrowserCardView key={card.key} card={card} chromeUrl={links.chrome} zipHref={zipHref} latestVersion={latestVersion} isEn={isEn} />
          ))}
        </div>
        {!links.chrome && (
          <div className="alert-gradient-amber" style={{ padding: '10px 14px', marginTop: 14 }}>
            <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
              <span className="row" style={{ color: 'var(--amber)', flexShrink: 0 }}><Icon.shield size={16} /></span>
              <span className="small" style={{ opacity: 0.9, lineHeight: 1.7 }}>
                {isEn
                  ? <>Chrome Web Store entrance is currently disabled. Please install via <b>zip + Developer Mode</b> below.</>
                  : <>Chrome 应用商店入口当前被显式关闭。请用下方 <b>zip + 开发者模式加载</b> 安装。</>}
              </span>
            </div>
          </div>
        )}
      </Card>

      {/* 填令牌是**所有人必经**的一步（不填插件认不出工作区），所以独占一行、排在前面。
          「开发者模式加载」只有走 zip 的人需要，折进 Fold——这一页此前 8 张卡平铺，
          新用户第一眼分不出哪几步是自己必须做的。 */}
      {/* 桌面客户端里：不装插件也能采（只在 Tauri 壳里渲染） */}
      {s && <DesktopExecutorCard />}

      {!s && (
        <Card title={isEn ? 'After installing: sign in to connect' : '装好之后：登录即可接上'} sub={isEn ? 'The extension identifies your workspace by an ingest token issued after sign-in' : '插件靠登录后签发的采集令牌认工作区，注册送 30 天标准版'} style={{ marginBottom: 16 }}>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            <Link href="/login" className="btn btn-primary btn-sm">{isEn ? 'Sign in / Sign up' : '登录 / 注册'}</Link>
            <Link href="/desktop" className="btn btn-sm">{isEn ? 'Prefer no extension? Desktop app' : '不想装插件？看桌面客户端'}</Link>
          </div>
        </Card>
      )}

      {s && <Card title={isEn ? 'Enter Ingest Token' : '填入采集令牌'} sub={isEn ? 'Required for the extension to send back data after installation' : '装好插件后这一步才能回传数据'} style={{ marginBottom: 16 }}>
          <div className="stack" style={{ gap: 10 }}>
            <p className="small muted" style={{ lineHeight: 1.7 }}>
              {isEn ? 'The extension does not contain your identity — it identifies your workspace via Ingest Token. After installation:' : '插件本身不含你的身份——它靠采集令牌认工作区。安装后：'}
            </p>
            <ol className="stack" style={{ gap: 8, paddingLeft: 18, margin: 0 }}>
              <li className="small" style={{ lineHeight: 1.7 }}>
                {isEn ? <>Issue an Ingest Token for <b>this device</b> below (each device has its own, can be revoked individually).</> : <>在下方为<b>这台设备</b>签发一枚采集令牌（每台设备各一枚，可单独吊销）。</>}
              </li>
              <li className="small" style={{ lineHeight: 1.7 }}>
                {isEn ? <>Open extension settings, enter <b>Beacon URL</b> and <b>Ingest Token</b>, then click "Test Connection".</> : <>打开插件设置页，填入<b>烽火台地址</b>与<b>采集令牌</b>，点「测试连接」。</>}
              </li>
              <li className="small" style={{ lineHeight: 1.7 }}>
                {isEn ? <>Go to <Link href="/competitors" style={{ color: 'var(--brand)', fontWeight: 600 }}>Competitor Monitor</Link> to subscribe to rivals; opening their public profiles automatically triggers data collection.</> : <>到 <Link href="/competitors" style={{ color: 'var(--brand)', fontWeight: 600 }}>竞对监控</Link> 订阅竞对，打开其公开主页即自动采集。</>}
              </li>
            </ol>
            <div style={{ marginTop: 8 }}>
              <IngestTokenCard active={tokens.active} revoked={tokens.revoked} legacyToken={legacyToken} />
              <ExtAutoConfig host={process.env.NEXT_PUBLIC_APP_URL || 'https://beacon.iyunci.cn'} />
            </div>
          </div>
      </Card>}

      <Fold
        title={isEn ? 'Developer Mode Loading (zip Universal Steps)' : '开发者模式加载（zip 通用步骤）'}
        sub={isEn ? 'For store review periods / enterprise intranets' : '商店审核期 / 企业内网走这条'}
        note={<span className="small muted">{isEn ? 'Store users can skip' : '装商店版可跳过'}</span>}
      >
          {zipHref ? (
          <ol className="stack" style={{ gap: 10, paddingLeft: 18, margin: 0 }}>
            <li className="small" style={{ lineHeight: 1.7 }}>
              {isEn ? (
                <><a href={zipHref} download style={{ color: 'var(--brand)', fontWeight: 600 }}>Download zip installer ↓</a>, unzip to a fixed folder that <b>will not be deleted</b>.</>
              ) : (
                <><a href={zipHref} download style={{ color: 'var(--brand)', fontWeight: 600 }}>下载 zip 安装包 ↓</a>，解压到一个<b>不会被删</b>的固定文件夹。</>
              )}
            </li>
            <li className="small" style={{ lineHeight: 1.7 }}>
              {isEn ? 'Open extensions in address bar: Chrome chrome://extensions · Edge edge://extensions · 360 in Extension Center.' : '地址栏进扩展页：Chrome chrome://extensions · Edge edge://extensions · 360 在「扩展中心」。'}
            </li>
            <li className="small" style={{ lineHeight: 1.7 }}>
              {isEn ? <>Turn on <b>Developer mode</b> in the top right.</> : <>右上角打开<b>开发者模式</b>。</>}
            </li>
            <li className="small" style={{ lineHeight: 1.7 }}>
              {isEn ? <>Click <b>"Load unpacked"</b>, and select the unzipped folder.</> : <>点<b>「加载已解压的扩展程序」</b>，选择刚解压的文件夹。</>}
            </li>
            <li className="small" style={{ lineHeight: 1.7 }}>
              {isEn ? 'After installing, paste your ingest token to get started.' : '装好后在右侧填入采集令牌，即可开始使用。'}
            </li>
          </ol>
        ) : (
          <Empty icon="📦" text={isEn ? 'Installer not packaged yet. Run npm run pack:ext in project root to generate zip, then refresh this page.' : '还没打包安装包。在项目根目录执行 npm run pack:ext 生成 zip 后刷新本页。'} />
        )}
      </Fold>

      {/* 合规边界与数据源机制是**看一次就够**的参考说明，折起来——
          它们此前和「等浏览器做的活」「AI 能力」并排铺在 grid 里，
          让这一页看上去有八件事要做，而真正要做的只有装插件、填令牌两件。 */}
      <Fold title={isEn ? 'Compliance Boundaries' : '合规边界'} sub={isEn ? 'Only collects public data visible on screen' : '只采你在页面上亲眼可见的公开数据'} note={<span className="small muted">{isEn ? 'Read once' : '看一次就够'}</span>}>
          <div className="stack" style={{ gap: 10 }}>
          <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
            <span style={{ color: 'var(--green)', flexShrink: 0 }}><Icon.check size={16} /></span>
            <span className="small" style={{ lineHeight: 1.7 }}>
              {isEn ? (
                <><b>Only rendered, visible DOM on public profiles is collected, never touch authenticated endpoints.</b> In addition to your on-demand clicks: <b>Daily scheduled collection is on by default</b>, opening your subscribed competitor public profiles in background tabs at your scheduled time (default 09:00), closing immediately upon completion. Can be disabled in extension settings. Scope is identical to manual collection.</>
              ) : (
                <><b>采的永远是公开主页上已渲染、你亲眼可见的 DOM，不碰登录态接口。</b>除了你当场点击，还有一处是自动的：<b>每日定时采集默认开启</b>，插件会在你设定的时间（默认 09:00）用<b>后台标签页</b>逐个打开你自己已订阅的竞对公开主页，采完立即关闭，可在插件设置里关掉。范围与手动采集完全相同，不因自动化而扩大。</>
              )}
            </span>
          </div>
          <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
            <span style={{ color: 'var(--green)', flexShrink: 0 }}><Icon.check size={16} /></span>
            <span className="small" style={{ lineHeight: 1.7 }}>
              {isEn ? (
                <><b>Minimal host permissions.</b> 8 paths requested since 0.8.2, all for Bilibili/Douyin/RED/X/YouTube/TikTok <b>public post pages</b> — to allow "Read comments & ask questions" in the in-page sidebar. <b>Does not include any creator backend domains</b>. Data transmission does not rely on host permissions, using CORS + Ingest-Token header, token only authorizes appending public data to subscribed competitors.</>
              ) : (
                <><b>最小主机权限。</b>0.8.2 起申请 8 条路径，全部是 B站/抖音/小红书/X/YouTube/TikTok 的<b>公开作品页</b>——为了让「读评论提问」在页内侧栏上也能用（activeTab 只在你点扩展自己的界面时授予，点页内按钮拿不到）。<b>不含任何创作者后台域名</b>。回传本身不依赖主机权限，走服务端 CORS + 令牌头，令牌只授权「向本工作区订阅的竞对补充公开数据」。</>
              )}
            </span>
          </div>
          <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
            <span style={{ color: 'var(--green)', flexShrink: 0 }}><Icon.check size={16} /></span>
            <span className="small" style={{ lineHeight: 1.7 }}>
              {isEn ? (
                <><b>Competitors/Others: Only publicly published account & post information is collected</b>, never private data. <b>Your own posts:</b> In your logged-in creator backend, the extension reads performance metrics of your own posts (including completion rates not visible on public pages) — that is your own data, sent only to your own workspace. In both cases, <b>no platform credentials are hosted or uploaded</b>. Monitored entities may <a href="/legal/data-request" target="_blank" style={{ color: 'var(--brand)', fontWeight: 600 }}>Request Monitoring Removal →</a></>
              ) : (
                <><b>他人/竞对：只采各平台已公开发布的账号与作品信息</b>，不碰任何非公开数据。<b>你自己的作品另算</b>：在你本人已登录的创作者后台里，插件会读你自己作品的表现数字（含公开页拿不到的完播率/完读率）——那是你自己的数据，只回传到你自己的工作区。两种情况都<b>不托管、不上传任何平台凭证</b>。若你是被监控账号主体，可 <a href="/legal/data-request" target="_blank" style={{ color: 'var(--brand)', fontWeight: 600 }}>申请移除监控 →</a></>
              )}
            </span>
          </div>
        </div>
      </Fold>

      <Fold title={isEn ? 'Data Source Architecture' : '数据源机制'} sub={isEn ? 'Dual-source redundancy, high stability ingest guarantee' : '双源冗余保障，高稳定性采集保障'} note={<span className="small muted">{isEn ? 'Read once' : '看一次就够'}</span>}>
          <div className="stack" style={{ gap: 10 }}>
          <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
            <span style={{ color: 'var(--brand)', flexShrink: 0 }}><Icon.sparkles size={16} /></span>
            <span className="small" style={{ lineHeight: 1.7 }}>
              {isEn ? (
                <><b>Open-Source Self-Hosted Priority</b>: Hotlist aggregation and basic public metrics prioritize our <b>self-hosted DailyHotApi instance</b>, lightweight and stable with minimal third-party dependency.</>
              ) : (
                <><b>开源自建为主</b>：热榜聚合与基础公开数据优先走<b>自建 DailyHotApi 实例</b>，性能轻量稳定，对第三方商业依赖极低。</>
              )}
            </span>
          </div>
          <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
            <span style={{ color: 'var(--brand)', flexShrink: 0 }}><Icon.sparkles size={16} /></span>
            <span className="small" style={{ lineHeight: 1.7 }}>
              {isEn ? (
                <><b>Commercial API Backup</b>: For strict risk-controlled public pages like RED and Douyin, <b>commercial data sources (e.g. TikHub) serve as fallback channels</b>.</>
              ) : (
                <><b>商业 API 兜底</b>：如小红书、抖音等风控极严的公开页面，提供<b>商业数据源（如 TikHub/天行等）作为熔断备份通道</b>。</>
              )}
            </span>
          </div>
          <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
            <span style={{ color: 'var(--brand)', flexShrink: 0 }}><Icon.sparkles size={16} /></span>
            <span className="small" style={{ lineHeight: 1.7 }}>
              {isEn ? (
                <><b>Automatic Dual-Source Failover</b>: The system continuously monitors main channel block status. If an open-source endpoint fails, it <b>automatically fails over to backup within seconds</b>, preserving redundancy.</>
              ) : (
                <><b>双源冗余切换</b>：系统将实时监测主通道风控阻断状态。一旦开源接口失效，将<b>自动在秒级切入备份通道</b>，双源冗余不削弱。</>
              )}
            </span>
          </div>
        </div>
      </Fold>

    </>
  );
}
