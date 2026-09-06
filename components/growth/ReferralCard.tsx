import { Card } from '@/components/ui';
import { ensureReferralCode, referralLink, referralStats, REFERRAL_DAYS, REFERRAL_MONTHLY_CAP } from '@/lib/growth/referral';
import { siteUrl } from '@/lib/brand';
import { isDemoTenant } from '@/lib/demo/guard';
import { CopyField } from './CopyField';

// 邀请卡（2026-09-05 增长）：邀 1 位创作者注册，双方各得 7 天标准版。
// 服务端组件：邀请码懒生成（第一次打开这张卡时才写库）。演示租户不渲染——那是只读展台。
export async function ReferralCard({ tenantId, lang, compact }: { tenantId: string; lang: string; compact?: boolean }) {
  if (isDemoTenant(tenantId)) return null;
  const en = lang === 'en';
  let code = '';
  try {
    code = await ensureReferralCode(tenantId);
  } catch {
    return null; // 生成失败就不渲染，别给用户一个空链接
  }
  const link = referralLink(siteUrl(), code);
  const stats = await referralStats(tenantId);
  return (
    <Card
      title={en ? `Invite a creator · both get ${REFERRAL_DAYS} days` : `邀请一位创作者 · 双方各得 ${REFERRAL_DAYS} 天`}
      sub={en
        ? `Standard plan days are added to both accounts. ${stats.total} joined so far · ${stats.remaining} left this month`
        : `对方注册即到账，你的到期日同步顺延 · 已成功邀请 ${stats.total} 人 · 本月还可 ${stats.remaining} 次`}
      style={{ marginBottom: compact ? 16 : 20 }}
    >
      <CopyField value={link} lang={lang} />
      {!compact && (
        <p className="small muted" style={{ marginTop: 8, lineHeight: 1.7 }}>
          {en
            ? `Free accounts get a fresh ${REFERRAL_DAYS}-day trial; paid and trial accounts get ${REFERRAL_DAYS} days added. Lifetime plans are not changed. Up to ${REFERRAL_MONTHLY_CAP} rewards a month; every grant is recorded and auditable.`
            : `免费档拿到一段新的 ${REFERRAL_DAYS} 天试用；试用与付费档在到期日上顺延 ${REFERRAL_DAYS} 天；永久买断不叠加。每月最多 ${REFERRAL_MONTHLY_CAP} 次，每一笔都有记录可查。`}
        </p>
      )}
    </Card>
  );
}
