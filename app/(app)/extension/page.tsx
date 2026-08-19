import Link from 'next/link';
import { PageHead, Card, Stat, Empty } from '@/components/ui';
import { Icon } from '@/components/icons';
import { BROWSER_CARDS, storeLinks, storeVersion, storeIsBehind, readDownloadsManifest, type BrowserCard } from '@/lib/downloads';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { IngestTokenCard } from '../settings/IngestTokenCard';
import { ExtAutoConfig } from './ExtAutoConfig';
import { listIngestTokens } from '@/lib/ingest/token';

export const dynamic = 'force-dynamic';

// 采集助手下载页（需求①）。分发策略见 lib/downloads.ts：
// **只有 Chrome 一家商店会提交审核**（2026-07-30 已上架）；Edge / 360 / Brave 永远不提交它们各自的商店，
// 给它们挂「审核中」等于骗用户白等，这些卡片走 zip 开发者模式加载，
// 能装 Chrome 商店版的（Edge / Brave）另给一个次选入口。Safari 独立轨道，如实标注「即将支持」。
//
// ⚠️ 上架之后**两条通道都要留**：商店版稳但滞后于审核周期，zip 版永远最新。
// 页面必须把差别写在用户看得见的地方，否则「我装了怎么没有新平台」会变成常见困惑。

function StoreButton({ url, label }: { url: string; label: string }) {
  return (
    <a href={url} target="_blank" rel="noreferrer" className="btn btn-sm btn-primary">
      <Icon.arrow size={13} /> {label}
    </a>
  );
}

function BrowserCardView({
  card,
  chromeUrl,
  zipHref,
  latestVersion,
}: {
  card: BrowserCard;
  /** Chrome 应用商店链接（空 = 还没上架）。唯一一条我们真的提交了审核的渠道 */
  chromeUrl: string;
  zipHref: string | null;
  /** 自托管 zip 的版本号，用于把「最新版」写在按钮上 */
  latestVersion: string | null;
}) {
  const isComing = card.install === 'coming';
  // 只有真正提交了审核的那张卡（Chrome）才配显示「商店可装 / 商店审核中」
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
          <span className="small muted">{card.engine} 内核</span>
        </div>
        {isComing && <span className="badge badge-amber" style={{ marginLeft: 'auto' }}>即将支持</span>}
        {!isComing && isStoreCard && chromeUrl && (
          <span className="badge badge-green" style={{ marginLeft: 'auto' }}>商店可装</span>
        )}
        {!isComing && !(isStoreCard && chromeUrl) && (
          <span className="badge badge-gray" style={{ marginLeft: 'auto' }}>手动加载</span>
        )}
      </div>
      <p className="small muted" style={{ marginBottom: 12, lineHeight: 1.7, minHeight: 44 }}>{card.note}</p>

      {isComing ? (
        <button className="btn btn-sm" disabled style={{ opacity: 0.6, cursor: 'not-allowed' }}>
          暂不可用
        </button>
      ) : (
        <div className="row wrap" style={{ gap: 8 }}>
          {isStoreCard && chromeUrl && <StoreButton url={chromeUrl} label="商店安装" />}
          {/* 审核中只对 Chrome 成立——其余浏览器我们压根没提交，不能让用户以为等一等就有 */}
          {isStoreCard && !chromeUrl && <span className="badge badge-amber">商店审核中</span>}
          {!isStoreCard && card.chromeStoreOk && chromeUrl && (
            <StoreButton url={chromeUrl} label="装 Chrome 商店版" />
          )}
          {zipHref && (
            <a href={zipHref} download className="btn btn-sm btn-ghost">
              <Icon.download size={13} /> 下载 zip{latestVersion ? ` · 最新版 v${latestVersion}` : ''}
            </a>
          )}
        </div>
      )}
    </div>
  );
}

