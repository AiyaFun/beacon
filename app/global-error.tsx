'use client';

// 根 layout 自身崩掉才会走到这里：整棵树被替换，必须自带 <html><body> 并自己引样式
import './globals.css';
import { ErrorCard } from '@/components/ErrorCard';
import { ChunkReloadingNotice, useChunkErrorAutoReload } from '@/components/ChunkErrorRecovery';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // 根 layout 的 chunk 没拉到就会走到这里，是分片失败最常见的落点之一
  const reloading = useChunkErrorAutoReload(error);

  if (reloading) {
    return (
      <html lang="zh-CN">
        <body><ChunkReloadingNotice /></body>
      </html>
    );
  }

  return (
    <html lang="zh-CN">
      <body>
        <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
          <ErrorCard
            error={error}
            blurb="页面刚才没能正常加载，已保存的内容不受影响。重试一下，不行就回首页。"
            onRetry={() => reset()}
            // 根 layout 已崩，router 上下文不可靠，用原生跳转
            homeButton={<a href="/" className="btn">回首页</a>}
          />
        </div>
      </body>
    </html>
  );
}
