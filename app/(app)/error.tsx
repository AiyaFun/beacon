'use client';

import { useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ErrorCard } from '@/components/ErrorCard';
import { ChunkReloadingNotice, useChunkErrorAutoReload } from '@/components/ChunkErrorRecovery';
import { useI18n } from '@/lib/i18n';

// 已登录区的错误兜底：侧边栏/顶栏保留，只有内容区换成错误卡片。
// RbacError（权限不足）、QuotaExceededError（额度用尽，文案里带升级/配 Key 的自救指引）
// 的中文信息原样展示。
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { lang } = useI18n();
  const isEn = lang === 'en';
  const router = useRouter();
  const [, start] = useTransition();
  // 只调 reset() 不会重新拉 server 数据，配合 refresh 才是真「重试」
  const retry = () => start(() => { router.refresh(); reset(); });
  // 换版部署后旧页面拉不到新 chunk：刷新即可自愈，别拿 "Loading chunk 5515 failed" 去烦用户
  const reloading = useChunkErrorAutoReload(error);

  if (reloading) return <ChunkReloadingNotice />;

  return (
    <ErrorCard
      error={error}
      blurb={isEn
        ? 'The previous step failed, but saved drafts and topics are unaffected. Here is the reason:'
        : '刚才这一步没走通，已保存的草稿和选题不受影响。下面是具体原因：'}
      emptyFallback={isEn
        ? 'Page failed to load properly. Retrying usually helps.'
        : '页面刚才没能正常加载，重试一般就能好。'}
      cardStyle={{ maxWidth: 560, margin: '48px auto' }}
      onRetry={retry}
      homeButton={<Link href="/" className="btn">{isEn ? 'Back to Home' : '回首页'}</Link>}
    />
  );
}
