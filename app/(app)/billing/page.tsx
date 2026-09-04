import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { can } from '@/lib/rbac';
import { Card, Stat, Empty } from '@/components/ui';
import { Icon } from '@/components/icons';
import { tierFor, getUsageBill } from '@/lib/quota';
import { beijingStartOfMonth } from '@/lib/beijing';
import { effectivePlan, isPlanExpired } from '@/lib/pay/plan';
import { PRICING, TRIAL_DAYS, BYOK_LIFETIME_FEN, LIFETIME_MONTHS } from '@/lib/pay/pricing';
import { invoiceContact } from '@/lib/constants';
import { payVendorConfigured } from '@/lib/pay/provider';
import { Checkout } from './Checkout';
import { RefundButton } from './RefundButton';
import { fmtDateFull, fmtDateTime } from '@/lib/format';
import { HubHeader } from '@/components/HubHeader';
import { getServerLang } from '@/lib/i18n/server';
import { getDictionary } from '@/lib/i18n/dict';

export const dynamic = 'force-dynamic';

// 套餐与计费：微信 Native 扫码 · 手动续费 · 按 plan 订阅制。

const PLAN_LABEL: Record<string, string> = {
  free: '免费版',
  trial: '试用中',
  personal: '标准版',
  byok: '自带 Key 版',
  team: '团队版', // 已下线，仅供历史订单/存量租户显示
  enterprise: '企业版', // 不自助售卖，运营手工开通
};

// 两个付费档的差异只有一条轴：AI 的 token 钱谁出。
//   标准版 —— 平台垫（200 次/天）；自带 Key 版 —— 用户自己出（平台 Key 仅 30 次/天兜底）。
const FEATURES: { name: string; personal: string; byok: string }[] = [
  { name: 'AI 调用（平台 Key，即开即用）', personal: '200 次/天 · 3,000 次/月', byok: '30 次/天（兜底）' },
  { name: 'AI 调用（自带 Key，token 费自付）', personal: '不限量（护栏 5,000 次/天）', byok: '不限量（护栏 5,000 次/天）' },
  { name: '热点聚合 · 选题引擎', personal: '✓', byok: '✓' },
  { name: '创作工坊 · 合规检测', personal: '✓', byok: '✓' },
  { name: '团队成员协作', personal: '✓', byok: '✓' },
];

// LlmCallLog.fn → 消耗账单展示名
const FN_LABEL: Record<string, string> = {
  scoring: '选题打分',
  generation: '内容生成',
  advisor: 'AI 顾问',
  compliance: '合规检测',
  chat: '对话助手',
  embed: '向量化',
  image: 'AI 封面出图（按张）',
  video: '视频拆解',
};

// 订单时长文案：1188=永久买断，12=年付，其余月付
function periodText(periodMonths: number): string {
  return periodMonths === LIFETIME_MONTHS ? '永久买断' : periodMonths === 12 ? '年付' : '月付';
}

