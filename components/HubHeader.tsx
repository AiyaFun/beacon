import type { ReactNode } from 'react';

// 合并页组的紧凑页头（2026-08-26 用户「占用了比较大的篇幅」）。
//
// 【替掉的是什么】此前每个标签组页面是三层楼：PageHead 大标题一行 + 副标题一行
// + 标签条一行（+ 个别页还有徽章行）——四页一组的「做内容」，切一次标签这三层全部
// 重画一遍，观感就是「每次打开都重新刷一下页面」。
// 现在一行放下：组名（小） | 页签 | 右侧操作。副标题降为悬停提示（title 属性）——
// 它是解释性文字，天天看的人不需要它常驻占一行。
//
// 【切换不再有白屏跳】配套的 HubLoading 让每个路由在取数期间就渲染出同一个头——
// 头部纹丝不动，变的只有下方内容区。
export function HubHeader({
  title,
  hint,
  tabs,
  action,
  meta,
}: {
  /** 组名（与侧栏那一条同名：看情报 / 做内容 / 技能 · 连接器 / 记忆与素材…） */
  title: string;
  /** 原副标题：收进悬停，不再常驻占行 */
  hint?: string;
  /** 页签条（IntelTabs / MakeTabs / … 以 inline 模式传入）。没有页签组的页可省 */
  tabs?: ReactNode;
  /** 右侧主操作（重新采集 / 采集竞对 / 生成今日推荐…） */
  action?: ReactNode;
  /** 操作左侧的小徽章（数据新鲜度等），手机上可被挤换行 */
  meta?: ReactNode;
}) {
  return (
    <div className="hub-head" title={hint}>
      <h1 className="hub-head-title">{title}</h1>
      {tabs}
      <span className="hub-head-right">
        {meta}
        {action}
      </span>
    </div>
  );
}
