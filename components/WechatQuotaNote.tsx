import Link from 'next/link';
import { wechatQuotaStatus, WECHAT_PLATFORM_MONTHLY_QUOTA } from '@/lib/pay/datasource-quota';

// 「公众号竞对：本月平台代付额度」一行说明（2026-09-05）。
// 平台没配 Key 时不渲染——那时页面别处已如实说「数据源未启用」，这里再说一遍是噪音。
export async function WechatQuotaNote({ workspaceId, lang }: { workspaceId: string; lang: string }) {
  const q = await wechatQuotaStatus(workspaceId);
  if (!q.configured) return null;
  const en = lang === 'en';
  const unlimited = !Number.isFinite(q.limit);
  return (
    <div className="small muted" style={{ marginBottom: 10, lineHeight: 1.7 }}>
      {en ? (
        <>WeChat Official Account lookups are paid by the platform: {unlimited ? 'unlimited' : `${q.used} / ${q.limit} used this month`}
          {q.limit === 0 ? <> · <Link href="/billing" style={{ color: 'var(--brand)' }}>Standard plan includes {WECHAT_PLATFORM_MONTHLY_QUOTA.personal} a month</Link></> : null}.</>
      ) : (
        <>公众号竞对查询由平台代付：{unlimited ? '不限次' : `本月已用 ${q.used} / ${q.limit} 次`}
          {q.limit === 0 ? <>，当前档位不含 · <Link href="/billing" style={{ color: 'var(--brand)' }}>标准版每月 {WECHAT_PLATFORM_MONTHLY_QUOTA.personal} 次</Link></> : null}
          。用完后仍可用导出文件导入。</>
      )}
    </div>
  );
}
