'use client';

import { jumpToStudioTab } from './StudioTabs';
import { useI18n } from '@/lib/i18n';

// 当前草稿条「写完之后」一排里的「封面」：只做一件事——切到「标题与封面」tab 并把封面工位滚进视野。
export function CoverJumpButton() {
  const { lang } = useI18n();
  return (
    <button
      type="button"
      className="btn btn-sm"
      onClick={() => jumpToStudioTab('title', 'cover-station')}
      title={lang === 'en' ? 'Generate AI cover matching draft platform (in Title & Cover tab below)' : '按草稿平台的比例出一张 AI 封面（在下方「标题与封面」里）'}
    >
      {lang === 'en' ? '🎨 Cover' : '🎨 封面'}
    </button>
  );
}
