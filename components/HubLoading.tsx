import type { ReactNode } from 'react';

// 标签组路由的 loading 骨架：头部与真实页完全同构（同一个 HubHeader + 同一条页签），
// 切换标签的瞬间头部原地不动，只有内容区显示占位——「整页重刷」的观感就没了。
// 每个路由的 loading.tsx 只需一行：<HubLoading header={<HubHeader …/>} />
export function HubLoading({ header }: { header: ReactNode }) {
  return (
    <>
      {header}
      <div className="hub-skel" aria-hidden>
        <div className="hub-skel-block" style={{ height: 120 }} />
        <div className="hub-skel-block" style={{ height: 260 }} />
      </div>
    </>
  );
}
