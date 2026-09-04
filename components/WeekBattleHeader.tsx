'use client';

import React from 'react';
import { ActionButton } from '@/components/ActionButton';
import { actGenerateRecommendations, actCrawlCompetitors } from '@/app/(app)/actions';
import { fmtDateLong } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

interface WeekBattleHeaderProps {
  competitors: number;
  personaBlank: boolean;
}

export function WeekBattleHeader({ competitors, personaBlank }: WeekBattleHeaderProps) {
  const { lang, dict } = useI18n();

  const title = dict.today.weekBattle;
  const hint = lang === 'en'
    ? `${fmtDateLong(new Date())} · Weekly action items with one-click execution`
    : `${fmtDateLong(new Date())} · 这周该做什么，每条后面就是执行入口`;

  const crawlBtn = dict.today.crawlRivals;
  const refreshBtn = dict.today.refreshTopics;
  const crawlLoading = dict.today.crawling;
  const refreshLoading = lang === 'en'
    ? ['Fetching hotlists…', 'Clustering topics…', 'AI selecting recommendations…']
    : ['正在采集热榜…', '正在聚类分析…', '正在 AI 精选推荐…'];

  return (
    <div className="row wrap" style={{ gap: 8, alignItems: 'baseline', marginBottom: 12 }}>
      <h2 style={{ fontSize: 17, margin: 0 }}>{title}</h2>
      <span className="small muted">{hint}</span>
      <span className="row" style={{ gap: 8, marginLeft: 'auto' }}>
        {competitors > 0 && (
          <ActionButton action={actCrawlCompetitors} loadingText={crawlLoading}>
            {crawlBtn}
          </ActionButton>
        )}
        {!personaBlank && (
          <ActionButton action={actGenerateRecommendations} primary loadingText={refreshLoading}>
            {refreshBtn}
          </ActionButton>
        )}
      </span>
    </div>
  );
}