export default async function BillingPage() {
  const s = await getSession();
  const lang = await getServerLang();
  const dict = getDictionary(lang);
  const monthStart = beijingStartOfMonth();
  const [tenant, orders, usage, valueReceipt] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: s.tenantId }, select: { plan: true, planExpiresAt: true } }),
    prisma.paymentOrder.findMany({
      where: { tenantId: s.tenantId },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
    getUsageBill(s.tenantId),
    Promise.all([
      prisma.topicIdea.count({ where: { accountId: s.accountId, createdAt: { gte: monthStart } } }),
      prisma.topicIdea.count({ where: { accountId: s.accountId, createdAt: { gte: monthStart }, state: { in: ['accepted', 'drafting', 'published'] } } }),
      prisma.draft.count({ where: { accountId: s.accountId, createdAt: { gte: monthStart } } }),
      prisma.publishRecord.count({ where: { accountId: s.accountId, publishedAt: { gte: monthStart } } }),
      prisma.complianceCheck.count({ where: { riskLevel: 'block', checkedAt: { gte: monthStart }, draft: { accountId: s.accountId } } }),
      prisma.draft.count({ where: { accountId: s.accountId, createdAt: { gte: monthStart }, parentDraftId: { not: null } } }),
      prisma.memoryEntry.count({ where: { workspaceId: s.workspaceId, createdAt: { gte: monthStart } } }),
    ]).then(([recommended, adopted, drafts, published, blocked, derived, memories]) => ({
      recommended, adopted, drafts, published, blocked, derived, memories,
      total: recommended + adopted + drafts + published + blocked + derived + memories,
    })),
  ]);

  const rawPlan = tenant?.plan ?? 'free';
  const expiresAt = tenant?.planExpiresAt ?? null;
  const current = effectivePlan(rawPlan, expiresAt);
  const expired = isPlanExpired(rawPlan, expiresAt);
  const manageable = can(s.role, 'billing.manage');
  const tier = tierFor(current, 'platform');
  const configured = payVendorConfigured();
  const invoice = invoiceContact();

  const planLabels: Record<string, string> = {
    free: lang === 'en' ? 'Free Tier' : '免费版',
    trial: lang === 'en' ? 'Trial' : '试用中',
    personal: lang === 'en' ? 'Pro Plan' : '标准版',
    byok: lang === 'en' ? 'BYOK Plan' : '自带 Key 版',
    team: lang === 'en' ? 'Team Plan' : '团队版',
    enterprise: lang === 'en' ? 'Enterprise' : '企业版',
  };

  return (
    <>
      <HubHeader
        title={dict.settings.billingTitle}
        hint={lang === 'en' ? `New users get ${TRIAL_DAYS} days free Pro trial · Pay via WeChat / Stripe · Manual renewal` : `新用户注册即送 ${TRIAL_DAYS} 天标准版 · 微信扫码支付 · 手动续费`}
        action={<span className="badge badge-gradient-brand">{planLabels[current] ?? current}</span>}
      />

      <div className="grid grid-4" style={{ marginBottom: 20 }}>
        <Stat
          label={lang === 'en' ? 'Current Plan' : '当前套餐'}
          value={<span className="text-gradient-brand">{planLabels[current] ?? current}</span>}
          foot={
            expired
              ? (lang === 'en' ? 'Expired, free limits apply' : '已到期，按免费版计')
              : current === 'trial'
                ? (lang === 'en' ? 'Trial · Pro limits apply' : '试用期 · 额度同标准版')
                : expiresAt
                  ? (lang === 'en' ? 'Active Subscription' : '订阅中')
                  : current === 'free'
                    ? (lang === 'en' ? 'Not subscribed' : '未订阅')
                    : (lang === 'en' ? 'Lifetime Access' : '无到期日')
          }
        />
        <Stat
          label={lang === 'en' ? 'Valid Through' : '有效期至'}
          value={expiresAt ? fmtDateFull(expiresAt) : '—'}
          foot={
            expiresAt
              ? expired
                ? (lang === 'en' ? 'Expired' : '已过期')
                : (lang === 'en' ? `${Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / 86_400_000))} days left` : `剩余 ${Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / 86_400_000))} 天`)
              : (lang === 'en' ? 'No expiration for free tier' : '免费版无到期日')
          }
        />
        <Stat
          label={lang === 'en' ? 'Daily AI Quota' : 'AI 日额度'}
          value={tier.daily}
          foot={lang === 'en' ? 'Platform key · BYOK unmetered' : '平台 Key · BYOK 不占用'}
        />
        <Stat
          label={lang === 'en' ? 'Monthly AI Quota' : 'AI 月额度'}
          value={tier.monthly}
          foot={lang === 'en' ? 'Based on active plan' : '按当前生效档位'}
        />
      </div>

      {expired && (
        <div className="alert-gradient-brand" style={{ padding: '14px 18px', marginBottom: 20 }}>
          <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
            <div className="icon-box-brand">
              <Icon.shield size={18} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 650, fontSize: 13.5, color: 'var(--brand)', marginBottom: 2 }}>
                {rawPlan === 'trial' ? `${TRIAL_DAYS} 天试用已到期` : `${PLAN_LABEL[rawPlan]}已于 ${fmtDateFull(expiresAt)} 到期`}
              </div>
              <div className="small" style={{ lineHeight: 1.6, opacity: 0.9 }}>
                {rawPlan === 'trial'
                  ? '当前已恢复免费版额度。购买任一套餐即可解锁完整 AI 功能与专享数据引擎。'
                  : '续费后按新周期重新计算生效时间（从续费当日起算，不叠加已过期的时长）。'}
              </div>
            </div>
          </div>
        </div>
      )}

      {!configured && (
        <div className="alert-gradient-amber" style={{ padding: '14px 18px', marginBottom: 20 }}>
          <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
            <div className="icon-box-amber">
              <Icon.cpu size={18} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 650, fontSize: 13.5, color: 'var(--amber)', marginBottom: 2 }}>
                当前处于开发测试模式（模拟支付通道）
              </div>
              <div className="small" style={{ lineHeight: 1.6, opacity: 0.9 }}>
                未配置 <span className="mono">BEACON_PAY_VENDOR=wxpay</span> 与 <span className="mono">BEACON_WXPAY_*</span> 凭证。下单会生成测试二维码，点击「模拟支付成功」即可自动跑通全流程兑现代码。生产环境未配置时会直接拦截。
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-2" style={{ marginBottom: 20, gap: 20 }}>
        {(['personal', 'byok'] as const).map((p) => {
          const isCurrent = current === p;
          const isFeatured = p === 'personal';
          const isGradientCard = isCurrent || (current !== 'personal' && current !== 'byok' && isFeatured);
          
          // 标准版有效期内不能改买更便宜的自带 Key 版（降档拦截，见 lib/pay/plan.ts）
          const downgradeBlocked = p === 'byok' && current === 'personal' && !expired;
          const sub =
            p === 'personal' ? 'AI 由平台提供，即开即用' : '自带模型 Key · 平台只收工具服务费';

          const cardBadge = isCurrent ? (
            <span className="badge badge-gradient-brand">✓ 当前生效套餐</span>
          ) : isFeatured ? (
            <span className="badge badge-brand">热门推荐</span>
          ) : null;

          return (
            <Card
              key={p}
              title={PRICING[p].name}
              sub={isCurrent ? '当前正使用的套餐' : sub}
              action={cardBadge}
              className={isGradientCard ? 'card-selected-gradient' : 'card-hover'}
              style={{
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                padding: '24px',
              }}
            >
              <div>
                <div className="row" style={{ gap: 6, alignItems: 'baseline', marginBottom: 4 }}>
                  <span
                    className={isGradientCard ? 'text-gradient-brand' : ''}
                    style={{ fontSize: 32, fontWeight: 800, letterSpacing: '-0.5px' }}
                  >
                    ¥{PRICING[p].monthFen / 100}
                  </span>
                  <span className="small muted">/ 月</span>
                </div>
                <div className="small muted" style={{ marginBottom: 16 }}>
                  年付 <b style={{ color: 'var(--text)' }}>¥{PRICING[p].yearFen / 100}</b>（付 10 个月，省 ¥{(PRICING[p].monthFen * 12 - PRICING[p].yearFen) / 100}）
                </div>

                <div className="stack" style={{ gap: 4, marginBottom: 18 }}>
                  {FEATURES.map((f) => {
                    const val = f[p];
                    const isCheck = val === '✓';
                    return (
                      <div
                        key={f.name}
                        className="row-between"
                        style={{ gap: 8, padding: '7px 0', borderTop: '1px solid var(--surface-2)' }}
                      >
                        <span className="small" style={{ color: 'var(--text)' }}>{f.name}</span>
                        {isCheck ? (
                          isGradientCard ? (
                            <span className="feature-check-icon">✓</span>
                          ) : (
                            <span className="small" style={{ color: 'var(--green)', fontWeight: 'bold' }}>✓</span>
                          )
                        ) : (
                          <span className="small mono muted">{val}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div>
                {downgradeBlocked ? (
                  <div className="small muted" style={{ padding: '8px 0' }}>
                    标准版仍在有效期内，不能直接改购自带 Key 版。可等到期后再购买，或联系客服。
                  </div>
                ) : !manageable ? (
                  <div className="small muted" style={{ padding: '8px 0' }}>仅工作区所有者可管理计费</div>
                ) : (
                  <div className="row" style={{ gap: 10, marginTop: 8 }}>
                    <Checkout
                      plan={p}
                      periodMonths={1}
                      label={isCurrent ? '续费 1 个月' : '购买 1 个月'}
                      variant={isGradientCard ? 'gradient' : 'primary'}
                    />
                    <Checkout
                      plan={p}
                      periodMonths={12}
                      label={isCurrent ? '续费 1 年（省 2 个月）' : '购买 1 年（省 2 个月）'}
                      variant={isGradientCard ? 'gradient' : 'secondary'}
                    />
                  </div>
                )}
                {/* 自带 Key 版专属：永久买断（99 年）。买断不是降档，即便标准版有效期内也放行，
                    所以独立于上面的降档拦截分支渲染，只要有管理计费权限就展示。 */}
                {p === 'byok' && manageable && (
                  <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px dashed var(--surface-2)' }}>
                    <div className="row-between" style={{ marginBottom: 4 }}>
                      <span className="small" style={{ fontWeight: 650 }}>永久买断 · 99 年</span>
                      <span className="row" style={{ gap: 4, alignItems: 'baseline' }}>
                        <span style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-0.5px' }}>¥{BYOK_LIFETIME_FEN / 100}</span>
                        <span className="small muted">一次付清</span>
                      </span>
                    </div>
                    <div className="small muted" style={{ marginBottom: 8, lineHeight: 1.6 }}>
                      一次买断 99 年使用权，自带 Key 敞开用，永不续费。
                    </div>
                    <Checkout plan="byok" periodMonths={LIFETIME_MONTHS} label="永久买断 ¥2999" variant="primary" />
                  </div>
                )}
                {current === 'trial' && manageable && (
                  <div className="small muted" style={{ marginTop: 8 }}>
                    试用期内购买从付款日起算，试用剩余天数不叠加。
                  </div>
                )}
              </div>
            </Card>
          );
        })}
      </div>

      <Card title="本月产出账本" sub="账单只算「你花了多少」，这张算「你产出了多少」· 全部来自真实库记录，零 AI 成本" style={{ marginBottom: 20 }}>
        {valueReceipt.total === 0 ? (
          <Empty icon="🌱" text="本月还没有产出记录——去选题引擎跑一次推荐，或在工坊起一篇稿，这里就会记上。" />
        ) : (
          <div className="grid grid-4" style={{ gap: 12 }}>
            <Stat label="AI 推荐选题" value={valueReceipt.recommended} foot="本月生成" />
            <Stat label="你采纳的" value={valueReceipt.adopted} foot="进入创作队列" />
            <Stat label="成稿" value={valueReceipt.drafts} foot="草稿 + 派生稿" />
            <Stat label="已发布" value={valueReceipt.published} foot="登记 / 回填的作品" />
            <Stat label="一稿多平台省稿" value={valueReceipt.derived} foot="派生自同源稿" />
            <Stat label="合规拦截" value={valueReceipt.blocked} foot="挡下的红线导出" />
            <Stat label="新增记忆" value={valueReceipt.memories} foot="越用越懂你" />
            <Stat label="本月产出合计" value={valueReceipt.total} foot="七项之和" />
          </div>
        )}
      </Card>

      <Card title="AI 消耗账单" sub="真实 AI 调用次数（不含模拟）· 退款「是否已使用」以此为准" style={{ marginBottom: 20 }}>
        <div className="grid grid-5" style={{ marginBottom: 16 }}>
          <Stat label="今日已用" value={usage.dailyUsed} foot={`日额度 ${usage.tier.daily}`} />
          <Stat label="本月已用" value={usage.monthlyUsed} foot={`月额度 ${usage.tier.monthly}`} />
          <Stat label="剩余日额度" value={Math.max(0, usage.tier.daily - usage.dailyUsed)} foot="每日 0 点重置" />
          <Stat label="本月估算成本" value={`$${usage.monthlyCostUsd.toFixed(2)}`} foot="平台垫付 token" />
          {/* 这一格是**参考折算**，不是「你用的模型」。原来标题直接写「DeepSeek 估算成本」，
              可租户完全可能接的是别家（真机 2026-07-30 接的是 MiniMax），
              界面上凭空冒出一个自己没选过的供应商名，只会让人以为账单算错了。
              DeepSeek 在这里的身份是**计价基准**，标题必须说清这件事。 */}
          <Stat
            label="折合人民币 · 参考价"
            value={usage.monthlyCostDeepseekCny >= 0.01 ? `¥${usage.monthlyCostDeepseekCny.toFixed(2)}` : `¥${usage.monthlyCostDeepseekCny.toFixed(4)}`}
            foot="按 DeepSeek 价目 × 7.25 折算 · 含模拟 Token"
          />
        </div>
        {usage.monthlyUsed === 0 ? (
          <Empty icon="📊" text="本月还没有 AI 调用记录" />
        ) : (
          <div className="grid grid-2" style={{ gap: 20, marginTop: 8 }}>
            {/* 本月按功能分项 */}
            <div style={{
              background: 'var(--surface-2)',
              borderRadius: 'var(--radius-sm)',
              padding: '16px 20px',
              border: '1px solid var(--border)',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
              gap: 12
            }}>
              <div>
                <div className="row-between" style={{ marginBottom: 14 }}>
                  <span className="row" style={{ gap: 6, alignItems: 'center', fontWeight: 650, fontSize: 13.5 }}>
                    <Icon.cpu size={15} style={{ color: 'var(--brand)' }} />
                    <span>本月按功能分项</span>
                  </span>
                  <span className="badge badge-brand">共 {usage.monthlyUsed} 次</span>
                </div>
                <div className="stack" style={{ gap: 12 }}>
                  {usage.byFn.map((f) => {
                    const pct = usage.monthlyUsed > 0 ? ((f.count / usage.monthlyUsed) * 100).toFixed(1) : '0';
                    return (
                      <div key={f.fn}>
                        <div className="row-between" style={{ marginBottom: 5, fontSize: 12.5 }}>
                          <span style={{ fontWeight: 500, color: 'var(--text)' }}>{FN_LABEL[f.fn] ?? f.fn}</span>
                          <span className="mono" style={{ color: 'var(--text-2)' }}>
                            {f.count} 次 <span style={{ opacity: 0.6, fontSize: 11 }}>({pct}%)</span>
                          </span>
                        </div>
                        <div style={{
                          height: 6,
                          width: '100%',
                          background: 'var(--border)',
                          borderRadius: 99,
                          overflow: 'hidden'
                        }}>
                          <div style={{
                            height: '100%',
                            width: `${pct}%`,
                            background: 'linear-gradient(90deg, var(--brand) 0%, #ff9a42 100%)',
                            borderRadius: 99,
                            transition: 'width 0.3s ease'
                          }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* 近 7 日调用趋势 */}
            <div style={{
              background: 'var(--surface-2)',
              borderRadius: 'var(--radius-sm)',
              padding: '16px 20px',
              border: '1px solid var(--border)',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
              gap: 12
            }}>
              <div>
                <div className="row-between" style={{ marginBottom: 14 }}>
                  <span className="row" style={{ gap: 6, alignItems: 'center', fontWeight: 650, fontSize: 13.5 }}>
                    <Icon.chart size={15} style={{ color: 'var(--brand)' }} />
                    <span>近 7 日调用趋势</span>
                  </span>
                  <span className="badge badge-gray">
                    7日共 {usage.recentDays.reduce((sum, d) => sum + d.count, 0)} 次
                  </span>
                </div>

                <div style={{
                  display: 'flex',
                  alignItems: 'flex-end',
                  justifyContent: 'space-between',
                  gap: 10,
                  height: 140,
                  paddingTop: 24,
                  paddingBottom: 4,
                  width: '100%'
                }}>
                  {usage.recentDays.map((d, i) => {
                    const max = Math.max(1, ...usage.recentDays.map((x) => x.count));
                    const isToday = i === usage.recentDays.length - 1;
                    const hasCount = d.count > 0;
                    const barHeightPct = Math.max(8, (d.count / max) * 100);

                    return (
                      <div key={d.date} style={{
                        flex: 1,
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'flex-end',
                        height: '100%',
                        gap: 6
                      }}>
                        <div className="mono" style={{
                          fontSize: 11,
                          fontWeight: hasCount ? 700 : 400,
                          color: hasCount ? 'var(--brand)' : 'var(--text-3)',
                          opacity: hasCount ? 1 : 0.4
                        }}>
                          {d.count}
                        </div>

                        <div style={{
                          width: '100%',
                          maxWidth: 36,
                          height: '80px',
                          display: 'flex',
                          alignItems: 'flex-end',
                          justifyContent: 'center'
                        }}>
                          <div style={{
                            width: hasCount ? '75%' : '40%',
                            height: hasCount ? `${barHeightPct}%` : '4px',
                            background: hasCount
                              ? 'linear-gradient(180deg, #ff9a42 0%, var(--brand) 100%)'
                              : 'var(--border)',
                            borderRadius: hasCount ? '6px 6px 3px 3px' : '4px',
                            boxShadow: hasCount ? '0 2px 8px rgba(232, 85, 45, 0.25)' : 'none',
                            transition: 'all 0.3s cubic-bezier(0.16, 1, 0.3, 1)'
                          }} />
                        </div>

                        <div style={{
                          fontSize: 11,
                          fontWeight: isToday ? 600 : 400,
                          color: isToday ? 'var(--brand)' : 'var(--text-3)',
                          background: isToday ? 'var(--brand-soft)' : 'transparent',
                          padding: isToday ? '1px 6px' : '0',
                          borderRadius: 10
                        }}>
                          {d.date}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        )}
      </Card>

      <Card title="订单记录" sub="最近 10 笔 · 已支付订单可自助申请退款（未消耗 AI 次数可全额退）">
        {orders.length === 0 ? (
          <Empty icon="🧾" text="还没有订单" />
        ) : (
          <div className="stack" style={{ gap: 6 }}>
            {orders.map((o) => (
              <div key={o.id} className="row-between wrap" style={{ gap: 8, padding: '8px 0', borderTop: '1px solid var(--surface-2)' }}>
                <span className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
                  <span className="mono small">{o.outTradeNo}</span>
                  <span className="badge badge-gray">{PLAN_LABEL[o.plan]} · {periodText(o.periodMonths)}</span>
                  <StatusBadge status={o.status} />
                  {o.provider === 'mock' && <span className="badge badge-amber">模拟</span>}
                </span>
                <span className="row wrap" style={{ gap: 12, alignItems: 'center' }}>
                  <span className="row wrap small muted" style={{ gap: 12, alignItems: 'center' }}>
                    {o.grantedDays !== null && <span>发放 {o.grantedDays} 天</span>}
                    <span>¥{(o.amountFen / 100).toFixed(2)}</span>
                    <span>{fmtDateTime(o.createdAt)}</span>
                  </span>
                  {/* 自助退款：仅已支付订单 + owner。金额/是否可退在弹窗内服务端算。
                      按钮单独拎出这一层，不能裹在 small muted 里 —— 那会让它继承灰色小字、
                      看着像一段说明文字而不是可点的操作（用户实际反馈：找不到退款入口）。 */}
                  {o.status === 'paid' && manageable && <RefundButton outTradeNo={o.outTradeNo} amountFen={o.amountFen} />}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="开具发票与法律协议" sub="仅已支付订单 · 人工开具电子普通发票" style={{ marginTop: 16 }}>
        <div className="stack" style={{ gap: 10 }}>
          <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
            <Icon.chat size={16} />
            <span className="small">
              暂不支持在线自助开票。<b>已支付订单</b>如需发票，请联系客服并提供：
              <b>订单号、发票抬头、税号（企业必填）、接收邮箱</b>，我们在 3 个工作日内开具<b>电子普通发票</b>发送到您的邮箱。
              <br />
              客服微信：<span className="mono">{invoice.wechat}</span>　·　客服邮箱：<span className="mono">{invoice.email}</span>
            </span>
          </div>
          <div className="row wrap" style={{ gap: 14, paddingTop: 8, borderTop: '1px solid var(--surface-2)', fontSize: 13 }}>
            <a href="/legal/payment" target="_blank" style={{ color: 'var(--brand)', fontWeight: 600, textDecoration: 'none' }}>
              查看《付款与服务订阅协议》 →
            </a>
            <a href="/legal/terms" target="_blank" style={{ color: 'var(--muted)', textDecoration: 'none' }}>
              《服务条款》
            </a>
            <a href="/legal/privacy" target="_blank" style={{ color: 'var(--muted)', textDecoration: 'none' }}>
              《隐私政策》
            </a>
          </div>
        </div>
      </Card>
    </>
  );
}

function StatusBadge({ status }: { status: string }) {
  const meta: Record<string, { cls: string; text: string }> = {
    created: { cls: 'badge-amber', text: '待支付' },
    paid: { cls: 'badge-green', text: '已支付' },
    closed: { cls: 'badge-gray', text: '已关闭' },
    failed: { cls: 'badge-gray', text: '下单失败' },
    refunded: { cls: 'badge-gray', text: '已退款' },
  };
  const m = meta[status] ?? { cls: 'badge-gray', text: status };
  return <span className={`badge ${m.cls}`}>{m.text}</span>;
}
