'use client';

import { useMemo, useState } from 'react';
import { platformName, platformColor } from '@/lib/constants';
import { Empty } from './ui';

// 读者原声——把采到的评论逐条摆出来 + 告诉用户「大家反复在提什么」。
//
// 为什么逐条也要给，而不是只给聚合：聚合能回答「关心什么」，回答不了「他们是怎么说的」。
// 创作者要的往往是后者——一句原话里的用词、语气、卡住的地方，是任何统计都压缩掉的东西。
// 所以这里是「话题榜（找方向）+ 原文列表（看细节）」两段，不是二选一。
//
// ⚠️ 分类（在问/想要/认可/不满）是关键词命中的**粗判**，不是情感分析。文案上一律说
// 「大致分类」，绝不显示成「满意度 78%」这种像结论的数字——把启发式印成事实是这个
// 项目栽过的坑（缺席不许当成 0、mock 不许混进真推荐，都是同一件事的不同形状）。

export type VoiceComment = {
  id: string;
  text: string;
  /** comment | danmaku（B 站弹幕） */
  source?: string;
  kind: string;
  platform: string;
  workTitle: string | null;
  collectedAt: string;
};

export type VoiceTopic = { term: string; docs: number; samples: string[] };
export type VoiceKind = { kind: string; count: number; pct: number };

const KIND_LABEL: Record<string, string> = {
  question: '在问', demand: '想要', praise: '认可', complaint: '不满', other: '其它',
};
const KIND_CLASS: Record<string, string> = {
  question: 'badge-brand', demand: 'badge-amber', praise: 'badge-green',
  complaint: 'badge-red', other: 'badge-gray',
};

export function ReaderVoice({
  comments, topics, kinds, retentionDays, emptyHint,
}: {
  comments: VoiceComment[];
  topics: VoiceTopic[];
  kinds: VoiceKind[];
  retentionDays: number;
  emptyHint: string;
}) {
  const [kindFilter, setKindFilter] = useState<string>('all');
  const [openTopic, setOpenTopic] = useState<string | null>(null);
  const [q, setQ] = useState('');

  const shown = useMemo(() => {
    const kw = q.trim();
    return comments.filter((c) => {
      if (kindFilter !== 'all' && c.kind !== kindFilter) return false;
      // 点了话题词就按词过滤——话题榜和原文列表连起来才有用：
      // 「32 条提到价格」看完，下一个念头一定是「他们具体怎么说的」
      if (openTopic && !c.text.includes(openTopic)) return false;
      if (kw && !c.text.includes(kw)) return false;
      return true;
    });
  }, [comments, kindFilter, openTopic, q]);

  if (comments.length === 0) {
    return <Empty icon="💬" text={emptyHint} />;
  }

  return (
    <div>
      {/* ── 大家反复在提什么 ── */}
      {topics.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div className="small muted" style={{ marginBottom: 6 }}>
            反复被提到的词 · 数字是「有多少条评论提到」，点一下筛出这些评论
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {topics.map((t) => {
              const on = openTopic === t.term;
              return (
                <button
                  key={t.term}
                  type="button"
                  // ⚠️ 未选中态必须带 badge-gray，不能只写 `badge`：
                  // `.badge` 基类只管形状，**不带 color**，颜色全在 badge-* 修饰类里。
                  // 光秃秃的 .badge 用在 <button> 上会落到 UA 默认的 buttontext（黑），
                  // 浅色模式看着正常，暗色模式下就是深底黑字，完全读不出来。
                  className={`badge ${on ? 'badge-brand' : 'badge-gray'}`}
                  onClick={() => setOpenTopic(on ? null : t.term)}
                  style={{ cursor: 'pointer', border: '1px solid var(--border)' }}
                  title={t.samples.length ? `例：${t.samples[0]}` : undefined}
                >
                  {t.term} <span className="mono">{t.docs}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ── 大致分类占比 ── */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 10 }}>
        <button
          type="button"
          className={`btn btn-sm${kindFilter === 'all' ? ' btn-primary' : ''}`}
          onClick={() => setKindFilter('all')}
        >
          全部 {comments.length}
        </button>
        {kinds.map((k) => (
          <button
            key={k.kind}
            type="button"
            className={`btn btn-sm${kindFilter === k.kind ? ' btn-primary' : ''}`}
            onClick={() => setKindFilter(kindFilter === k.kind ? 'all' : k.kind)}
            title="按关键词粗分，仅供快速筛选，不是情感分析"
          >
            {KIND_LABEL[k.kind] ?? k.kind} {k.count}
            <span className="muted"> · {Math.round(k.pct * 100)}%</span>
          </button>
        ))}
        <input
          className="input"
          placeholder="在评论里搜…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ maxWidth: 180, marginLeft: 'auto' }}
        />
      </div>

      {(openTopic || q.trim() || kindFilter !== 'all') && (
        <div className="small muted" style={{ marginBottom: 8 }}>
          筛出 {shown.length} 条
          {openTopic && <> · 含「{openTopic}」</>}
          <button
            type="button"
            className="btn btn-sm"
            style={{ marginLeft: 8 }}
            onClick={() => { setOpenTopic(null); setQ(''); setKindFilter('all'); }}
          >
            清除筛选
          </button>
        </div>
      )}

      {/* ── 逐条原文 ── */}
      <div style={{ maxHeight: 460, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
        {shown.length === 0 ? (
          <div className="small muted" style={{ padding: 16, textAlign: 'center' }}>没有符合筛选条件的评论</div>
        ) : (
          shown.map((c) => (
            <div key={c.id} style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                <span className={`badge ${KIND_CLASS[c.kind] ?? 'badge-gray'}`} style={{ flexShrink: 0 }}>
                  {KIND_LABEL[c.kind] ?? '其它'}
                </span>
                {c.source === 'danmaku' && (
                  <span className="badge badge-blue" style={{ flexShrink: 0 }} title="来自 B 站公开弹幕文件，只取文字">弹幕</span>
                )}
                <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}>{c.text}</span>
              </div>
              <div className="small muted" style={{ marginTop: 3, paddingLeft: 2 }}>
                <span style={{ color: platformColor(c.platform) }}>{platformName(c.platform)}</span>
                {c.workTitle ? <> · {c.workTitle}</> : null}
              </div>
            </div>
          ))
        )}
      </div>

      {/* 留存与边界，就摆在数据下面。写在隐私政策里而页面上不说，等于没说。 */}
      <div className="small muted" style={{ marginTop: 8 }}>
        只有评论正文（B 站另含公开弹幕文字，标「弹幕」），不含昵称、头像、主页链接、用户 ID、IP 属地、评论时间与点赞数——这些插件根本没取。
        正文保留 {retentionDays} 天后自动删除，不参与任何 AI 生成，也不会被导出。
      </div>
    </div>
  );
}
