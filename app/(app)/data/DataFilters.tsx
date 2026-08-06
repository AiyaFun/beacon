'use client';

import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { RANGES } from '@/lib/insight/dashboard-filter';
import { platformName } from '@/lib/constants';

// 时间段 / 平台筛选。searchParams 驱动（可分享链接、无客户端状态），切换即刷新 server component。
export function DataFilters({ platforms, range, platform }: { platforms: string[]; range: string; platform: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params.toString());
    next.set(key, value);
    next.delete('page'); // 换筛选回到第一页
    router.push(`${pathname}?${next.toString()}`);
  }

  return (
    <div className="row wrap" style={{ gap: 12, alignItems: 'center' }}>
      <div className="row" style={{ gap: 4 }}>
        {RANGES.map((r) => (
          <button
            key={r.key}
            className={`badge ${range === r.key ? 'badge-brand' : 'badge-gray'}`}
            style={{ cursor: 'pointer', border: 'none' }}
            aria-pressed={range === r.key}
            onClick={() => setParam('range', r.key)}
          >
            {r.label}
          </button>
        ))}
      </div>
      {platforms.length > 1 && (
        <div className="row wrap" style={{ gap: 4 }}>
          <button
            className={`badge ${platform === 'all' ? 'badge-brand' : 'badge-gray'}`}
            style={{ cursor: 'pointer', border: 'none' }}
            aria-pressed={platform === 'all'}
            onClick={() => setParam('platform', 'all')}
          >
            全平台
          </button>
          {platforms.map((p) => (
            <button
              key={p}
              className={`badge ${platform === p ? 'badge-brand' : 'badge-gray'}`}
              style={{ cursor: 'pointer', border: 'none' }}
              aria-pressed={platform === p}
              onClick={() => setParam('platform', p)}
            >
              {platformName(p)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
