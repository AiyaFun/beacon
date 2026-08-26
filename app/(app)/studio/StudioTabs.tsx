'use client';

import { useEffect, useState } from 'react';

// 工坊下半区的标签页：技能出成品 / 标题与封面 / 一稿多平台 / 草稿会诊。
//
// 【为什么从四张常驻卡片改成标签页】这四件事互斥——同一时刻只会做其中一件，
// 但原来它们各占一张全宽卡片竖着排，光是"没展开任何东西"的说明文字和按钮就吃掉约 900px，
// 把真正天天用的正文编辑区挤到屏幕上方一小条。改成标签页后，
// 这一区的高度由"你正在做的那件事"决定，而不是由"一共有几件事"决定。
//
// 非当前页用 hidden 而不是不渲染：跑完标题矩阵、切去看技能、再切回来，
// 结果还在。卸载重挂等于把刚花掉的一次 AI 额度扔了。
//
// 外部切换有两条路：① URL ?tab=xxx（深链，服务端读到后作 initialTab 传进来）；
// ② window 上的 `studio:tab` 自定义事件（页面内的按钮，比如当前草稿条上的「封面」——
//    不走导航、不重挂、tab 里已有的结果都还在）。

export type StudioTab = {
  key: string;
  label: string;
  /** 标签右侧的小计数（同源版本数、已采纳意见数…），0/undefined 不显示 */
  badge?: number;
  /** 面板顶部那一行说明，替代原来每张卡片上方的三行小字 */
  hint?: React.ReactNode;
  node: React.ReactNode;
};

export type StudioTabEvent = { key: string; anchor?: string };

/** 页面内切 tab 的统一入口（按钮组件调它，StudioTabs 监听它）。 */
export function jumpToStudioTab(key: string, anchor?: string): void {
  window.dispatchEvent(new CustomEvent<StudioTabEvent>('studio:tab', { detail: { key, anchor } }));
}

export function StudioTabs({ tabs, initialTab }: { tabs: StudioTab[]; initialTab?: string }) {
  const [active, setActive] = useState(
    initialTab && tabs.some((t) => t.key === initialTab) ? initialTab : (tabs[0]?.key ?? ''),
  );

  useEffect(() => {
    if (initialTab && tabs.some((t) => t.key === initialTab)) setActive(initialTab);
    // tabs 的 key 集合不随渲染变（page 决定），只跟 initialTab 变
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTab]);

  useEffect(() => {
    const onJump = (e: Event) => {
      const key = (e as CustomEvent<StudioTabEvent>).detail?.key;
      if (key && tabs.some((t) => t.key === key)) setActive(key);
    };
    window.addEventListener('studio:tab', onJump);
    return () => window.removeEventListener('studio:tab', onJump);
  }, [tabs]);

  const cur = tabs.find((t) => t.key === active) ?? tabs[0];
  if (!cur) return null;

  return (
    <div>
      <div className="tabs tabs-sub" role="tablist">
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
              <span className="badge badge-gray" style={{ marginLeft: 6, fontSize: 10 }}>{t.badge}</span>
            ) : null}
          </button>
        ))}
      </div>

      {cur.hint && (
        <div className="small muted" style={{ marginBottom: 12, lineHeight: 1.6 }}>{cur.hint}</div>
      )}

      {tabs.map((t) => (
        <div key={t.key} role="tabpanel" hidden={t.key !== cur.key}>
          {t.node}
        </div>
      ))}
    </div>
  );
}
