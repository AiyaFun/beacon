'use client';

import { jumpToStudioTab } from './StudioTabs';

// 当前草稿条「写完之后」一排里的「封面」：只做一件事——切到「标题与封面」tab 并把封面工位滚进视野。
// 不在这一排就地展开（这排已有 6-7 个同权重按钮，封面选项需要面积），也不走导航（不重挂、不丢结果）。
export function CoverJumpButton() {
  return (
    <button
      type="button"
      className="btn btn-sm"
      onClick={() => jumpToStudioTab('title', 'cover-station')}
      title="按草稿平台的比例出一张 AI 封面（在下方「标题与封面」里）"
    >
      🎨 封面
    </button>
  );
}