export default async function ExtensionPage() {
  const s = await getSession();
  const [workspace, tokens] = await Promise.all([
    prisma.workspace.findUnique({ where: { id: s.workspaceId }, select: { ingestToken: true } }),
    listIngestTokens(s.workspaceId),
  ]);
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
      <PageHead
        title="下载采集助手"
        desc="装上浏览器插件，浏览竞对公开主页时顺手回传公开数据、在自己作品页一键回填表现数据 · 只采你在页面上亲眼可见的公开数据"
        action={<Link href="/help" className="btn btn-sm btn-ghost"><Icon.help size={13} /> 使用帮助</Link>}
      />

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="最新版（zip）" value={latestVersion ? `v${latestVersion}` : '—'} foot={manifest ? 'Manifest V3' : '未打包'} />
        <Stat
          label="商店在架版"
          value={links.chrome ? (storeVer ? `v${storeVer}` : '已上架') : '—'}
          foot={links.chrome ? (storeVer ? '随审核更新' : '版本以商店页为准') : '未上架'}
        />
        <Stat label="支持浏览器" value={supportedCount} foot="Chromium 系通用" />
        <Stat label="Host 权限" value="8" foot="仅 6 站公开作品页，不含创作者后台" />
      </div>

      {/* 两条通道并存的说明卡：上架之后最容易产生的困惑就是「我从商店装的，怎么没有新平台」。
          把差别摆在选浏览器之前，用户才知道自己该选哪条。 */}
      {links.chrome && (
        <Card title="两种装法，都保留" sub="商店版=稳、自动更新；zip 版=最新、手动加载。数据与账号完全通用，随时可换" style={{ marginBottom: 16 }}>
          <div className="grid grid-2" style={{ gap: 12 }}>
            <div className="card" style={{ padding: 14, boxShadow: 'none', background: 'var(--surface-2)' }}>
              <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 6 }}>
                <b>① Chrome 应用商店版</b>
                <span className="badge badge-green" style={{ marginLeft: 'auto' }}>{storeVer ? `v${storeVer}` : '已上架'}</span>
              </div>
              <p className="small muted" style={{ lineHeight: 1.7, marginBottom: 10 }}>
                一键安装、<b>自动更新</b>，重装电脑也能找回。代价是每次发版都要过 Google 审核，
                所以它<b>会比 zip 版慢几天到一两周</b>——刚做的平台适配、真机改的选择器通常先到 zip。
              </p>
              <StoreButton url={links.chrome} label="前往 Chrome 应用商店" />
            </div>
            <div className="card" style={{ padding: 14, boxShadow: 'none', background: 'var(--surface-2)' }}>
              <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 6 }}>
                <b>② 自托管 zip（最新版）</b>
                <span className="badge badge-brand" style={{ marginLeft: 'auto' }}>{latestVersion ? `v${latestVersion}` : '未打包'}</span>
              </div>
              <p className="small muted" style={{ lineHeight: 1.7, marginBottom: 10 }}>
                永远是最新的一版，走<b>开发者模式加载</b>（步骤见下方卡片）。
                不自动更新——有新版时需要你重新下载、在扩展页点一下「重新加载」。
              </p>
              {zipHref ? (
                <a href={zipHref} download className="btn btn-sm btn-primary">
                  <Icon.download size={13} /> 下载最新版 zip
                </a>
              ) : (
                <span className="badge badge-gray">尚未打包</span>
              )}
            </div>
          </div>
          {behind === true && (
            <div className="alert-gradient-amber" style={{ padding: '10px 14px', marginTop: 12 }}>
              <span className="small" style={{ opacity: 0.9, lineHeight: 1.7 }}>
                ⏳ 商店在架的是 <b>v{storeVer}</b>，自托管最新版已到 <b>v{latestVersion}</b>。
                想先用上新版本的平台适配就装 zip；不急的话等商店审核通过后自动更新即可。
              </span>
            </div>
          )}
          {behind === false && (
            <div className="small muted" style={{ marginTop: 12 }}>
              ✓ 商店在架版本与自托管最新版一致（都是 v{latestVersion}），两条通道装哪个都一样。
            </div>
          )}
          {behind === null && (
            <div className="small muted" style={{ marginTop: 12 }}>
              商店在架版本号未登记（运维可在 <code className="mono">BEACON_EXT_STORE_CHROME_VERSION</code> 填一次），
              具体版本以商店页面显示为准。
            </div>
          )}
        </Card>
      )}

      <Card
        title="选择你的浏览器"
        sub="Chrome / Edge / 360 / Brave 同为 Chromium，同一个包通用 · 仅 Chrome 上架商店，其余走 zip 开发者模式加载"
        style={{ marginBottom: 16 }}
        action={<span className="badge badge-brand"><Icon.shield size={13} /> 最小主机权限 · 只采可见公开数据</span>}
      >
        <div className="grid grid-2" style={{ gap: 12 }}>
          {BROWSER_CARDS.map((card) => (
            <BrowserCardView key={card.key} card={card} chromeUrl={links.chrome} zipHref={zipHref} latestVersion={latestVersion} />
          ))}
        </div>
        {!links.chrome && (
          <div className="alert-gradient-amber" style={{ padding: '10px 14px', marginTop: 14 }}>
            <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
              <span className="row" style={{ color: 'var(--amber)', flexShrink: 0 }}><Icon.shield size={16} /></span>
              <span className="small" style={{ opacity: 0.9, lineHeight: 1.7 }}>
                Chrome 应用商店入口当前被显式关闭（<code className="mono">BEACON_EXT_STORE_CHROME</code> 被置空）。
                请用下方 <b>zip + 开发者模式加载</b> 安装。
              </span>
            </div>
          </div>
        )}
      </Card>

      <div className="grid grid-2" style={{ marginBottom: 16 }}>
        <Card title="开发者模式加载（zip 通用步骤）" sub="商店审核期 / 企业内网走这条">
          {zipHref ? (
            <ol className="stack" style={{ gap: 10, paddingLeft: 18, margin: 0 }}>
              <li className="small" style={{ lineHeight: 1.7 }}>
                <a href={zipHref} download style={{ color: 'var(--brand)', fontWeight: 600 }}>下载 zip 安装包 ↓</a>
                ，解压到一个<b>不会被删</b>的固定文件夹。
              </li>
              <li className="small" style={{ lineHeight: 1.7 }}>
                地址栏进扩展页：Chrome <code className="mono">chrome://extensions</code> · Edge <code className="mono">edge://extensions</code> · 360 在「扩展中心」。
              </li>
              <li className="small" style={{ lineHeight: 1.7 }}>右上角打开<b>开发者模式</b>。</li>
              <li className="small" style={{ lineHeight: 1.7 }}>点<b>「加载已解压的扩展程序」</b>，选择刚解压的文件夹。</li>
              <li className="small" style={{ lineHeight: 1.7 }}>装好后在右侧填入采集令牌，即可开始使用。</li>
            </ol>
          ) : (
            <Empty icon="📦" text="还没打包安装包。在项目根目录执行 npm run pack:ext 生成 zip 后刷新本页。" />
          )}
        </Card>

        <Card title="填入采集令牌" sub="装好插件后这一步才能回传数据">
          <div className="stack" style={{ gap: 10 }}>
            <p className="small muted" style={{ lineHeight: 1.7 }}>
              插件本身不含你的身份——它靠<b>采集令牌</b>认工作区。安装后：
            </p>
            <ol className="stack" style={{ gap: 8, paddingLeft: 18, margin: 0 }}>
              <li className="small" style={{ lineHeight: 1.7 }}>
                在下方为<b>这台设备</b>签发一枚采集令牌（每台设备各一枚，可单独吊销）。
              </li>
              <li className="small" style={{ lineHeight: 1.7 }}>打开插件设置页，填入<b>烽火台地址</b>与<b>采集令牌</b>，点「测试连接」。</li>
              <li className="small" style={{ lineHeight: 1.7 }}>
                到 <Link href="/competitors" style={{ color: 'var(--brand)', fontWeight: 600 }}>竞对监控</Link> 订阅竞对，打开其公开主页即自动采集。
              </li>
            </ol>
            <div style={{ marginTop: 8 }}>
              <IngestTokenCard active={tokens.active} revoked={tokens.revoked} legacyToken={legacyToken} />
              <ExtAutoConfig host={process.env.NEXT_PUBLIC_APP_URL || 'https://beacon.iyunci.cn'} />
            </div>
          </div>
        </Card>
      </div>

      <div className="grid grid-2">
        <Card title="合规边界" sub="只采你在页面上亲眼可见的公开数据">
          <div className="stack" style={{ gap: 10 }}>
            <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
              <span style={{ color: 'var(--green)', flexShrink: 0 }}><Icon.check size={16} /></span>
              <span className="small" style={{ lineHeight: 1.7 }}>
                <b>采的永远是公开主页上已渲染、你亲眼可见的 DOM，不碰登录态接口。</b>除了你当场点击，还有一处是自动的：<b>每日定时采集默认开启</b>，插件会在你设定的时间（默认 09:00）用<b>后台标签页</b>逐个打开你自己已订阅的竞对公开主页，采完立即关闭，可在插件设置里关掉。范围与手动采集完全相同，不因自动化而扩大。
              </span>
            </div>
            <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
              <span style={{ color: 'var(--green)', flexShrink: 0 }}><Icon.check size={16} /></span>
              <span className="small" style={{ lineHeight: 1.7 }}>
                <b>最小主机权限。</b>0.8.2 起申请 8 条路径，全部是 B站/抖音/小红书/X/YouTube/TikTok 的<b>公开作品页</b>——为了让「读评论提问」在页内侧栏上也能用（activeTab 只在你点扩展自己的界面时授予，点页内按钮拿不到）。<b>不含任何创作者后台域名</b>。回传本身不依赖主机权限，走服务端 CORS + 令牌头，令牌只授权「向本工作区订阅的竞对补充公开数据」。
              </span>
            </div>
            <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
              <span style={{ color: 'var(--green)', flexShrink: 0 }}><Icon.check size={16} /></span>
              <span className="small" style={{ lineHeight: 1.7 }}>
                <b>他人/竞对：只采各平台已公开发布的账号与作品信息</b>，不碰任何非公开数据。<b>你自己的作品另算</b>：在你本人已登录的创作者后台里，插件会读你自己作品的表现数字（含公开页拿不到的完播率/完读率）——那是你自己的数据，只回传到你自己的工作区。两种情况都<b>不托管、不上传任何平台凭证</b>。若你是被监控账号主体，可
                <a href="/legal/data-request" target="_blank" style={{ color: 'var(--brand)', fontWeight: 600 }}>申请移除监控 →</a>
              </span>
            </div>
          </div>
        </Card>

        <Card title="数据源机制" sub="双源冗余保障，高稳定性采集保障">
          <div className="stack" style={{ gap: 10 }}>
            <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
              <span style={{ color: 'var(--brand)', flexShrink: 0 }}><Icon.sparkles size={16} /></span>
              <span className="small" style={{ lineHeight: 1.7 }}>
                <b>开源自建为主</b>：热榜聚合与基础公开数据优先走<b>自建 DailyHotApi 实例</b>，性能轻量稳定，对第三方商业依赖极低。
              </span>
            </div>
            <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
              <span style={{ color: 'var(--brand)', flexShrink: 0 }}><Icon.sparkles size={16} /></span>
              <span className="small" style={{ lineHeight: 1.7 }}>
                <b>商业 API 兜底</b>：如小红书、抖音等风控极严的公开页面，提供<b>商业数据源（如 TikHub/天行等）作为熔断备份通道</b>。
              </span>
            </div>
            <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
              <span style={{ color: 'var(--brand)', flexShrink: 0 }}><Icon.sparkles size={16} /></span>
              <span className="small" style={{ lineHeight: 1.7 }}>
                <b>双源冗余切换</b>：系统将实时监测主通道风控阻断状态。一旦开源接口失效，将<b>自动在秒级切入备份通道</b>，双源冗余不削弱。
              </span>
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}
