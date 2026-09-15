import Link from 'next/link';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { Fold } from '@/components/ui';
import { fmtDate } from '@/lib/format';
import { platformName } from '@/lib/constants';
import { parseJson } from '@/lib/json';
import { can } from '@/lib/edition';
import { listPlans } from '@/lib/publish/plan';
import { PUBLISH_CAPS, channelLabel, TASK_STATUS_LABEL, TASK_STATUS_LABEL_EN } from '@/lib/publish/capability';
import { PublishKanban, OpenPlans } from './PlanBoard';
import { MakeTabs } from '@/components/MakeTabs';
import { HubHeader } from '@/components/HubHeader';
import { getServerLang } from '@/lib/i18n/server';
import { getDictionary } from '@/lib/i18n/dict';

export const dynamic = 'force-dynamic';

export default async function PublishPage({ searchParams }: { searchParams: Promise<{ plan?: string }> }) {
  const s = await getSession();
  // 机器人回执与 /runs 的「发布计划」链接都指向 /publish?plan=<id>（lib/agent/artifacts.ts:21、
  // runs/WorkBoard.tsx:99）。本页原来**根本不收这个参数**，点进来只看到最近 8 条 open 计划，
  // 那条具体计划很可能不在里面——链接是坏的，而且不报错。
  const { plan: pinnedPlanId } = await searchParams;
  const lang = await getServerLang();
  const dict = getDictionary(lang);

  const [openPlans, recentDone, drafts, records, missingLink, wxCred] = await Promise.all([
    listPlans({ workspaceId: s.workspaceId, accountId: s.accountId }, { status: 'open', take: 8, includeId: pinnedPlanId }),
    listPlans({ workspaceId: s.workspaceId, accountId: s.accountId }, { status: 'done', take: 5 }),
    prisma.draft.findMany({
      where: { accountId: s.accountId, status: { notIn: ['published', 'abandoned'] }, versions: { some: {} } },
      orderBy: { updatedAt: 'desc' },
      take: 12,
      select: { id: true, title: true, platform: true, updatedAt: true },
    }),
    prisma.publishRecord.findMany({
      where: { accountId: s.accountId },
      orderBy: { publishedAt: 'desc' },
      take: 8,
      select: { id: true, title: true, platform: true, publishedAt: true, needsBackfill: true, platformItemId: true, metrics: true },
    }),
    // 「缺链接的记录」是账号全量口径，不是上面那 8 条里数出来的
    prisma.publishRecord.count({ where: { accountId: s.accountId, needsBackfill: true } }),
    prisma.publishCredential.findUnique({
      where: { accountId_platform: { accountId: s.accountId, platform: 'wechat' } },
      select: { status: true, lastError: true },
    }),
  ]);

  // needsBackfill=false 只说明有作品链接/ID，不等于播放、点赞已经回流：metrics 还是空的就是「待回流」
  const hasMetrics = (metrics: string) => Object.keys(parseJson<Record<string, unknown>>(metrics, {})).length > 0;
  // （waitingOnYou 与 accountName 原本算在这儿，两个都一次没进过 JSX；accountName 还为此
  //   多查一条 creatorAccount。生产库跨区一跳 32ms，纯亏，一并删掉。）

  return (
    <>
      <HubHeader
        title={dict.tabs.makeTitle}
        tabs={<MakeTabs active="publish" inline />}
      />

      <PublishKanban
        plans={openPlans.map((p) => ({
          id: p.id,
          draftId: p.draftId,
          status: p.status,
          tasks: p.tasks,
          draftTitle: p.draftTitle,
          createdAt: p.createdAt.toISOString(),
        }))}
        drafts={drafts.map((d) => ({
          id: d.id,
          title: d.title,
          platform: d.platform,
          updatedAt: d.updatedAt.toISOString(),
        }))}
        records={records.map((r) => ({
          id: r.id,
          title: r.title ?? '',
          platform: r.platform,
          publishedAt: r.publishedAt ? r.publishedAt.toISOString() : '',
          // 三态只算一次、只在这一处（看板与提示行共用），不再让两个地方各说各的
          syncState: r.needsBackfill ? 'missing-url' as const : hasMetrics(r.metrics) ? 'synced' as const : 'awaiting' as const,
        }))}
      />

      <Fold
        title={lang === 'en' ? 'Platform Channel Capabilities Matrix' : '平台通道能力矩阵'}
        sub={lang === 'en' ? 'Direct API, extension autofill, or manual posting per platform' : '哪些平台能直发、哪些插件代填、哪些只能手动'}
        note={<span className="small muted">{lang === 'en' ? 'Reference' : '参考 · 看一次就够'}</span>}
      >
        <div style={{ overflowX: 'auto' }}>
          <table className="table" style={{ minWidth: 620 }}>
            <thead>
              <tr>
                <th>{lang === 'en' ? 'Platform' : '平台'}</th>
                <th>{lang === 'en' ? 'Channel' : '通道'}</th>
                <th>{lang === 'en' ? 'Prerequisites' : '需要你先做什么'}</th>
                <th>{lang === 'en' ? 'Why this route' : '为什么是这条'}</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(PUBLISH_CAPS).map(([p, cap]) => (
                <tr key={p}>
                  <td>
                    <strong>{platformName(p, lang) || p}</strong>
                  </td>
                  <td className="small">
                    <span
                      className={`badge ${
                        cap.channel === 'api' ? 'badge-green' : cap.channel === 'extension' ? 'badge-amber' : 'badge-gray'
                      }`}
                    >
                      {channelLabel(cap.channel, lang)}
                    </span>
                    {cap.channel === 'extension' && cap.calibrated === false && (
                      <div className="small muted" style={{ marginTop: 4 }}>
                        {lang === 'en' ? 'Script not calibrated' : '填充脚本未真机校准'}
                      </div>
                    )}
                  </td>
                  <td className="small muted">{cap.requires || '—'}</td>
                  <td className="small muted">{cap.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {can('localPublisher') && (
          <p className="small" style={{ marginTop: 10, lineHeight: 1.8 }}>
            {lang === 'en' ? (
              <>
                💡 A third path exists on this machine: <b>Local Publisher</b>. Run <code className="mono">npm run publisher</code> on the server to open a dedicated browser, log into your platforms once, and future publish tasks will automatically open and fill the page (fill only by default, set <code className="mono">BEACON_PUBLISHER_AUTO_CLICK=1</code> to click publish). Login state stays strictly on this machine. (Not available on SaaS).
              </>
            ) : (
              <>
                💡 这台机器上还有第三条路：<b>本地发布器</b>。在服务器上跑一次
                <code className="mono"> npm run publisher </code>
                会打开一个常驻浏览器，你在里面把各平台登录一遍，之后发布任务由它自动打开发布页填好
                （默认只填不点，设 <code className="mono">BEACON_PUBLISHER_AUTO_CLICK=1</code> 才代点）。
                登录态只留在这台机器上，不上传、不外发。SaaS 版没有这一条——机房里的服务端够不到你的浏览器。
              </>
            )}
          </p>
        )}
        {wxCred ? (
          <p className="small" style={{ marginTop: 10 }}>
            {lang === 'en' ? 'WeChat Credential: ' : '公众号凭证：'}
            <span className={`badge ${wxCred.status === 'ok' ? 'badge-green' : 'badge-amber'}`}>
              {wxCred.status === 'ok' ? (lang === 'en' ? 'Active' : '可用') : wxCred.status === 'failed' ? (lang === 'en' ? 'Last call failed' : '上次调用失败') : (lang === 'en' ? 'Pending' : '待验证')}
            </span>
            {wxCred.lastError && <span className="muted"> · {wxCred.lastError}</span>}
          </p>
        ) : (
          <p className="small muted" style={{ marginTop: 10 }}>
            {lang === 'en' ? (
              <>WeChat credentials not configured; direct API publishing is unavailable. Go to <Link href="/settings/keys">Integrations & Keys · Publishing Channels</Link> to enter AppID / AppSecret.</>
            ) : (
              <>还没配公众号凭证，接口直发这条路走不通。去 <Link href="/settings/keys">接入与密钥 · 发布通道</Link> 填 AppID / AppSecret。</>
            )}
          </p>
        )}
      </Fold>

      {/* ── 进行中的计划：逐条任务操作（2026-09-12 接回来的）──
          OpenPlans 一直导出着，但**全仓库零渲染**：本页只挂了 PublishKanban，而看板只拿 plans
          算第二列的计数与卡片。后果是 PlanTasks 上的「存草稿箱 / 贴链接 / 标记已发布」
          只有在「新建发布计划」弹窗刚建完那一刻按得到，关掉或刷新就再也找不到——
          存量计划等于推不动。与「正文配图」「插件一键采集」是同一类：功能在、入口没了、还不报错。 */}
      {openPlans.length > 0 && (
        <Fold
          title={lang === 'en' ? 'Active Plans · Per-task Actions' : '进行中的计划 · 逐条推进'}
          sub={lang === 'en' ? 'Save to drafts box, paste the post URL, mark as published' : '存草稿箱 / 贴作品链接 / 标记已发布——每条任务各自推进'}
          defaultOpen={true}
        >
          <OpenPlans
            plans={[...openPlans]
              // 点着 ?plan= 进来的那条排最前，用户一眼就看到自己要推进的是哪个
              .sort((a, b) => (a.id === pinnedPlanId ? -1 : b.id === pinnedPlanId ? 1 : 0))
              .map((p) => ({
              id: p.id,
              draftId: p.draftId,
              status: p.status,
              tasks: p.tasks,
              draftTitle: p.draftTitle,
              createdAt: p.createdAt.toISOString(),
            }))}
          />
        </Fold>
      )}

      {/* 【删掉了整张「最近发布记录」】它把看板第三列那同一批 8 条 publishRecord 又印了一遍，
          而且两处说法相反（看板对每条写死「已回流数据」，这里对同一条写「待回流」）。
          三态判据已经搬进看板第三列每张卡，补链接的真操作本来就只在 /data 的
          「发布效果与表现明细」里——这张卡从来只是个跳板，留下跳板那一句就够。 */}
      {missingLink > 0 && (
        <p className="small" style={{ marginTop: 12, color: 'var(--text-2)' }}>
          {lang === 'en'
            ? `💡 ${missingLink} records missing post URLs. Add them in `
            : `💡 有 ${missingLink} 条记录尚未关联作品链接。建议前往 `}
          <Link href="/data" style={{ color: 'var(--brand)', fontWeight: 600 }}>{lang === 'en' ? 'Data Dashboard' : '数据看板'}</Link>
          {lang === 'en' ? ' to enable automatic analytics sync.' : ' 补上，发布后的播放、点赞数据才能自动回流。'}
        </p>
      )}

      {recentDone.length > 0 && (
        <Fold
          title={lang === 'en' ? 'Completed Plans' : '已完成的计划'}
          sub={lang === 'en' ? 'All tasks reached terminal state (published / skipped / failed)' : '所有任务都走到终态（已发布 / 跳过 / 失败）'}
          note={<span className="small muted">{lang === 'en' ? 'Archive' : '回看才翻'}</span>}
        >
          <div style={{ display: 'grid', gap: 8 }}>
            {recentDone.map((p) => (
              <div key={p.id} className="row-between wrap small" style={{ gap: 8 }}>
                <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <strong>{p.draftTitle}</strong>
                  {p.tasks.map((t) => (
                    <span key={t.id} className="badge badge-gray">
                      {t.platformLabel} · {lang === 'en' ? (TASK_STATUS_LABEL_EN[t.status] ?? t.status) : (TASK_STATUS_LABEL[t.status] ?? t.status)}
                    </span>
                  ))}
                </span>
                <span className="muted">{fmtDate(p.createdAt)}</span>
              </div>
            ))}
          </div>
        </Fold>
      )}
    </>
  );
}
