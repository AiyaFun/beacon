'use client';

import { useEffect, useState } from 'react';
import { onAccepted, type AcceptedTopic } from './accepted-bus';

// 采纳后的落地条：贴在内容区底部，直到用户自己收掉。
//
// 它必须活在**页面根部**而不是选题卡里——采纳成功那一刻卡片就被重渲染卸载了（见 accepted-bus.ts）。
//
// 布局上三件事：
// ① 按**内容区**居中（左移半个侧栏宽），不是按视口居中——视口居中会明显偏左，看着像没对齐；
// ② 单行：它是一条「刚做完什么 + 接着做什么」的提示，不是卡片，两行的方块盖在选题上很吵；
// ③ 宽度封顶 640px，居中后左右各留够空，压不到右下角的 AI 助手浮标。
import { useI18n } from '@/lib/i18n';

export function AcceptedBar() {
  const { lang } = useI18n();
  const [topic, setTopic] = useState<AcceptedTopic | null>(null);

  useEffect(() => onAccepted(setTopic), []);

  if (!topic) return null;

  return (
    <>
      <style>{`
        .accepted-anchor {
          position: fixed;
          bottom: 20px;
          left: calc(50% + var(--sidebar-w) / 2);
          transform: translateX(-50%);
          z-index: 55;
          width: max-content;
          max-width: min(640px, calc(100vw - var(--sidebar-w) - 96px));
        }
        .accepted-bar {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px 12px 10px 14px;
          box-shadow: var(--shadow-lg);
          animation: accepted-bar-in 0.22s cubic-bezier(0.16, 1, 0.3, 1);
        }
        .accepted-head {
          display: flex;
          align-items: center;
          gap: 10px;
          min-width: 0;
          flex: 1;
        }
        .accepted-acts { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
        .accepted-title {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        @keyframes accepted-bar-in {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @media (max-width: 720px) {
          .accepted-anchor {
            left: 12px;
            right: 12px;
            bottom: 12px;
            transform: none;
            width: auto;
            max-width: none;
          }
          .accepted-bar { flex-wrap: wrap; }
          .accepted-head { flex: 1 1 100%; }
          .accepted-acts { margin-left: auto; }
        }
      `}</style>
      <div className="accepted-anchor">
        <div className="card accepted-bar" role="status">
          <div className="accepted-head">
            <span className="badge badge-green" style={{ flexShrink: 0 }}>
              {lang === 'en' ? 'Accepted' : '已采纳'}
            </span>
            <b className="small accepted-title" title={topic.title}>{topic.title}</b>
            <span className="small muted hide-mobile" style={{ flexShrink: 0 }}>
              {lang === 'en' ? 'Find anytime under Accepted tab' : '在「已采纳」分区随时找得到'}
            </span>
          </div>
          <div className="accepted-acts">
            <a href={`/studio?topicId=${topic.id}`} className="btn btn-sm btn-accent" style={{ fontSize: 13 }}>
              {lang === 'en' ? 'Draft in Studio →' : '去工坊起这篇稿 →'}
            </a>
            <button className="btn btn-sm btn-ghost" onClick={() => setTopic(null)}>
              {lang === 'en' ? 'Keep Browsing' : '继续挑'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
