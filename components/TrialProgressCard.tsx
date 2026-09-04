'use client';

import React from 'react';
import Link from 'next/link';
import { Card, Meter } from '@/components/ui';
import { Icon } from '@/components/icons';
import type { TrialProgress } from '@/lib/pay/trial';
import { useI18n } from '@/lib/i18n';

const MILESTONE_EN: Record<number, string> = {
  1: 'Create persona · Draft 1st post',
  7: 'Week 1 review · Analytics flow',
  25: 'Monthly ledger · Renewal decision',
};

export function TrialProgressCard({ trial }: { trial: TrialProgress }) {
  const { lang, dict } = useI18n();

  if (!trial.isTrial) return null;

  const near = trial.nearingEnd;
  const accent = near ? 'var(--amber)' : 'var(--brand)';

  const dayTitle = lang === 'en'
    ? `Trial · Day ${trial.dayNumber} / ${trial.totalDays}`
    : `试用中 · 第 ${trial.dayNumber} / ${trial.totalDays} 天`;

  const remainingText = near
    ? (lang === 'en' ? `Only ${trial.remaining} days left` : `仅剩 ${trial.remaining} 天`)
    : (lang === 'en' ? `${trial.remaining} days left` : `还剩 ${trial.remaining} 天`);

  const btnText = near
    ? (lang === 'en' ? 'Renew Now to Keep Service →' : '立即续费，别断档 →')
    : (lang === 'en' ? 'View Plans' : '查看套餐');

  const bottomTip = lang === 'en'
    ? 'Trial ending soon — visit "Billing" to review this month\'s output ledger before deciding to renew. Will fall back to Free plan after expiration.'
    : '试用快结束了——到「套餐与计费」看这一个月的产出账本（推荐/成稿/发布/拦截都在里面），再决定要不要续。断档后按免费版额度算。';

  return (
    <Card
      style={{
        marginBottom: 16,
        background: 'var(--surface-2)',
        boxShadow: 'none',
        border: near ? '1px solid var(--amber)' : '1px solid var(--border)',
      }}
    >
      <div className="row-between" style={{ alignItems: 'center', marginBottom: 10, gap: 12 }}>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <span style={{ color: accent, display: 'inline-flex' }}><Icon.sparkles size={16} /></span>
          <b style={{ fontSize: 14.5 }}>{dayTitle}</b>
          <span className={near ? 'badge badge-amber' : 'small muted'}>{remainingText}</span>
        </div>
        <Link href="/billing" className={`btn btn-sm ${near ? 'btn-primary' : 'btn-ghost'}`}>
          {btnText}
        </Link>
      </div>

      <Meter value={trial.pct} color={accent} />

      {/* 三个里程碑 */}
      <div className="row wrap" style={{ gap: 14, marginTop: 12 }}>
        {trial.milestones.map((m) => {
          const mLabel = lang === 'en' && MILESTONE_EN[m.day] ? MILESTONE_EN[m.day] : m.label;
          return (
            <div key={m.day} className="row" style={{ gap: 6, alignItems: 'center' }}>
              <span
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: '50%',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  background: m.reached ? 'var(--green)' : 'var(--border)',
                  color: m.reached ? '#fff' : 'var(--muted)',
                  fontSize: 10,
                }}
              >
                {m.reached ? '✓' : m.day}
              </span>
              <span
                className="small"
                style={{ color: m.reached ? 'var(--text)' : 'var(--muted)' }}
              >
                <b style={{ fontWeight: 600 }}>Day {m.day}</b> · {mLabel}
              </span>
            </div>
          );
        })}
      </div>

      {near && (
        <div className="small" style={{ marginTop: 10, color: 'var(--amber)', lineHeight: 1.6 }}>
          {bottomTip}
        </div>
      )}
    </Card>
  );
}
