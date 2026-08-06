'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/components/icons';
import { CopyText } from '@/components/CopyText';
import { angleName } from '@/lib/studio/title';
import { actTitleMatrix, actAdoptTitle, type TitleMatrixResult } from './actions';

// 标题矩阵 + 封面建议的出口。
// 一次给一组**角度互不相同**的标题，用户是在「选」而不是在「审」——
// 让模型自由发挥 6 个标题，得到的多半是同一个角度的 6 种措辞。

type Ok = Extract<TitleMatrixResult, { ok: true }>;

function sevColor(sev: string): string {
  if (sev === 'bad') return 'var(--red)';
  if (sev === 'warn') return 'var(--amber)';
  return 'var(--green)';
}

export function TitleMatrixCard({ draftId }: { draftId?: string }) {
  const [data, setData] = useState<Ok | null>(null);
  const [err, setErr] = useState('');
  const [adopted, setAdopted] = useState('');
  const [pending, start] = useTransition();
  const router = useRouter();

  function run() {
    if (!draftId) return;
    setErr('');
    setAdopted('');
    start(async () => {
      const r = await actTitleMatrix(draftId);
      if (!r.ok) {
        setErr(r.error);
        setData(null);
        return;
      }
      setData(r);
    });
  }

  function adopt(title: string) {
    if (!draftId) return;
    start(async () => {
      const r = await actAdoptTitle(draftId, title);
      if (r.ok) {
        setAdopted(title);
        router.refresh();
      } else {
        setErr(r.error ?? '采纳失败');
      }
    });
  }

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
        <button className="btn btn-sm btn-primary" onClick={run} disabled={pending || !draftId}>
          <Icon.sparkles size={14} /> {pending ? '生成中…' : '生成标题矩阵 + 封面建议'}
        </button>
        {!draftId && <span className="small muted">先在左侧选中一份草稿</span>}
        {err && <span className="small" style={{ color: 'var(--red)' }}>{err}</span>}
      </div>

      {data && (
        <div className="stack" style={{ gap: 10 }}>
          <div className="row wrap" style={{ gap: 6 }}>
            {data.mocked && (
              <span className="badge badge-amber" title="尚未接入真实模型，这是演示产出">演示结果（未接入真实 AI）</span>
            )}
            {data.dropped > 0 && (
              <span className="badge badge-red" title="命中合规红线的标题已被丢弃，不展示也不可复制">
                已拦下 {data.dropped} 条命中红线的标题
              </span>
            )}
          </div>

          {data.titles.map((t, i) => (
            <div key={i} className="card" style={{ padding: 12, boxShadow: 'none', background: 'var(--surface-2)' }}>
              <div className="row-between" style={{ gap: 8, alignItems: 'flex-start' }}>
                <div style={{ flex: 1 }}>
                  <div className="row wrap" style={{ gap: 6, alignItems: 'center', marginBottom: 4 }}>
                    <span className="badge badge-brand" style={{ fontSize: 11 }}>{angleName(t.angle)}</span>
                    <span className="badge badge-gray" style={{ fontSize: 11, color: sevColor(t.diagnosis.severity) }}>
                      {t.diagnosis.chars} 字
                    </span>
                  </div>
                  <b className="small" style={{ fontSize: 14, lineHeight: 1.5 }}>{t.title}</b>
                  {t.why && <div className="small muted" style={{ marginTop: 4, lineHeight: 1.6 }}>赌的是：{t.why}</div>}
                  <div className="small muted" style={{ marginTop: 4, lineHeight: 1.6, color: sevColor(t.diagnosis.severity) }}>
                    {t.diagnosis.notes.join('；')}
                  </div>
                </div>
                <div className="row" style={{ gap: 6, flexShrink: 0 }}>
                  <CopyText text={t.title} label="复制" />
                  <button
                    className="btn btn-sm btn-accent"
                    onClick={() => adopt(t.title)}
                    disabled={pending || t.diagnosis.severity === 'bad'}
                    title={t.diagnosis.severity === 'bad' ? '这条有硬问题（超上限等），改完再用' : '把草稿标题换成这条'}
                  >
                    用这条
                  </button>
                </div>
              </div>
            </div>
          ))}

          {adopted && <div className="small" style={{ color: 'var(--green)' }}>已把草稿标题改为「{adopted}」</div>}

          {data.cover && (
            <div className="card" style={{ padding: 12, boxShadow: 'none', background: 'var(--surface-2)' }}>
              <b className="small" style={{ display: 'block', marginBottom: 6 }}>封面建议</b>
              <div className="small" style={{ lineHeight: 1.7 }}>
                <div><span className="muted">主文案：</span><b>{data.cover.headline}</b></div>
                {data.cover.sub && <div><span className="muted">副文案：</span>{data.cover.sub}</div>}
                <div><span className="muted">画面：</span>{data.cover.visual}</div>
                {data.cover.note && <div className="muted" style={{ marginTop: 4 }}>为什么这么做：{data.cover.note}</div>}
              </div>
              <div className="row" style={{ gap: 6, marginTop: 8 }}>
                <CopyText
                  text={[data.cover.headline, data.cover.sub, data.cover.visual].filter(Boolean).join('\n')}
                  label="复制封面文案"
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
