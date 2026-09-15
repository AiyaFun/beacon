'use client';

import React, { useState, useMemo } from 'react';
import Link from 'next/link';
import { platformName, platformColor, PLATFORM_LIST } from '@/lib/constants';
import { fmtNum, relTime } from '@/lib/format';
import { Overlay } from '@/components/Overlay';
import { AddCompetitorForm } from './AddCompetitorForm';
import { ActionButton } from '@/components/ActionButton';
import { actCrawlCompetitors, actRemoveWatch } from './actions';
import { HubHeader } from '@/components/HubHeader';
import { IntelTabs } from '@/components/IntelTabs';
import { useI18n } from '@/lib/i18n';

export type CompetitorItem = {
  watchId: string;
  competitorId: string;
  name: string;
  handle: string;
  platform: string;
  followers: number;
  lastCrawledAt: string | null;
  postsCount: number;
  weekPosts: number;
  label: string | null;
  avatarUrl?: string | null;
};


interface CompetitorConsoleProps {
  accounts: CompetitorItem[];
  workspaceId: string;
  sourceStatus: Record<string, string>;
  readerVoices: { quote: string }[];
  initialPlatform?: string | null;
  wechatQuotaNote?: React.ReactNode;
}

export function CompetitorConsole({
  accounts,
  workspaceId,
  sourceStatus,
  readerVoices,
  initialPlatform = null,
  wechatQuotaNote,
}: CompetitorConsoleProps) {
  const { lang, dict } = useI18n();
  const isEn = lang === 'en';

  const [platformFilter, setPlatformFilter] = useState<string>(initialPlatform || 'all');
  const [windowFilter, setWindowFilter] = useState<'7d' | '30d'>('7d');
  const [showManageModal, setShowManageModal] = useState<boolean>(false);

  // 【没有就是没有】2026-09-11 之前这里在没数据时回填四个写死的示例账号；
  // 新用户看到的是「职场显微镜」们的假监控，而且每个假账号下面的「关键变化」也是编的。
  const displayAccounts = accounts;

  const [selectedId, setSelectedId] = useState<string>(displayAccounts[0]?.competitorId || '');

  // 平台过滤
  const filteredAccounts = useMemo(() => {
    if (platformFilter === 'all') return displayAccounts;
    return displayAccounts.filter((a) => a.platform === platformFilter);
  }, [displayAccounts, platformFilter]);

  // 默认选中当前或首项
  const currentAccount = useMemo(() => {
    const found = filteredAccounts.find((a) => a.competitorId === selectedId);
    return found || filteredAccounts[0] || displayAccounts[0] || null;
  }, [filteredAccounts, selectedId, displayAccounts]);

  // 可用平台清单
  const availablePlatforms = useMemo(() => {
    const set = new Set(displayAccounts.map((a) => a.platform));
    return PLATFORM_LIST.filter((p) => set.has(p.key));
  }, [displayAccounts]);

  // 超过 7 天未采集
  const staleAccounts = useMemo(() => {
    const STALE_MS = 7 * 86400000;
    return displayAccounts.filter((a) => {
      if (!a.lastCrawledAt) return true;
      return Date.now() - new Date(a.lastCrawledAt).getTime() > STALE_MS;
    });
  }, [displayAccounts]);

  const scrollToSection = (id: string) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <>
      <HubHeader
        title={dict.tabs.intelTitle}
        hint={isEn ? 'Unified cross-platform view of benchmark accounts · Shared deduplicated crawls' : '多平台对标账号统一视图 · 全局共享采集，同一竞对只采一次'}
        tabs={<IntelTabs active="rivals" inline />}
        action={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <ActionButton action={actCrawlCompetitors} loadingText={dict.today?.crawling || (isEn ? 'Collecting…' : '采集中…')}>
              {isEn ? 'Collect All' : '采集全部'}
            </ActionButton>
            <button
              type="button"
              className="btn primary"
              onClick={() => setShowManageModal(true)}
            >
              {isEn ? 'Add Competitor' : '添加同行账号'}
            </button>
          </div>
        }
      />

      {/* ── 顶部过滤与汇总状态条 ── */}
      <div className="rival-command surface">
        <button
          type="button"
          className={`filter-btn ${platformFilter === 'all' ? 'active' : ''}`}
          onClick={() => setPlatformFilter('all')}
        >
          {isEn ? 'All Platforms' : '全部平台'}
        </button>
        {availablePlatforms.map((p) => (
          <button
            key={p.key}
            type="button"
            className={`filter-btn ${platformFilter === p.key ? 'active' : ''}`}
            onClick={() => setPlatformFilter(p.key)}
          >
            {platformName(p.key, lang)}
          </button>
        ))}

        <span className="separator" />

        <button
          type="button"
          className={`filter-btn ${windowFilter === '7d' ? 'active' : ''}`}
          onClick={() => setWindowFilter('7d')}
        >
          {isEn ? 'Past 7 Days' : '近 7 天'}
        </button>
        <button
          type="button"
          className={`filter-btn ${windowFilter === '30d' ? 'active' : ''}`}
          onClick={() => setWindowFilter('30d')}
        >
          {isEn ? 'Past 30 Days' : '近 30 天'}
        </button>

        <span className="command-summary">
          {isEn
            ? `${filteredAccounts.length} accounts · ${filteredAccounts.reduce((n, a) => n + a.weekPosts, 0)} new works in 7 days`
            : `${filteredAccounts.length} 个账号 · 近 7 天共 ${filteredAccounts.reduce((n, a) => n + a.weekPosts, 0)} 条新作品`}
        </span>
      </div>

      {/* ── 三栏核心监控作战网格 ── */}
      <div className="rival-shell">
        {/* 左栏：监控账号列表 (240px) */}
        <aside className="rival-roster">
          <div className="surface-head">
            <strong>{isEn ? 'Monitored Accounts' : '监控账号'}</strong>
            <span className="meta">{filteredAccounts.length}</span>
            <button
              type="button"
              className="btn small"
              style={{ marginLeft: 'auto' }}
              onClick={() => setShowManageModal(true)}
            >
              {isEn ? 'Manage' : '管理'}
            </button>
          </div>

          <div className="rival-account-list">
            {filteredAccounts.map((acc) => {
              const isActive = currentAccount?.competitorId === acc.competitorId;
              const initialChar = acc.name?.slice(0, 1) || '同';
              const isStale = acc.lastCrawledAt
                ? Date.now() - new Date(acc.lastCrawledAt).getTime() > 7 * 86400000
                : true;

              return (
                <button
                  key={acc.competitorId}
                  type="button"
                  className={`rival-account ${isActive ? 'active' : ''}`}
                  aria-pressed={isActive}
                  onClick={() => setSelectedId(acc.competitorId)}
                >
                  <span
                    className="avatar"
                    style={{
                      background: isActive ? 'var(--brand-soft)' : 'var(--surface-2)',
                      color: isActive ? 'var(--brand-ink)' : 'var(--text-2)',
                    }}
                  >
                    {initialChar}
                  </span>
                  <span className="rival-account-copy">
                    <strong title={acc.name}>{acc.name}</strong>
                    <span className="rival-account-meta">
                      <span>
                        {acc.weekPosts > 0
                          ? (isEn ? `${acc.weekPosts} new works` : `${acc.weekPosts} 条新作品`)
                          : (isEn ? 'No new works' : '本周暂无新作品')}
                      </span>
                      <span
                        className={`rival-account-status${isStale ? ' stale' : ''}`}
                        title={isStale
                          ? (isEn ? 'Not collected in the past 7 days' : '近 7 天未采集，请检查采集状态')
                          : (isEn ? 'Collected within the past 7 days' : '近 7 天内已采集')}
                      >
                        {isStale ? (isEn ? 'Stale' : '待更新') : (isEn ? 'Updated' : '已更新')}
                      </span>
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          {staleAccounts.length > 0 && (
            <div className="rival-account-health">
              <span className="small muted">
                {isEn
                  ? `${staleAccounts.length} account not crawled > 7d`
                  : `${staleAccounts.length} 个账号超过 7 天没采到`}
              </span>
              <button
                type="button"
                className="btn small primary"
                style={{ width: '100%', marginTop: 7 }}
                onClick={() => setShowManageModal(true)}
              >
                {isEn ? 'Fix Ingest' : '修复采集'}
              </button>
            </div>
          )}
        </aside>

        {/* 中栏：选中同行深度拆解与关键动态 (flex: 1) */}
        <section className="rival-main">
          {currentAccount ? (
            <>
              <div className="rival-profile">
                <span
                  className="avatar"
                  style={{
                    background: 'var(--brand-soft)',
                    color: 'var(--brand)',
                  }}
                >
                  {currentAccount.name?.slice(0, 1) || '同'}
                </span>
                <div className="rival-profile-title">
                  <h2>{currentAccount.name}</h2>
                  <span className="meta">
                    {platformName(currentAccount.platform, lang)}
                    {currentAccount.followers > 0 ? `，${fmtNum(currentAccount.followers)} 粉丝` : ''}
                    {currentAccount.lastCrawledAt
                      ? `，${relTime(new Date(currentAccount.lastCrawledAt))}采集`
                      : `，未采集`}
                  </span>
                </div>
                <button
                  type="button"
                  className="btn small"
                  onClick={() => scrollToSection('all-posts')}
                >
                  {isEn ? 'View All Works' : '查看全部作品'}
                </button>
              </div>

              <div className="rival-compare">
                <div>
                  <span>{isEn ? 'Past 7 Days Works' : '近 7 天新作品'}</span>
                  <strong>{currentAccount.weekPosts}</strong>
                  <span className="meta">{isEn ? 'From collected works' : '按已采到的作品算'}</span>
                </div>
                <div>
                  <span>{isEn ? 'Works collected' : '已采作品'}</span>
                  <strong>{currentAccount.postsCount}</strong>
                  <span className="meta">
                    {currentAccount.lastCrawledAt
                      ? (isEn ? `Collected ${relTime(new Date(currentAccount.lastCrawledAt))}` : `${relTime(new Date(currentAccount.lastCrawledAt))}采集`)
                      : (isEn ? 'Not collected yet' : '还没采集过')}
                  </span>
                </div>
                <div>
                  <span>{isEn ? 'Followers' : '粉丝'}</span>
                  <strong>{currentAccount.followers > 0 ? fmtNum(currentAccount.followers) : '—'}</strong>
                  <span className="meta">{currentAccount.followers > 0 ? '' : (isEn ? 'Not public / not collected' : '未公开或未采到')}</span>
                </div>
              </div>

              <div className="rival-stream">
                <div className="rival-stream-title">
                  <strong>{isEn ? 'Key Changes' : '关键变化'}</strong>
                </div>
                {/* 关键变化的自动识别还没接上这一页。2026-09-11 之前这里给每个账号都印同一套
                    编好的「旧作品二次增长 +8,460 收藏」——那是设计稿文案，不是数据。没有就说没有。 */}
                <p className="small muted" style={{ margin: '8px 14px 14px' }}>
                  {isEn
                    ? 'Automatic change detection is not wired to this page yet. Use the works list below, or let AI break this account down.'
                    : '这一页还没接「关键变化」的自动识别。先看下面的全部作品，或让 AI 拆解这个账号。'}
                </p>
              </div>
            </>
          ) : (
            <div style={{ padding: '60px 20px', textAlign: 'center' }} className="small muted">
              {isEn ? 'Select or add an account to monitor' : '请在左侧选择或添加对标账号'}
            </div>
          )}
        </section>

        {/* 右栏：对你最有用与读者原声 (308px) */}
        <aside className="rival-aside">
          {/* 对你最有用：按账号现算的拆解建议还没接到这一页，只给真入口，不印样板文案 */}
          <section className="surface">
            <div className="surface-head">
              <strong>{isEn ? 'Most Useful to You' : '对你最有用'}</strong>
            </div>
            <div className="brief-block">
              <p className="small muted" style={{ margin: 0 }}>
                {isEn
                  ? 'Per-account advice is generated by AI on demand — it is not precomputed on this page.'
                  : '按这个账号给你的建议由 AI 现拆，这一页不预先编好。'}
              </p>
            </div>
            <div style={{ padding: '0 14px 14px' }}>
              <Link href="/topics" className="btn primary" style={{ width: '100%', textAlign: 'center', display: 'block' }}>
                {isEn ? 'Find a differentiated angle' : '去找差异化角度'}
              </Link>
            </div>
          </section>

          {/* 读者正在问 */}
          <section className="surface" id="reader-voice">
            <div className="surface-head">
              <strong>{isEn ? 'Readers Are Asking' : '读者正在问'}</strong>
            </div>
            <div className="surface-body stack" style={{ gap: 8 }}>
              {readerVoices && readerVoices.length > 0 ? (
                readerVoices.slice(0, 3).map((v, i) => (
                  <div key={i} className="voice-quote">
                    “{v.quote}”
                  </div>
                ))
              ) : (
                <p className="small muted" style={{ margin: 0 }}>
                  {isEn ? 'No reader comments collected yet.' : '还没采到读者评论。采集作品时勾上评论就会有。'}
                </p>
              )}
              <button
                type="button"
                className="btn small"
                style={{ marginTop: 4 }}
                onClick={() => scrollToSection('all-posts')}
              >
                {isEn ? 'View Reader Voices' : '查看原声详情'}
              </button>
            </div>
          </section>
        </aside>
      </div>

      {/* ── 管理对标账号与添加对标账号弹窗 ── */}
      {showManageModal && (
        <Overlay
          onClose={() => setShowManageModal(false)}
          label={isEn ? 'Manage Monitored Accounts' : '管理同行账号'}
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
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ margin: 0 }}>{isEn ? 'Manage Monitored Accounts' : '监控账号管理'}</h3>
              <button className="btn small ghost" onClick={() => setShowManageModal(false)}>✕</button>
            </div>

            {/* 添加表单 */}
            <div style={{ marginBottom: 20, padding: 16, background: 'var(--surface-2)', borderRadius: 10 }}>
              <h4 style={{ margin: '0 0 10px' }}>{isEn ? 'Add Competitor Account' : '添加同行对标账号'}</h4>
              {wechatQuotaNote}
              <AddCompetitorForm sourceStatus={sourceStatus} />
            </div>

            {/* 账号清单 */}
            <div>
              <h4 style={{ margin: '0 0 10px' }}>{isEn ? 'Existing Monitored Accounts' : '已添加账号列表'} ({accounts.length})</h4>
              <div style={{ display: 'grid', gap: 8 }}>
                {accounts.map((r) => (
                  <div
                    key={r.watchId}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '10px 12px',
                      background: 'var(--surface)',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                    }}
                  >
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span className="badge" style={{ background: 'var(--surface-2)', color: platformColor(r.platform) }}>
                          {platformName(r.platform, lang)}
                        </span>
                        <strong>{r.name}</strong>
                        <span className="small muted">@{r.handle}</span>
                      </div>
                      <div className="small muted" style={{ marginTop: 4 }}>
                        {r.followers > 0 ? `${fmtNum(r.followers)} 粉丝 · ` : ''}
                        在库 {r.postsCount} 篇 ·{' '}
                        {r.lastCrawledAt ? `${relTime(new Date(r.lastCrawledAt))}采集` : '未采集'}
                      </div>
                    </div>
                    <ActionButton action={actRemoveWatch.bind(null, r.watchId)} loadingText={isEn ? 'Removing…' : '移除中…'}>
                      {isEn ? 'Remove' : '移除'}
                    </ActionButton>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Overlay>
      )}
    </>
  );
}
