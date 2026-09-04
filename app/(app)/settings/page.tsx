import Link from 'next/link';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { sourceHealthBoard } from '@/lib/adapters/registry';
import { platformName } from '@/lib/constants';
import { embedderInfo } from '@/lib/vector/embed';
import { Card, Stat } from '@/components/ui';
import { Icon } from '@/components/icons';
import { AutomationCard, type LastRun } from './AutomationCard';
import { readAutomationConfig, AUTOMATION_ITEMS } from '@/lib/jobs/automation';
import { HubHeader } from '@/components/HubHeader';
import { can as canEdition } from '@/lib/edition';
import { LocalShellCard } from './LocalShellCard';

import { getServerLang } from '@/lib/i18n/server';
import { getDictionary } from '@/lib/i18n/dict';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const s = await getSession();
  const lang = await getServerLang();
  const dict = getDictionary(lang);
  const [providers, board, workspace, jobRuns] = await Promise.all([
    prisma.modelProvider.count({ where: { tenantId: s.tenantId } }),
    sourceHealthBoard(),
    prisma.workspace.findUnique({ where: { id: s.workspaceId }, select: { automationConfig: true } }),
    prisma.jobRun.findMany({
      where: { name: { in: AUTOMATION_ITEMS.map((i) => i.job).filter((j): j is NonNullable<typeof j> => j !== null) } },
      orderBy: { id: 'desc' },
      take: 40,
      select: { name: true, status: true, detail: true, finishedAt: true, startedAt: true },
    }),
  ]);

  const embed = embedderInfo(); // 语义向量实况（真模型 / 哈希近似），用于「降级说破」

  // 每个任务的最近一次运行（按 id 降序取首个命中）
  const lastRuns: Record<string, LastRun> = {};
  for (const r of jobRuns) {
    if (lastRuns[r.name]) continue;
    lastRuns[r.name] = { status: r.status, detail: r.detail, at: (r.finishedAt ?? r.startedAt).toISOString() };
  }
  const automationConfig = readAutomationConfig(workspace?.automationConfig);

  const enabledJobs = AUTOMATION_ITEMS.filter((i) => automationConfig[i.key] !== false).length;
  const failedRecently = Object.values(lastRuns).filter((r) => r?.status === 'failed').length;

  // 本机命令执行的现有配置（只有整机版会用到，SaaS 取了也不渲染）
  const shellCfg = (await prisma.workspace.findUnique({
    where: { id: s.workspaceId },
    select: { shellEnabled: true, shellAllow: true, shellRoot: true, shellExecMode: true, shellTimeoutSec: true, browserCdpUrl: true },
  })) ?? { shellEnabled: false, shellAllow: '[]', shellRoot: null, shellExecMode: 'allowlist', shellTimeoutSec: 20, browserCdpUrl: null };

  return (
    <>
      <HubHeader
        title={dict.settings.settingsTitle}
        hint={lang === 'en' ? 'Background jobs, data source status & semantic vector status · Configure keys in API Keys' : '后台任务、数据源与语义向量的实况 · 所有要填 Key 的地方都在「接入与密钥」'}
        action={
          <Link href="/settings/keys" className="btn btn-sm btn-primary">
            <Icon.cpu size={13} /> {lang === 'en' ? 'API Keys & Channels' : '接入与密钥'}
          </Link>
        }
      />

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat
          label={lang === 'en' ? 'Model Providers' : '模型渠道'}
          value={providers}
          foot={lang === 'en' ? 'Manage in API Keys' : '去「接入与密钥」管理'}
          href="/settings/keys"
        />
        <Stat
          label={lang === 'en' ? 'Active Jobs' : '启用中的任务'}
          value={enabledJobs}
          foot={lang === 'en' ? `${AUTOMATION_ITEMS.length} total tasks` : `共 ${AUTOMATION_ITEMS.length} 项`}
        />
        <Stat
          label={lang === 'en' ? 'Recent Failures' : '最近失败任务'}
          value={failedRecently}
          foot={lang === 'en' ? 'See task details below' : '看下方任务卡的详情'}
        />
        <Stat
          label={lang === 'en' ? 'Hotlist Sources' : '热榜数据源'}
          value={board.hot.length}
          foot={lang === 'en' ? 'Includes fallback routes' : '含降级链路'}
        />
      </div>

      <Card
        title={lang === 'en' ? '🤖 Automated Background Tasks' : '🤖 自动化任务'}
        sub={lang === 'en' ? 'Scheduled jobs for daily recommendations, sync & weekly review' : '每日推荐 / 数据同步 / 自动复盘等定时任务的开关 · 可关可调可见'}
        style={{ marginBottom: 16 }}
      >
        <AutomationCard config={automationConfig} lastRuns={lastRuns} />

        {/* 本机命令执行：只在整机版/私有化出现。SaaS 连这张卡都不该看见——
            看得见开关却永远开不了，只会让人反复来问「为什么我开不了」 */}
        {canEdition('localShell') && (
          <LocalShellCard
            enabled={shellCfg.shellEnabled}
            allow={(() => { try { return JSON.parse(shellCfg.shellAllow) as string[]; } catch { return []; } })()}
            root={shellCfg.shellRoot}
            mode={shellCfg.shellExecMode}
            timeoutSec={shellCfg.shellTimeoutSec}
            cdpUrl={shellCfg.browserCdpUrl}
            canBrowser={canEdition('localBrowser')}
          />
        )}
      </Card>

      {/* ── 竞对数据源（2026-08-29 补）──
          隐私政策里写着「未配置时…**界面上会显示为数据源未启用**」，
          而 sourceHealthBoard() 返回的 competitor 那一半此前**一处都没渲染过**——
          那句承诺零代码兑现。用户看到的是「加了竞对、点进去空白」，界面上不说为什么。
          这比没有这个功能更伤：没有功能他不会失望，有入口点了没数据他会认为产品坏了。 */}
      <Card title="竞对数据源" sub="每个平台现在到底取不取得到数据 · 服务端 / 要插件 / 没有">
        <div className="stack" style={{ gap: 8 }}>
          {board.competitor.map((c) => {
            // 三态分开说：「要装插件」他能自己解决，「真的没有」他做什么都没用。
            // 合并成「未启用」等于把能解决的问题说成解决不了的。
            const label = c.status === 'server'
              ? { text: '服务端可取', cls: 'badge-green', foot: c.name }
              : c.status === 'plugin'
                ? { text: '要装采集助手', cls: 'badge-amber', foot: '这个平台服务端拿不到，装上浏览器插件后由它采' }
                : { text: '暂无数据源', cls: 'badge-gray', foot: '服务端没有通道，插件也采不了——加了竞对也不会有数据' };
            return (
              <div key={c.platform} className="row-between wrap" style={{ gap: 8, padding: '6px 0' }}>
                <span className="row" style={{ gap: 8, alignItems: 'center' }}>
                  <span className={`dot ${c.status === 'server' ? 'dot-green' : 'dot-amber'}`} />
                  <span className="small">{platformName(c.platform)}</span>
                  <span className={`badge ${label.cls}`}>{label.text}</span>
                </span>
                <span className="small muted">{label.foot}</span>
              </div>
            );
          })}
        </div>
        <p className="small muted" style={{ margin: '10px 0 0', lineHeight: 1.85 }}>
          标着<b>暂无数据源</b>的平台，现在加了竞对也不会有数据——这不是故障，是这条通道还不存在。
        </p>

        {/* ── 自建 RSSHub（2026-08-31 补）──
            它是竞对链上唯一一条「你自己部署、可能已经死掉」的通道，而且是**一个共享实例**，
            逐平台各显示一次没有意义。不把它单独摆出来的话，「这个容器该留还是该停」
            只能靠人去服务器上 docker ps —— 而它的 health() 此前还是个无条件返回 ok 的桩，
            即便被调用也永远说「好」。 */}
        <div
          className="row-between wrap"
          style={{ gap: 8, marginTop: 10, paddingTop: 10, borderTop: '1px dashed var(--border)' }}
        >
          <span className="row" style={{ gap: 8, alignItems: 'center' }}>
            <span className={`dot ${board.rsshub.ok ? 'dot-green' : board.rsshub.configured ? 'dot-red' : 'dot-amber'}`} />
            <span className="small">自建 RSSHub（备用通道）</span>
            <span className={`badge ${board.rsshub.ok ? 'badge-green' : board.rsshub.configured ? 'badge-red' : 'badge-gray'}`}>
              {board.rsshub.ok ? '在跑' : board.rsshub.configured ? '连不上' : '未配置'}
            </span>
          </span>
          <span className="small muted">{board.rsshub.detail}</span>
        </div>
        {board.rsshub.configured && !board.rsshub.ok && (
          <p className="small" style={{ margin: '6px 0 0', color: 'var(--danger)', lineHeight: 1.85 }}>
            配了地址但连不上——上面标着 <code>rsshub</code> 的那几条链现在实际走的是主源，
            主源没配的话就是取不到。要么把容器起回来，要么把 <code>BEACON_RSSHUB_BASE_URL</code> 拿掉，
            <b>别让它挂在链上当摆设</b>。
          </p>
        )}
      </Card>

      <Card title="热榜数据源" sub="开源自建为主，商业 API 兜底，双源冗余">
        <div className="stack" style={{ gap: 8 }}>
          {board.hot.map((h) => (
            <div key={h.name} className="row-between wrap" style={{ gap: 8, padding: '6px 0' }}>
              <span className="row" style={{ gap: 8, alignItems: 'center' }}>
                <span className={`dot ${h.ok ? 'dot-green' : 'dot-amber'}`} />
                <span className="small">{h.name}</span>
                <span className="badge badge-gray">{h.kind}</span>
              </span>
              <span className="small muted">{h.detail ?? (h.ok ? '正常' : '降级中')}</span>
            </div>
          ))}
        </div>

        <div className="divider" style={{ margin: '14px 0' }} />
        <div className="row-between wrap" style={{ gap: 8 }}>
          <span className="row" style={{ gap: 8, alignItems: 'center' }}>
            <span className={`dot ${embed.mocked ? 'dot-amber' : 'dot-green'}`} />
            <span className="small">语义向量（记忆召回 / 话题聚类 / 选题粗排）</span>
            <span className="badge badge-gray">{embed.mocked ? '哈希近似' : embed.model}</span>
          </span>
          <span className="small muted">
            {embed.mocked ? '未配嵌入模型，按字面相似度近似' : '真实嵌入模型'}
          </span>
        </div>

        <div className="divider" style={{ margin: '14px 0' }} />
        <p className="small muted" style={{ lineHeight: 1.7 }}>
          <b>数据来源透明披露：</b>竞对监控仅采集各平台已公开发布的账号与作品信息，不获取任何非公开数据、不托管平台凭证。
          若你是被监控账号主体，可
          <a href="/legal/data-request" target="_blank" style={{ color: 'var(--brand)', fontWeight: 600 }}>申请移除监控 →</a>
        </p>
      </Card>
    </>
  );
}
