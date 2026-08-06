'use client';

import { useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ErrorCard } from '@/components/ErrorCard';
import { ChunkReloadingNotice, useChunkErrorAutoReload } from '@/components/ChunkErrorRecovery';

// 根路由组的错误兜底（登录页等未套 (app) 外壳的路由也走这里）。
// server 端抛出的 RbacError / QuotaExceededError 自带中文文案，原样展示不加工。
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();
  const [, start] = useTransition();
  // 只调 reset() 不会重新拉 server 数据，配合 refresh 才是真「重试」
  const retry = () => start(() => { router.refresh(); reset(); });
  // 换版部署后旧页面拉不到新 chunk：刷新即可自愈，别拿 "Loading chunk 5515 failed" 去烦用户
  const reloading = useChunkErrorAutoReload(error);

  if (reloading) return <ChunkReloadingNotice />;

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <ErrorCard
        error={error}
        blurb="刚才这一步没走通，已保存的草稿和选题不受影响。可以重试，或先回首页。"
        onRetry={retry}
        homeButton={<Link href="/" className="btn">回首页</Link>}
      />
    </div>
  );
}
