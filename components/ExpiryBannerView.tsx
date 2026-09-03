'use client';

import React from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import type { ExpiryNotice } from '@/lib/pay/expiry';

export function ExpiryBannerView({ notice }: { notice: ExpiryNotice }) {
  const { lang, dict } = useI18n();
  const expired = notice.stage === 'expired';

  const title = lang === 'en'
    ? (notice.isTrial ? `${notice.daysLeft} days trial left` : `${notice.daysLeft} days left in plan`)
    : notice.title;

  const body = lang === 'en'
    ? (notice.isTrial
        ? `${notice.daysLeft} days remaining. Will fall back to Free plan with basic quota without losing data.`
        : `Expires in ${notice.daysLeft} days. Renew in advance to prevent service interruption.`)
    : notice.body;

  const btnText = expired ? dict.shell.restorePlan : dict.shell.renewNow;

  return (
    <div className={`expiry-banner${expired ? ' expiry-banner-expired' : ''}`} role="status">
      <span>
        {expired ? '⚠️' : '⏳'} <b>{title}</b>
        <span className="expiry-banner-body"> · {body}</span>
      </span>
      <Link href="/billing" className="expiry-banner-btn">
        {btnText}
      </Link>
    </div>
  );
}
