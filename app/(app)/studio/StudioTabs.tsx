'use client';

import { useState } from 'react';

// 工坊下半区的标签页：技能出成品 / 标题与封面 / 一稿多平台 / 草稿会诊。
//
// 【为什么从四张常驻卡片改成标签页】这四件事互斥——同一时刻只会做其中一件，
// 但原来它们各占一张全宽卡片竖着排，光是"没展开任何东西"的说明文字和按钮就吃掉约 900px，
// 把真正天天用的正文编辑区挤到屏幕上方一小条。改成标签页后，
// 这一区的高度由"你正在做的那件事"决定，而不是由"一共有几件事"决定。
//
// 非当前页用 hidden 而不是不渲染：跑完标题矩阵、切去看技能、再切回来，
// 结果还在。卸载重挂等于把刚花掉的一次 AI 额度扔了。

export type StudioTab = {
  key: string;
  label: string;
  /** 标签右侧的小计数（同源版本数、已采纳意见数…），0/undefined 不显示 */
  badge?: number;
  /** 面板顶部那一行说明，替代原来每张卡片上方的三行小字 */
  hint?: React.ReactNode;
  node: React.ReactNode;
};

export function StudioTabs({ tabs }: { tabs: StudioTab[] }) {
  const [active, setActive] = useState(tabs[0]?.key ?? '');
  const cur = tabs.find((t) => t.key === active) ?? tabs[0];
  if (!cur) return null;

  return (
    <div>
      <div className="tabs" role="tablist">
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
