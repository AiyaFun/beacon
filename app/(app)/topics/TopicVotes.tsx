'use client';

import { useTransition } from 'react';
import { actVoteTopic } from './actions';

export type VoteSummary = { up: number; down: number; mine: 'up' | 'down' | null };

// 团队投票条。只在工作区有多个成员时才渲染（单人账号看到「投票」是噪声，见 page.tsx）。
//
// 交互：再点一次已选的那个 = 撤票。比另做一个「取消」按钮省一次点击，也符合直觉。
export function TopicVotes({ topicId, votes }: { topicId: string; votes: VoteSummary }) {
  const [pending, start] = useTransition();

  const vote = (value: 'up' | 'down') => start(async () => { await actVoteTopic(topicId, value); });

  return (
    <div className="row" style={{ gap: 8, alignItems: 'center' }}>
      <span className="small muted">团队意见：</span>
      <button
        className={`btn btn-sm${votes.mine === 'up' ? ' btn-primary' : ''}`}
        disabled={pending}
        onClick={() => vote('up')}
        title={votes.mine === 'up' ? '再点一次撤回' : '我想做这个'}
      >
        想做 {votes.up > 0 ? votes.up : ''}
      </button>
      <button
        className={`btn btn-sm${votes.mine === 'down' ? ' btn-primary' : ''}`}
        disabled={pending}
        onClick={() => vote('down')}
        title={votes.mine === 'down' ? '再点一次撤回' : '我觉得不合适'}
      >
        不想做 {votes.down > 0 ? votes.down : ''}
      </button>
      {/* 说清票数不参与打分——否则用户会以为刷票能把选题顶上去 */}
      <span className="small muted" title="票数是团队协调用的，不影响综合分与排序算法">
        仅供协调，不计入评分
      </span>
    </div>
  );
}
