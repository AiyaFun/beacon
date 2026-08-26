'use client';

import { useEffect, useState } from 'react';

// 页面级标签页：把一页里互斥的几件事分开，而不是让用户从头滚到尾。
//
// 【为什么需要】数据看板一页里塞了 14 个区块（指标、作品表、受众、原声、复盘、增长、
// 录入数据…），任何一件事都要滚过其余十三件才看得到。这跟创作工坊当初的问题一样，
// 那边的结论是：**这一区的高度该由「你正在做的那件事」决定，而不是由「一共有几件事」决定**。
//
// 【和「藏起来」的区别】标签一直在，一眼数得清有几件事、点一下就到。
// 真正的藏是「入口根本不存在」——那才是用户以为功能没有的原因。
//
// 【为什么用 hidden 而不是不渲染】面板里有服务端渲染好的内容与已展开的状态，
// 卸载重挂等于每次切回来都从头来一遍；而这些内容本来就已经在这一次响应里了。
//
// 【和 app/(app)/studio/StudioTabs.tsx 的关系】那一份是创作工坊专用的：它多一套
// `studio:tab` 自定义事件，让页面里别处的按钮（「封面」「配图」）能切到某个页签而不重挂。
// 这一份只做「切页签」这一件事，不带事件通道。**需要页内跳转时用那一份，其余用这一份**；
// 合并成一个的代价是把事件通道塞进每一页，收益只有少一个文件，不值得。
export type PageTab = {
  key: string;
  label: string;
  /** 右上角的小计数（几条待办/几条记录），0 或 undefined 不显示 */
  badge?: number;
  /** 面板顶部一句说明这一页签是干什么的 */
  hint?: React.ReactNode;
  node: React.ReactNode;
};

export function PageTabs({ tabs, initial,
  variant,
}: { tabs: PageTab[]; initial?: string 
  /** 'sub' = 次级标签条：这一页已经有一层主标签时用它，视觉上分出主次 */
  variant?: 'sub';
}) {
  const [active, setActive] = useState(
    initial && tabs.some((t) => t.key === initial) ? initial : (tabs[0]?.key ?? ''),
  );

  // 深链（?tab=growth）与页内锚点：服务端把 initial 传下来，这里跟着变。
  useEffect(() => {
    if (initial && tabs.some((t) => t.key === initial)) setActive(initial);
    // tabs 的 key 集合由页面决定，不随渲染变
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  const cur = tabs.find((t) => t.key === active) ?? tabs[0];
  if (!cur) return null;

  return (
    <div>
      <div className={`tabs${variant === "sub" ? " tabs-sub" : ""}`} role="tablist">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={t.key === cur.key}
            className={`tab ${t.key === cur.key ? 'active' : ''}`}
            onClick={() => setActive(t.key)}
          >
            {t.label}
            {t.badge ? (
              <span className="badge badge-gray" style={{ marginLeft: 6, fontSize: 10 }}>
                {t.badge}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {cur.hint && (
        <div className="small muted" style={{ margin: '10px 0 12px', lineHeight: 1.6 }}>
          {cur.hint}
        </div>
      )}

      {tabs.map((t) => (
        <div key={t.key} role="tabpanel" hidden={t.key !== cur.key}>
          {t.node}
        </div>
      ))}
    </div>
  );
}
