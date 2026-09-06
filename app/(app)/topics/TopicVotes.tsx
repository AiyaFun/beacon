'use client';

import { useTransition } from 'react';
import { actVoteTopic } from './actions';
import { useI18n } from '@/lib/i18n';

export type VoteSummary = { up: number; down: number; mine: 'up' | 'down' | null };

// 团队投票条。只在工作区有多个成员时才渲染（单人账号看到「投票」是噪声，见 page.tsx）。
//
// 交互：再点一次已选的那个 = 撤票。比另做一个「取消」按钮省一次点击，也符合直觉。
export function TopicVotes({ topicId, votes }: { topicId: string; votes: VoteSummary }) {
  const { lang } = useI18n();
  const [pending, start] = useTransition();

  const vote = (value: 'up' | 'down') => start(async () => { await actVoteTopic(topicId, value); });

  return (
    <div className="row" style={{ gap: 8, alignItems: 'center' }}>
      <span className="small muted">{lang === 'en' ? 'Team feedback:' : '团队意见：'}</span>
      <button
        className={`btn btn-sm${votes.mine === 'up' ? ' btn-primary' : ''}`}
        disabled={pending}
        onClick={() => vote('up')}
        title={
          votes.mine === 'up'
            ? (lang === 'en' ? 'Click again to withdraw' : '再点一次撤回')
            : (lang === 'en' ? 'I want to cover this' : '我想做这个')
        }
      >
        {lang === 'en' ? 'Yes' : '想做'} {votes.up > 0 ? votes.up : ''}
      </button>
      <button
        className={`btn btn-sm${votes.mine === 'down' ? ' btn-primary' : ''}`}
        disabled={pending}
        onClick={() => vote('down')}
        title={
          votes.mine === 'down'
            ? (lang === 'en' ? 'Click again to withdraw' : '再点一次撤回')
            : (lang === 'en' ? 'I don’t think it fits' : '我觉得不合适')
        }
      >
        {lang === 'en' ? 'Skip' : '不想做'} {votes.down > 0 ? votes.down : ''}
      </button>
      {/* 说清票数不参与打分——否则用户会以为刷票能把选题顶上去 */}
      <span
        className="small muted"
        title={
          lang === 'en'
            ? 'Votes are for team coordination and do not alter AI scores or ranking algorithms.'
            : '票数是团队协调用的，不影响综合分与排序算法'
        }
      >
        {lang === 'en' ? 'Coordination only, excluded from score' : '仅供协调，不计入评分'}
      </span>
    </div>
  );
}
