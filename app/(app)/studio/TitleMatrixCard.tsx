'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/components/icons';
import { CopyText } from '@/components/CopyText';
import { angleName } from '@/lib/studio/title';
import { useI18n } from '@/lib/i18n';
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

const ANGLE_NAMES_EN: Record<string, string> = {
  result: 'Result-First',
  suspense: 'Curiosity Gap',
  counter: 'Counter-Intuitive',
  identity: 'Identity Callout',
  listicle: 'Listicle',
  pain: 'Pain Point Question',
};

function getAngleName(key: string, lang: 'zh' | 'en') {
  if (lang === 'en') {
    return ANGLE_NAMES_EN[key] ?? angleName(key);
  }
  return angleName(key);
}

export function TitleMatrixCard({
  draftId,
  onUseAsCover,
}: {
  draftId?: string;
  /** 把某条标题 / 封面建议写进封面工位的「大字 / 副字」（由 TitleCoverPanel 提供） */
  onUseAsCover?: (mainTitle: string, subTitle?: string) => void;
}) {
  const { lang } = useI18n();
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
        // 采纳的标题 = 封面主文案：顺手填进封面工位，用户不用再复制一遍
        onUseAsCover?.(title);
        router.refresh();
      } else {
        setErr(r.error ?? (lang === 'en' ? 'Adoption failed' : '采纳失败'));
      }
    });
  }

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
        <button className="btn btn-sm btn-primary" onClick={run} disabled={pending || !draftId}>
          <Icon.sparkles size={14} /> {pending ? (lang === 'en' ? 'Generating…' : '生成中…') : (lang === 'en' ? 'Generate Title Matrix + Cover Ideas' : '生成标题矩阵 + 封面建议')}
        </button>
        {!draftId && <span className="small muted">{lang === 'en' ? 'Select a draft on the left first' : '先在左侧选中一份草稿'}</span>}
        {err && <span className="small" style={{ color: 'var(--red)' }}>{err}</span>}
      </div>

      {data && (
        <div className="stack" style={{ gap: 10 }}>
          <div className="row wrap" style={{ gap: 6 }}>
            {data.mocked && (
              <span className="badge badge-amber" title={lang === 'en' ? 'Mock output: real AI model not configured' : '尚未接入真实模型，这是演示产出'}>
                {lang === 'en' ? 'Demo Output (Mock AI)' : '演示结果（未接入真实 AI）'}
              </span>
            )}
            {data.dropped > 0 && (
              <span className="badge badge-red" title={lang === 'en' ? 'Titles violating compliance redlines were dropped, hidden and uncopyable' : '命中合规红线的标题已被丢弃，不展示也不可复制'}>
                {lang === 'en' ? `Blocked ${data.dropped} redline-violating titles` : `已拦下 ${data.dropped} 条命中红线的标题`}
              </span>
            )}
          </div>

          {data.titles.map((t, i) => (
            <div key={i} className="card" style={{ padding: 12, boxShadow: 'none', background: 'var(--surface-2)' }}>
              <div className="row-between" style={{ gap: 8, alignItems: 'flex-start' }}>
                <div style={{ flex: 1 }}>
                  <div className="row wrap" style={{ gap: 6, alignItems: 'center', marginBottom: 4 }}>
                    <span className="badge badge-brand" style={{ fontSize: 11 }}>{getAngleName(t.angle, lang)}</span>
                    <span className="badge badge-gray" style={{ fontSize: 11, color: sevColor(t.diagnosis.severity) }}>
                      {t.diagnosis.chars} {lang === 'en' ? 'chars' : '字'}
                    </span>
                  </div>
                  <b className="small" style={{ fontSize: 14, lineHeight: 1.5 }}>{t.title}</b>
                  {t.why && <div className="small muted" style={{ marginTop: 4, lineHeight: 1.6 }}>{lang === 'en' ? 'Angle rationale: ' : '赌的是：'}{t.why}</div>}
                  <div className="small muted" style={{ marginTop: 4, lineHeight: 1.6, color: sevColor(t.diagnosis.severity) }}>
                    {t.diagnosis.notes.join('；')}
                  </div>
                </div>
                <div className="row wrap" style={{ gap: 6, flexShrink: 0, justifyContent: 'flex-end' }}>
                  <CopyText text={t.title} label={lang === 'en' ? 'Copy' : '复制'} />
                  {onUseAsCover && (
                    <button
                      className="btn btn-sm btn-ghost"
                      onClick={() => onUseAsCover(t.title)}
                      title={lang === 'en' ? 'Fill this into cover headline above without changing draft title' : '只把这条填进上面的封面大字框，不改草稿标题'}
                    >
                      {lang === 'en' ? 'Use as Cover' : '作封面大字'}
                    </button>
                  )}
                  <button
                    className="btn btn-sm btn-accent"
                    onClick={() => adopt(t.title)}
                    disabled={pending || t.diagnosis.severity === 'bad'}
                    title={t.diagnosis.severity === 'bad' ? (lang === 'en' ? 'Has hard issues (exceeds limit, etc.); revise before using' : '这条有硬问题（超上限等），改完再用') : (lang === 'en' ? 'Change draft title to this' : '把草稿标题换成这条')}
                  >
                    {lang === 'en' ? 'Use This' : '用这条'}
                  </button>
                </div>
              </div>
            </div>
          ))}

          {adopted && (
            <div className="small" style={{ color: 'var(--green)' }}>
              {lang === 'en' ? `Draft title updated to "${adopted}"` : `已把草稿标题改为「${adopted}」`}
            </div>
          )}

          {data.cover && (
            <div className="card" style={{ padding: 12, boxShadow: 'none', background: 'var(--surface-2)' }}>
              <b className="small" style={{ display: 'block', marginBottom: 6 }}>{lang === 'en' ? 'Cover Suggestions' : '封面建议'}</b>
              <div className="small" style={{ lineHeight: 1.7 }}>
                <div><span className="muted">{lang === 'en' ? 'Headline: ' : '主文案：'}</span><b>{data.cover.headline}</b></div>
                {data.cover.sub && <div><span className="muted">{lang === 'en' ? 'Subtitle: ' : '副文案：'}</span>{data.cover.sub}</div>}
                <div><span className="muted">{lang === 'en' ? 'Visual: ' : '画面：'}</span>{data.cover.visual}</div>
                {data.cover.note && <div className="muted" style={{ marginTop: 4 }}>{lang === 'en' ? 'Rationale: ' : '为什么这么做：'}{data.cover.note}</div>}
              </div>
              <div className="row wrap" style={{ gap: 6, marginTop: 8 }}>
                {onUseAsCover && (
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={() => onUseAsCover(data.cover!.headline, data.cover!.sub)}
                    title={lang === 'en' ? 'Fill headline/subtitle into cover workstation above to generate image' : '把主文案 / 副文案填进上面的封面工位，直接出图'}
                  >
                    {lang === 'en' ? 'Use as Cover Copy ↑' : '用作封面文案 ↑'}
                  </button>
                )}
                <CopyText
                  text={[data.cover.headline, data.cover.sub, data.cover.visual].filter(Boolean).join('\n')}
                  label={lang === 'en' ? 'Copy Cover Text' : '复制封面文案'}
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
