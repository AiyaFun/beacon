'use client';

import { useState, useTransition } from 'react';
import { Icon } from '@/components/icons';
import { actGenerateAdvice, actAdviceToTask, type Advice } from '@/app/(app)/actions';

type Props = {
  initialSuggestions: string[];
  context: {
    completeness: number;
    topicCount: number;
    publishCount: number;
    acceptedCount: number;
    memoryCount: number;
    competitorCount: number;
  };
};

export function AdviceCard({ initialSuggestions, context }: Props) {
  // ⚠️ 不要写成 useState(initialSuggestions)。那样 props 变了 state 也不动：
  // 真机 2026-07-30——点「生成今日推荐」成功后，server action 的 revalidate 让首页重渲，
  // 上面的「今日推荐 Top3」已经显示 3 条了，而同屏的今日建议还在说「还没有今日推荐」，
  // 要整页刷新才更新。服务端算好的这几条是 props 的纯函数，本来就不该进 state。
  //
  // 只有用户自己点了「生成今日建议」拿到的 LLM 结果才需要 state——它压过 props，
  // 否则下一次 revalidate 会把用户刚生成的建议冲掉。
  const [ownAdvice, setOwnAdvice] = useState<{ lines: string[]; mocked: boolean } | null>(null);
  const suggestions = ownAdvice?.lines ?? initialSuggestions;
  const mocked = ownAdvice?.mocked ?? false;
  const [generating, startGenerate] = useTransition();
  const [converting, startConvert] = useTransition();
  const [converted, setConverted] = useState<Set<number>>(new Set());

  function generate() {
    startGenerate(async () => {
      const r: Advice = await actGenerateAdvice(context);
      const lines = r.text.split('\n').map((l) => l.trim()).filter(Boolean);
      setOwnAdvice({
        lines: lines.length > 0 ? lines : ['暂时没有高置信建议——继续做你手头的事就好。'],
        mocked: r.mocked,
      });
      setConverted(new Set());
    });
  }

  function toTask(idx: number, text: string) {
    startConvert(async () => {
      await actAdviceToTask(text);
      setConverted((prev) => new Set(prev).add(idx));
    });
  }

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="row-between" style={{ marginBottom: 4 }}>
        <div>
          {mocked && <span className="badge badge-amber" style={{ marginRight: 8 }}>Mock</span>}
        </div>
        <button className="btn btn-sm btn-ghost" onClick={generate} disabled={generating}>
          <Icon.sparkles size={13} /> {generating ? '生成中…' : '生成今日建议'}
        </button>
      </div>
      {suggestions.map((sug, i) => (
        <div key={i} className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
          <span style={{ color: 'var(--brand)', marginTop: 2 }}>•</span>
          <span className="small" style={{ flex: 1 }}>{sug}</span>
          {!converted.has(i) ? (
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => toTask(i, sug)}
              disabled={converting}
              title="转为任务"
            >
              <Icon.plus size={12} />
            </button>
          ) : (
            <span className="badge badge-green" style={{ fontSize: 10 }}>已加入</span>
          )}
        </div>
      ))}
    </div>
  );
}
