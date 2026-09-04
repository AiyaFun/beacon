import Link from 'next/link';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { Card, Stat, Fold } from '@/components/ui';
import { fmtDate } from '@/lib/format';
import { platformName } from '@/lib/constants';
import { can } from '@/lib/edition';
import { listPlans } from '@/lib/publish/plan';
import { PUBLISH_CAPS, channelLabel, TASK_STATUS_LABEL } from '@/lib/publish/capability';
import { CHANNEL_INTRO } from './PlanTasks';
import { OpenPlans, NewPlan } from './PlanBoard';
import { MakeTabs } from '@/components/MakeTabs';
import { HubHeader } from '@/components/HubHeader';
import { getServerLang } from '@/lib/i18n/server';
import { getDictionary } from '@/lib/i18n/dict';

export const dynamic = 'force-dynamic';

export default async function PublishPage() {
  const s = await getSession();
  const lang = await getServerLang();
  const dict = getDictionary(lang);

  const [openPlans, recentDone, drafts, records, wxCred, account] = await Promise.all([
    listPlans({ workspaceId: s.workspaceId, accountId: s.accountId }, { status: 'open', take: 8 }),
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
      select: { id: true, title: true, platform: true, publishedAt: true, needsBackfill: true, platformItemId: true },
    }),
    prisma.publishCredential.findUnique({
      where: { accountId_platform: { accountId: s.accountId, platform: 'wechat' } },
      select: { status: true, lastError: true },
    }),
    prisma.creatorAccount.findUnique({ where: { id: s.accountId }, select: { name: true } }),
  ]);

  const allTasks = openPlans.flatMap((p) => p.tasks);
  const waitingOnYou = allTasks.filter((t) => t.status === 'filled' || t.status === 'submitted').length;
  const missingLink = records.filter((r) => r.needsBackfill).length;

  return (
    <>
      <HubHeader
        title={dict.tabs.makeTitle}
        hint={lang === 'en'
          ? `Publishing pipeline · Current account: ${account?.name ?? 'Unnamed'}`
          : `把稿子发出去的那一段 · 只显示当前账号（${account?.name ?? '未命名账号'}）的计划与记录`}
        tabs={<MakeTabs active="publish" inline />}
        meta={<span className="small muted hide-mobile">{lang === 'en' ? 'Current Account: ' : '当前账号：'}{account?.name ?? (lang === 'en' ? 'Unnamed' : '未命名')}</span>}
      />

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat
          label={lang === 'en' ? 'Active Schedules' : '进行中的计划'}
          value={openPlans.length}
          foot={lang === 'en' ? `${allTasks.length} platform tasks` : `共 ${allTasks.length} 条平台任务`}
        />
        <Stat
          label={lang === 'en' ? 'Waiting on You' : '等你去点发布'}
          value={waitingOnYou}
          foot={lang === 'en' ? 'Draft ready in backend' : '已填进后台 / 已进草稿箱'}
        />
        <Stat
          label={lang === 'en' ? 'Ready Drafts' : '可发布的稿子'}
          value={drafts.length}
          foot={lang === 'en' ? 'Drafts with body ready' : '有正文且未发布'}
        />
        <Stat
          label={lang === 'en' ? 'Missing URL' : '缺链接的记录'}
          value={missingLink}
          foot={lang === 'en' ? 'Link post to sync data' : '补上才能自动回流'}
          href="/data"
        />
      </div>

      <Card title="进行中的发布计划" sub="每个平台一条任务，各走各的通道，互不牵连">
        <p className="small muted" style={{ marginTop: 0, lineHeight: 1.7 }}>
          {CHANNEL_INTRO}
        </p>
        <OpenPlans
          plans={openPlans.map((p) => ({
            id: p.id,
            draftId: p.draftId,
            status: p.status,
            tasks: p.tasks,
            draftTitle: p.draftTitle,
            createdAt: p.createdAt.toISOString(),
          }))}
        />
      </Card>

      <Card title="开一条新的发布计划" sub="选一篇写好的稿子 → 勾平台 → 生成任务" style={{ marginTop: 16 }}>
        <NewPlan
          drafts={drafts.map((d) => ({
            id: d.id,
            title: d.title,
            platform: d.platform,
            updatedAt: d.updatedAt.toISOString(),
          }))}
        />
      </Card>

      <Fold title="平台通道能力矩阵" sub="哪些平台能直发、哪些插件代填、哪些只能手动" note={<span className="small muted">参考 · 看一次就够</span>}>
        <div style={{ overflowX: 'auto' }}>
          <table className="table" style={{ minWidth: 620 }}>
            <thead>
              <tr>
                <th>平台</th>
                <th>通道</th>
                <th>需要你先做什么</th>
                <th>为什么是这条</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(PUBLISH_CAPS).map(([p, cap]) => (
                <tr key={p}>
                  <td>
                    <strong>{platformName(p) || p}</strong>
                  </td>
                  <td className="small">
                    <span
                      className={`badge ${
                        cap.channel === 'api' ? 'badge-green' : cap.channel === 'extension' ? 'badge-amber' : 'badge-gray'
                      }`}
                    >
                      {channelLabel(cap.channel)}
                    </span>
                    {cap.channel === 'extension' && cap.calibrated === false && (
                      <div className="small muted" style={{ marginTop: 4 }}>
                        填充脚本未真机校准
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
            💡 这台机器上还有第三条路：<b>本地发布器</b>。在服务器上跑一次
            <code className="mono"> npm run publisher </code>
            会打开一个常驻浏览器，你在里面把各平台登录一遍，之后发布任务由它自动打开发布页填好
            （默认只填不点，设 <code className="mono">BEACON_PUBLISHER_AUTO_CLICK=1</code> 才代点）。
            登录态只留在这台机器上，不上传、不外发。SaaS 版没有这一条——机房里的服务端够不到你的浏览器。
          </p>
        )}
        {wxCred ? (
          <p className="small" style={{ marginTop: 10 }}>
            公众号凭证：
            <span className={`badge ${wxCred.status === 'ok' ? 'badge-green' : 'badge-amber'}`}>
              {wxCred.status === 'ok' ? '可用' : wxCred.status === 'failed' ? '上次调用失败' : '待验证'}
            </span>
            {wxCred.lastError && <span className="muted"> · {wxCred.lastError}</span>}
          </p>
        ) : (
          <p className="small muted" style={{ marginTop: 10 }}>
            还没配公众号凭证，接口直发这条路走不通。去 <Link href="/settings/keys">接入与密钥 · 发布通道</Link> 填 AppID / AppSecret。
          </p>
        )}
      </Fold>

      <Card title="最近发布记录" sub="发布记录是数据回流的入口：缺链接的记录学不到任何数据" style={{ marginTop: 16 }}>
        {records.length === 0 ? (
          <p className="small muted">还没有发布记录。</p>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {records.map((r) => (
              <div key={r.id} className="row-between wrap small" style={{ gap: 8 }}>
                <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <span className="badge badge-gray">{platformName(r.platform) || r.platform}</span>
                  <strong>{r.title || '（无标题）'}</strong>
                  {r.needsBackfill && <span className="badge badge-amber">缺链接</span>}
                </span>
                <span className="muted">{fmtDate(r.publishedAt)}</span>
              </div>
            ))}
          </div>
        )}
        {missingLink > 0 && (
          <p className="small" style={{ marginTop: 10 }}>
            有 {missingLink} 条记录还没贴作品链接。到 <Link href="/data">数据看板</Link> 补上，之后的播放/点赞才能自动回流。
          </p>
        )}
      </Card>

      {recentDone.length > 0 && (
        <Fold title="已完成的计划" sub="所有任务都走到终态（已发布 / 跳过 / 失败）" note={<span className="small muted">回看才翻</span>}>
          <div style={{ display: 'grid', gap: 8 }}>
            {recentDone.map((p) => (
              <div key={p.id} className="row-between wrap small" style={{ gap: 8 }}>
                <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <strong>{p.draftTitle}</strong>
                  {p.tasks.map((t) => (
                    <span key={t.id} className="badge badge-gray">
                      {t.platformLabel} · {TASK_STATUS_LABEL[t.status] ?? t.status}
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
