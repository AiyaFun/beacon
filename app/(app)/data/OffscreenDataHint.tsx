'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { actSwitchAccount } from '@/app/(app)/actions';
import type { RangeKey } from '@/lib/insight/dashboard-filter';

export type ElsewhereAccount = { id: string; name: string; platformLabel: string; count: number };

// 「插件说回填成功了，可这页什么都没有。」
//
// 本页有两道**完全静默**的过滤，任一命中都是这个现象：
//   ① accountId —— 记录压根不查出来。数据挂在别的创作账号名下，这页永远看不见
//      （插件在工作区没有对应平台账号时会自动建一个新号并写进去，于是新数据全在新号名下，
//       而网页顶栏选的还是老号）。
//   ② 时间范围 —— 默认只看近 30 天。插件现在能读到作品的**真实发表时间**了，
//      回填一批半年前的老作品，条条都在窗口外，表格就是空的。
//
// 数据在库里躺着，用户看到的却只有一句「已回填 N 条」和一个空页面，没有任何线索区分这两种。
// 这个组件把两种都说破，并且每种都给一个能点的下一步——而不是让用户以为看板坏了。
export function OffscreenDataHint({
  totalForAccount,
  visible,
  range,
  platformFilter,
  elsewhere,
}: {
  totalForAccount: number;
  visible: number;
  range: RangeKey;
  platformFilter: string;
  elsewhere: ElsewhereAccount[];
}) {
  const [pending, start] = useTransition();
  const router = useRouter();

  const hiddenByFilter = totalForAccount > 0 && visible === 0;
  // 当前账号一条都没有、而别的账号有——这就是「回填成功却看不到」最常见的那一种
  const onlyElsewhere = totalForAccount === 0 && elsewhere.length > 0;
  if (!hiddenByFilter && !onlyElsewhere) return null;

  function switchTo(id: string) {
    start(async () => {
      await actSwitchAccount(id);
      router.refresh();
    });
  }

  function showAll() {
    const q = new URLSearchParams({ range: 'all' });
    if (platformFilter && platformFilter !== 'all') q.set('platform', platformFilter);
    router.push(`/data?${q.toString()}`);
  }

  return (
    <div
      className="card"
      style={{ marginBottom: 16, borderLeft: '3px solid var(--brand, #e8552d)' }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6 }}>数据已经回填进来了，只是不在当前视图里</div>

      {hiddenByFilter && (
        <div className="small" style={{ marginBottom: 8 }}>
          这个账号名下有 <b>{totalForAccount}</b> 条作品，但
          {range !== 'all' && <>都不在<b>{range === '7d' ? '近 7 天' : '近 30 天'}</b>内</>}
          {range !== 'all' && platformFilter !== 'all' && '，且'}
          {platformFilter !== 'all' && <>不属于当前筛选的平台</>}
          ——插件回填时带的是作品的<b>真实发表时间</b>，老作品自然落在窗口外。
          <div style={{ marginTop: 6 }}>
            <button type="button" className="btn btn-sm" onClick={showAll} disabled={pending}>
              看全部时间范围
            </button>
          </div>
        </div>
      )}

      {elsewhere.length > 0 && (
        <div className="small">
          另外还有数据记在<b>其它创作账号</b>名下（本页只显示顶栏当前选中的那个账号）：
          <div className="stack" style={{ gap: 6, marginTop: 6 }}>
            {elsewhere.map((a) => (
              <div key={a.id} className="row" style={{ gap: 8, alignItems: 'center' }}>
                <span>
                  {a.platformLabel} · <b>{a.name}</b>：{a.count} 条
                </span>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => switchTo(a.id)}
                  disabled={pending}
                >
                  切到这个账号
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
