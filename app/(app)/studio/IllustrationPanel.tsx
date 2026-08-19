'use client';

import { useState, useTransition } from 'react';
import { COVER_SPEC_OPTIONS } from '@/lib/cover/specs';
import { actPlanIllustrationScenes, actRunIllustration } from './illustration-actions';

type Scene = { scene: string; anchor?: string };
type Img = { id?: string; url: string; scene: string; anchor?: string; aigcEmbedded: boolean };

// 正文配图 / 小红书组图。
//
// 流程刻意分两步：**先拆画面给你看，再出图**。
// 出图是真花钱的一步（按张计费），而拆出来的画面十有八九要改一两句——
// 一步到位的设计会让每次改词都重烧一遍钱。
export function IllustrationPanel({
  draftId,
  platform,
  styles,
  existing,
}: {
  draftId?: string;
  platform?: string;
  styles: { key: string; name: string; hint: string }[];
  existing: Img[];
}) {
  const [pending, start] = useTransition();
  const [count, setCount] = useState(3);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [styleKey, setStyleKey] = useState(styles[0]?.key ?? '');
  const [specKey, setSpecKey] = useState('');
  const [extra, setExtra] = useState('');
  const [images, setImages] = useState<Img[]>(existing);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  if (!draftId) {
    return <p className="small muted">先在左边选一篇草稿。</p>;
  }

  function plan() {
    setErr('');
    setMsg('');
    start(async () => {
      const r = await actPlanIllustrationScenes(draftId!, count);
      if (!r.ok || !r.scenes) {
        setErr(r.error ?? '拆画面失败');
        return;
      }
      setScenes(r.scenes);
      setMsg(`拆出 ${r.scenes.length} 张画面，检查/修改后再出图`);
    });
  }

  function generate() {
    setErr('');
    setMsg('');
    start(async () => {
      const r = await actRunIllustration({
        draftId: draftId!,
        scenes: scenes.filter((s) => s.scene.trim()),
        styleKey,
        specKey: specKey || undefined,
        extra,
      });
      if (!r.ok || !r.images) {
        setErr(r.error ?? '出图失败');
        return;
      }
      setImages([...r.images, ...images]);
      setMsg(`出了 ${r.images.length} 张`);
    });
  }

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div className="row wrap" style={{ gap: 8, alignItems: 'flex-end' }}>
        <label className="small" style={{ display: 'grid', gap: 4 }}>
          张数
          <input
            className="input"
            type="number"
            min={1}
            max={6}
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
            style={{ maxWidth: 90 }}
          />
        </label>
        <button className="btn btn-sm" disabled={pending} onClick={plan}>
          从正文拆画面
        </button>
        <button
          className="btn btn-sm btn-ghost"
          disabled={pending}
          onClick={() => setScenes([...scenes, { scene: '' }])}
        >
          + 自己加一张
        </button>
      </div>

      {scenes.length > 0 && (
        <div style={{ display: 'grid', gap: 8 }}>
          {scenes.map((s, i) => (
            <div key={i} className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
              <span className="badge badge-gray" style={{ marginTop: 6 }}>{i + 1}</span>
              <textarea
                className="textarea"
                rows={2}
                value={s.scene}
                placeholder="这张图画什么（只描述看得见的东西：主体、动作、环境、光线）"
                onChange={(e) => {
                  const next = [...scenes];
                  next[i] = { ...next[i], scene: e.target.value };
                  setScenes(next);
                }}
                style={{ flex: 1 }}
              />
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => setScenes(scenes.filter((_, idx) => idx !== i))}
                title="删掉这张"
              >
                ×
              </button>
            </div>
          ))}

          <div className="row wrap" style={{ gap: 8, alignItems: 'flex-end' }}>
            <label className="small" style={{ display: 'grid', gap: 4 }}>
              风格
              <select className="select" value={styleKey} onChange={(e) => setStyleKey(e.target.value)} style={{ maxWidth: 190 }}>
                {styles.map((s) => (
                  <option key={s.key} value={s.key} title={s.hint}>{s.name}</option>
                ))}
              </select>
            </label>
            <label className="small" style={{ display: 'grid', gap: 4 }}>
              比例
              <select className="select" value={specKey} onChange={(e) => setSpecKey(e.target.value)} style={{ maxWidth: 190 }}>
                <option value="">按平台自动（{platform ?? '未知'}）</option>
                {COVER_SPEC_OPTIONS.map((o) => (
                  <option key={o.key} value={o.key}>{o.label}</option>
                ))}
              </select>
            </label>
            <input
              className="input"
              placeholder="补充要求（可选）"
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
              style={{ maxWidth: 220 }}
            />
            <button
              className="btn btn-sm btn-primary"
              disabled={pending || scenes.every((s) => !s.scene.trim())}
              onClick={generate}
            >
              {pending ? '出图中…' : `生成 ${scenes.filter((s) => s.scene.trim()).length} 张`}
            </button>
          </div>
        </div>
      )}

      <p className="small muted" style={{ margin: 0 }}>
        配图一律<strong>不上字</strong>（中文上字是生图模型最不稳的部分，正文配图画错字整张就废了）——
        要文字排版请用「标题与封面」。每张出图都会写入 AI 生成标识。
      </p>

      {images.length > 0 && (
        <div className="grid grid-4" style={{ gap: 10 }}>
          {images.map((img, i) => (
            <figure key={img.id ?? i} style={{ margin: 0 }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.url} alt={img.scene.slice(0, 30)} style={{ width: '100%', borderRadius: 8, display: 'block' }} />
              <figcaption className="small muted" style={{ marginTop: 4 }}>
                {img.anchor || img.scene.slice(0, 40)}
                {!img.aigcEmbedded && <span className="badge badge-amber" style={{ marginLeft: 6 }}>标识未写入</span>}
              </figcaption>
            </figure>
          ))}
        </div>
      )}

      {(msg || err) && (
        <div className="small" style={{ color: err ? 'var(--red)' : 'var(--green)' }}>{err || msg}</div>
      )}
    </div>
  );
}
