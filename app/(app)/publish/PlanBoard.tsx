'use client';

import { useState } from 'react';
import Link from 'next/link';
import { fmtDateTime, fmtDate } from '@/lib/format';
import { PlanCreator, PlanTasks, type PlanView } from './PlanTasks';
import { useI18n } from '@/lib/i18n';
import { Icon } from '@/components/icons';
import { platformName } from '@/lib/constants';
import { Overlay } from '@/components/Overlay';

// 发布中心页面上的两块交互：进行中的计划、给某篇稿子新建计划。
//
// 【为什么是客户端组件】任务往下走要一条一条点（写草稿箱 → 贴链接 → 标记已发布），
// 每点一次都要拿回新的任务状态。挂在服务端渲染的卡片里就是本项目记过的那个坑：
// server action 一 revalidate 就重渲当前路由，正在填的那个输入框连同刚拿到的
// 计划一起被冲掉，用户「做完还要接着点」的下一步就没了。所以计划的状态留在客户端。

export function OpenPlans({
  plans,
}: {
  plans: (PlanView & { draftTitle: string; createdAt: string })[];
}) {
  const { lang } = useI18n();
  const isEn = lang === 'en';
  const [live, setLive] = useState<Record<string, PlanView>>({});

  if (plans.length === 0) {
    return (
      <div className="publish-empty-box">
        <div className="publish-empty-icon">
          <Icon.upload size={22} />
        </div>
        <div className="publish-empty-title">
          {isEn ? 'No Active Publishing Plans' : '暂无进行中的发布计划'}
        </div>
        <div className="publish-empty-desc">
          {isEn
            ? 'Pick a ready draft below to create a multi-platform plan, or click "One-Click Publish" directly in Studio.'
            : '在下方选择一篇写好的稿件，即可一键生成各平台的分发任务；亦可在创作工坊中点击「一键发布」。'}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      {plans.map((p) => {
        const plan = live[p.id] ?? p;
        const done = plan.tasks.filter((t) => t.status === 'published').length;
        return (
          <div key={p.id}>
            <div className="row-between wrap" style={{ gap: 8, marginBottom: 8 }}>
              <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <strong>{p.draftTitle}</strong>
                <span className="badge badge-gray">
                  {done}/{plan.tasks.length} {isEn ? 'Published' : '已发布'}
                </span>
              </span>
              <span className="small muted">{fmtDateTime(new Date(p.createdAt))}</span>
            </div>
            <PlanTasks plan={plan} onChanged={(next) => setLive({ ...live, [p.id]: next })} />
          </div>
        );
      })}
    </div>
  );
}

export function NewPlan({ drafts }: { drafts: { id: string; title: string; platform: string; updatedAt: string }[] }) {
  const { lang } = useI18n();
  const isEn = lang === 'en';
  const [draftId, setDraftId] = useState('');
  const [plan, setPlan] = useState<PlanView | null>(null);

  if (drafts.length === 0) {
    return (
      <div className="publish-empty-box">
        <div className="publish-empty-icon">
          <Icon.pen size={22} />
        </div>
        <div className="publish-empty-title">
          {isEn ? 'No Drafts Ready to Publish' : '暂无待发布的稿件'}
        </div>
        <div className="publish-empty-desc">
          {isEn
            ? 'Drafts with body content created in Studio will appear here for multi-platform distribution.'
            : '在创作工坊中撰写完成、尚未发出的稿件将自动汇聚于此，点击即可开启多平台分发。'}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="draft-selector-grid">
        {drafts.map((d) => {
          const active = d.id === draftId;
          return (
            <div
              key={d.id}
              className={`draft-select-tile ${active ? 'active' : ''}`}
              onClick={() => {
                setDraftId(active ? '' : d.id);
                setPlan(null);
              }}
            >
              <div className="draft-select-header">
                <span className="badge badge-gray">{platformName(d.platform, lang) || d.platform || (isEn ? 'Universal' : '全平台')}</span>
                <span className="small muted">{fmtDate(d.updatedAt)}</span>
              </div>
              <div className="draft-select-title">
                {d.title || (isEn ? '(Untitled)' : '（无标题）')}
              </div>
              <div className="draft-select-action">
                {active ? (isEn ? 'Selected · Configure Channels Below ↓' : '已选定 · 见下方渠道配置 ↓') : (isEn ? 'Click to distribute →' : '点击开启发布计划 →')}
              </div>
            </div>
          );
        })}
      </div>

      {draftId && !plan && (
        <div className="plan-creator-wrapper">
          <div className="small muted" style={{ marginBottom: 8, fontWeight: 600 }}>
            {isEn ? 'Select distribution channels for this draft:' : '选择需要分发同步的目标平台：'}
          </div>
          <PlanCreator draftId={draftId} onCreated={setPlan} compact />
        </div>
      )}

      {draftId && plan && (
        <div style={{ marginTop: 14 }}>
          <PlanTasks plan={plan} onChanged={setPlan} />
        </div>
      )}
    </>
  );
}

export function PublishKanban({
  plans,
  drafts,
  records,
}: {
  plans: (PlanView & { draftTitle: string; createdAt: string })[];
  drafts: { id: string; title: string; platform: string; updatedAt: string }[];
  /** 已发布记录。syncState 是**服务端算好的三态**：缺链接 / 待回流 / 已回流。
      别在这里凭 metrics 自己猜——同一批记录此前在本页印了两遍、两处说法相反，
      看板写死「已回流数据」而下面那张卡写「待回流」，就是因为口径散了两处。 */
  records: {
    id: string; title: string; platform: string; publishedAt: string;
    syncState: 'missing-url' | 'awaiting' | 'synced';
  }[];
}) {
  const { lang } = useI18n();
  const isEn = lang === 'en';
  const [showNewPlan, setShowNewPlan] = useState(false);

  const waitingTasks = plans.flatMap((p) =>
    p.tasks
      .filter((t) => t.status === 'filled' || t.status === 'submitted')
      .map((t) => ({ ...t, draftTitle: p.draftTitle, planId: p.id }))
  );

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 14 }}>
        <button className="btn primary" onClick={() => setShowNewPlan(true)}>
          {isEn ? 'New Publishing Plan' : '新建发布计划'}
        </button>
      </div>

      <div className="publish-grid">
        {/* ── 第 1 列：准备发布 ── */}
        <section className="kanban-col">
          <div className="kanban-head">
            <strong>{isEn ? 'Ready to Publish' : '准备发布'}</strong>
            <span>{drafts.length}</span>
          </div>
          <div className="kanban-body">
            {drafts.length === 0 ? (
              <div className="kanban-empty">
                <div className="kanban-empty-icon">📝</div>
                <div className="kanban-empty-text">{isEn ? 'No drafts ready to publish' : '暂无待发布草稿'}</div>
                <Link href="/studio" className="btn small" style={{ marginTop: 6 }}>
                  {isEn ? 'Go to Studio' : '去写稿'}
                </Link>
              </div>
            ) : (
              drafts.slice(0, 8).map((d) => (
                <article key={d.id} className="publish-card">
                  <span className={`tag ${d.platform === 'xiaohongshu' ? 'brand' : d.platform === 'wechat' ? 'green' : ''}`}>
                    {platformName(d.platform, lang) || d.platform}
                  </span>
                  <h3>{d.title || (isEn ? 'Untitled Draft' : '未命名草稿')}</h3>
                  <div className="meta">
                    {isEn ? `Draft ready · Updated ${fmtDate(d.updatedAt)}` : `正文已完成 · ${fmtDate(d.updatedAt)} 更新`}
                  </div>
                  <div className="publish-actions">
                    <Link href={`/studio?draft=${d.id}`} className="btn small primary">
                      {isEn ? 'Prepare' : '继续准备'}
                    </Link>
                    <Link href={`/studio?draft=${d.id}`} className="btn small">
                      {isEn ? 'Preview' : '预览'}
                    </Link>
                  </div>
                </article>
              ))
            )}
          </div>
        </section>

        {/* ── 第 2 列：等你确认 ── */}
        <section className="kanban-col">
          <div className="kanban-head">
            <strong>{isEn ? 'Waiting on You' : '等你确认'}</strong>
            <span>{waitingTasks.length}</span>
          </div>
          <div className="kanban-body">
            {waitingTasks.length === 0 ? (
              <div className="kanban-empty">
                <div className="kanban-empty-icon">☕️</div>
                <div className="kanban-empty-text">{isEn ? 'No tasks waiting for confirmation' : '暂无等待确认的任务'}</div>
                <span className="small muted" style={{ fontSize: 11 }}>
                  {isEn ? 'Tasks requiring manual confirmation will show here' : '已存入草稿箱或插件代填的任务将在此展示'}
                </span>
              </div>
            ) : (
              waitingTasks.map((t, idx) => (
                <article key={idx} className="publish-card">
                  <span className={`tag ${t.platform === 'wechat' ? 'green' : t.platform === 'xiaohongshu' ? 'brand' : ''}`}>
                    {platformName(t.platform, lang) || t.platform}
                  </span>
                  <h3>{t.draftTitle}</h3>
                  <div className="meta">
                    {t.platform === 'wechat'
                      ? (isEn ? 'Saved to WeChat drafts. Confirm and send in WeChat backend.' : '已存入草稿箱，等待在公众号后台确认')
                      : (isEn ? 'Draft prepared. Please open backend to confirm.' : '已完成后台代填，请登录后台确认发布')}
                  </div>
                  <div className="publish-actions">
                    <a
                      href={t.platform === 'wechat' ? 'https://mp.weixin.qq.com' : '#'}
                      target="_blank"
                      rel="noreferrer"
                      className="btn small primary"
                    >
                      {isEn ? 'Open Backend' : '打开后台'}
                    </a>
                    <Link href={`/studio?draft=${t.planId}`} className="btn small">
                      {isEn ? 'View Content' : '查看内容'}
                    </Link>
                  </div>
                </article>
              ))
            )}
          </div>
        </section>

        {/* ── 第 3 列：已发布 ── */}
        <section className="kanban-col">
          <div className="kanban-head">
            <strong>{isEn ? 'Published' : '已发布'}</strong>
            <span>{records.length}</span>
          </div>
          <div className="kanban-body">
            {records.length === 0 ? (
              <div className="kanban-empty">
                <div className="kanban-empty-icon">🚀</div>
                <div className="kanban-empty-text">{isEn ? 'No published works yet' : '暂无已发布记录'}</div>
                <span className="small muted" style={{ fontSize: 11 }}>
                  {isEn ? 'Published posts will show here with synced metrics' : '作品发布成功后数据将自动在此回流展示'}
                </span>
              </div>
            ) : (
              records.slice(0, 8).map((r) => (
                <article key={r.id} className="publish-card">
                  <span className={`tag ${r.platform === 'xiaohongshu' ? 'brand' : r.platform === 'wechat' ? 'green' : ''}`}>
                    {platformName(r.platform, lang) || r.platform}
                  </span>
                  <h3>{r.title || (isEn ? 'Published Work' : '已发布作品')}</h3>
                  <div className="meta">
                    {/* 【这里原来对每一条都写死「已回流数据」】而 metrics 可能是空的，
                        同一页下方那张「最近发布记录」对同一条却写着「待回流」——
                        两处说法相反，用户不知道信哪个。判据统一由服务端算好（syncState）。 */}
                    {r.syncState === 'missing-url'
                      ? (isEn ? 'Missing URL · cannot track' : '缺作品链接 · 追不到数据')
                      : r.syncState === 'synced'
                        ? (isEn ? `Synced · Published ${fmtDate(r.publishedAt)}` : `已回流数据 · ${fmtDate(r.publishedAt)} 发布`)
                        : (isEn ? `Awaiting sync · Published ${fmtDate(r.publishedAt)}` : `待回流 · ${fmtDate(r.publishedAt)} 发布`)}
                  </div>
                  <div className="publish-actions">
                    <Link href="/data" className="btn small">
                      {r.syncState === 'missing-url'
                        ? (isEn ? 'Backfill URL' : '去补链接')
                        : (isEn ? 'View Metrics' : '看表现')}
                    </Link>
                  </div>
                </article>
              ))
            )}
          </div>
        </section>
      </div>

      {/* 新建发布计划弹窗 */}
      {showNewPlan && (
        <Overlay
          onClose={() => setShowNewPlan(false)}
          label={isEn ? 'Create New Publishing Plan' : '新建发布计划'}
        >
          <div
            className="surface"
            style={{
              maxWidth: 720,
              width: '100%',
              maxHeight: '90vh',
              overflowY: 'auto',
              borderRadius: 14,
              padding: 24,
              border: '1px solid var(--border)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <h3 style={{ margin: 0 }}>{isEn ? 'Create New Publishing Plan' : '新建发布计划'}</h3>
              <button className="btn small ghost" onClick={() => setShowNewPlan(false)}>✕</button>
            </div>
            <NewPlan drafts={drafts} />
          </div>
        </Overlay>
      )}
    </>
  );
}

