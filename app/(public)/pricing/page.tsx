import type { Metadata } from 'next';
import Link from 'next/link';
import { Card } from '@/components/ui';
import { PRICING, TRIAL_DAYS, BYOK_LIFETIME_FEN } from '@/lib/pay/pricing';
import { planFeatures } from '@/lib/pay/features';
import { getServerLang } from '@/lib/i18n/server';
import { getSessionOrNull } from '@/lib/session';
import { TrackView } from '@/components/growth/TrackView';
import { REFERRAL_DAYS } from '@/lib/growth/referral';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: '价格',
  description: '烽火台三档价格：标准版 ¥129/月、自带 Key 版 ¥69/月、永久买断 ¥2999。注册送 30 天标准版，不用填付款方式。',
};

// 公开定价页（2026-09-05 增长缺口整改）：此前价格只在登录后的 /billing 可见——
// 价格不可见等于没有价格。这里只读 lib/pay/pricing.ts 的常量，不下单；下单仍在 /billing。
export default async function PricingPage() {
  const [lang, session] = await Promise.all([getServerLang(), getSessionOrNull()]);
  const en = lang === 'en';
  const rows = planFeatures(lang);
  const cta = session
    ? { href: '/billing', label: en ? 'Go to billing' : '去套餐与计费购买' }
    : { href: '/login', label: en ? `Start ${TRIAL_DAYS}-day free trial` : `免费开始 · 送 ${TRIAL_DAYS} 天标准版` };

  const plans = [
    {
      key: 'free',
      name: en ? 'Free' : '免费版',
      price: '¥0',
      unit: '',
      sub: en ? 'Everything, with a daily AI cap' : '功能全开，AI 每天 30 次',
      note: en ? 'No expiry. Enough to run one topic brief a day.' : '无到期日。够每天跑一份选题推荐。',
      featured: false,
    },
    {
      key: 'personal',
      name: en ? 'Standard' : PRICING.personal.name,
      price: `¥${PRICING.personal.monthFen / 100}`,
      unit: en ? '/ mo' : '/ 月',
      sub: en ? 'AI provided by platform, ready to use' : 'AI 由平台提供，即开即用',
      note: en
        ? `Annual ¥${PRICING.personal.yearFen / 100} (pay 10 months, get 12)`
        : `年付 ¥${PRICING.personal.yearFen / 100}（付 10 个月用 12 个月）`,
      featured: true,
    },
    {
      key: 'byok',
      name: en ? 'BYOK Edition' : PRICING.byok.name,
      price: `¥${PRICING.byok.monthFen / 100}`,
      unit: en ? '/ mo' : '/ 月',
      sub: en ? 'Bring your own model key; platform charges tooling only' : '自带模型 Key，平台只收工具费',
      note: en
        ? `Annual ¥${PRICING.byok.yearFen / 100} · Lifetime ¥${BYOK_LIFETIME_FEN / 100} one-time`
        : `年付 ¥${PRICING.byok.yearFen / 100} · 永久买断 ¥${BYOK_LIFETIME_FEN / 100} 一次付清`,
      featured: false,
    },
  ] as const;

  return (
    <div className="pub-page">
      <TrackView name="pricing_view" />
      <header className="pub-hero-sm">
        <h1>{en ? 'Simple pricing' : '价格'}</h1>
        <p className="muted">
          {en
            ? `Sign up and get ${TRIAL_DAYS} days of the Pro plan free. No payment method required. Falls back to Free afterwards, never charges you.`
            : `注册即送 ${TRIAL_DAYS} 天标准版，不用填付款方式；到期自动回到免费版，不会扣你一分钱。`}
        </p>
      </header>

      <div className="grid grid-3 pub-plans">
        {plans.map((p) => (
          <Card key={p.key} title={p.name} sub={p.sub} className={p.featured ? 'card-selected-gradient' : undefined} style={{ padding: 22 }}>
            <div className="row" style={{ gap: 6, alignItems: 'baseline', marginBottom: 4 }}>
              <span className={p.featured ? 'text-gradient-brand' : ''} style={{ fontSize: 34, fontWeight: 800, letterSpacing: '-0.5px' }}>{p.price}</span>
              <span className="small muted">{p.unit}</span>
            </div>
            <div className="small muted" style={{ marginBottom: 14, minHeight: 36 }}>{p.note}</div>
            <div className="stack" style={{ gap: 2 }}>
              {rows.map((f) => {
                const val = p.key === 'free' ? (f.free ?? '—') : p.key === 'personal' ? f.personal : f.byok;
                return (
                  <div key={f.name} className="row-between" style={{ gap: 8, padding: '7px 0', borderTop: '1px solid var(--surface-2)' }}>
                    <span className="small">{f.name}</span>
                    <span className="small" style={{ color: val === '✓' ? 'var(--green)' : 'var(--text-2)', fontWeight: val === '✓' ? 700 : 400, textAlign: 'right' }}>{val}</span>
                  </div>
                );
              })}
            </div>
            <div style={{ marginTop: 16 }}>
              <Link href={cta.href} className={`btn ${p.featured ? 'btn-primary' : ''}`} style={{ width: '100%', justifyContent: 'center' }}>{cta.label}</Link>
            </div>
          </Card>
        ))}
      </div>

      <div className="grid grid-3" style={{ marginTop: 20 }}>
        <Card title={en ? 'Invite a creator' : '邀请一位创作者'} sub={en ? `Both of you get ${REFERRAL_DAYS} days` : `双方各得 ${REFERRAL_DAYS} 天标准版`}>
          <p className="small muted" style={{ lineHeight: 1.7 }}>
            {en
              ? 'Your invite link is on the billing page after you sign up. Up to 20 rewards a month.'
              : '注册后在「套餐与计费」里拿你的邀请链接。每月最多 20 次。'}
          </p>
        </Card>
        <Card title={en ? 'Teams & enterprise' : '团队与企业'} sub={en ? 'Self-hosted / appliance / private' : '整机版 · 私有化 · 团队'}>
          <p className="small muted" style={{ lineHeight: 1.7 }}>
            {en
              ? 'Runs on your own machine or server with local data. Contact us for a quote; the open-source edition is AGPL-3.0.'
              : '数据留在你自己的机器或服务器上，按项目报价；开源发行版按 AGPL-3.0 自行部署。'}
          </p>
        </Card>
        <Card title={en ? 'What we don’t charge for' : '我们不收钱的地方'} sub={en ? 'Honest boundaries' : '说清边界'}>
          <ul className="small muted" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
            <li>{en ? 'Free tier has no expiry and every feature.' : '免费版没有到期日，功能一样不少。'}</li>
            <li>{en ? 'Trial does not ask for a card.' : '试用不要卡、不自动扣费。'}</li>
            <li>{en ? 'Refunds go back the same way you paid.' : '退款原路退回，账单页自助申请。'}</li>
          </ul>
        </Card>
      </div>
    </div>
  );
}
