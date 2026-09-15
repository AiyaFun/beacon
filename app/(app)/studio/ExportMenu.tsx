'use client';

import { useEffect, useRef } from 'react';
import { Icon } from '@/components/icons';
import { CopyText } from '@/components/CopyText';
import { ExportButtons } from './ExportButtons';
import { CardExport } from './CardExport';
import { useI18n } from '@/lib/i18n';

// 「导出 ▾」下拉：把复制（发布包/正文）与导出（Word/演示文稿/图文卡）收进发布按钮旁的一个入口。
//
// 【为什么收起来】这五个按钮原先在标题区单独占一排常驻。它们全是「稿子定了之后」的出口动作，
// 每次打开草稿都先看到一排出口，编辑框却被挤到首屏下半截。收成一个下拉，标题区只剩一行。
//
// 【为什么用原生 details】零 JS 也能开合、服务端可渲染；里面的按钮点了不会自动收起
//（导出要等「已导出」提示，图文卡要等弹层），这正是想要的。唯一补的 JS 是点外面/按 Esc 关掉。
// summary 里只放文字，不放按钮（同 components/ui.tsx Fold 的约束：按钮 click 冒泡会切掉折叠态）。
export function ExportMenu({
  draftId,
  title,
  content,
}: {
  draftId: string;
  title: string;
  /** 最新一版正文；为空时不出复制组（没东西可复制），导出仍可点，由服务端回「草稿暂无内容」 */
  content: string;
}) {
  const { lang } = useI18n();
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      const el = ref.current;
      if (!el || !el.open) return;
      if (e.target instanceof Node && el.contains(e.target)) return;
      el.open = false;
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && ref.current?.open) ref.current.open = false;
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <details ref={ref} className="studio-export-menu">
      <summary className="btn small ghost" title={lang === 'en' ? 'Copy or export this draft' : '复制或导出这篇稿子'}>
        <Icon.download size={13} /> {lang === 'en' ? 'Export' : '导出'}
        <span className="studio-export-caret" aria-hidden="true">▾</span>
      </summary>
      <div className="studio-export-panel">
        {content && (
          <div className="studio-export-group">
            <span className="studio-group-label">
              <Icon.copy size={12} /> {lang === 'en' ? 'Copy' : '复制'}
            </span>
            <CopyText text={`${title}\n\n${content}`} label={lang === 'en' ? 'Package' : '发布包'} />
            <CopyText text={content} label={lang === 'en' ? 'Body' : '正文'} />
          </div>
        )}
        <div className="studio-export-group">
          <span className="studio-group-label">
            <Icon.download size={12} /> {lang === 'en' ? 'Export' : '导出'}
          </span>
          <ExportButtons draftId={draftId} compact />
          <CardExport draftId={draftId} compact />
        </div>
      </div>
    </details>
  );
}
