'use client';

import { useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { Icon } from '@/components/icons';
import { PortraitConsentTextForLibrary } from '@/components/PortraitConsent';
import { prepareReferenceImage, downloadImage } from '@/lib/cover/client-image';
// 张数上限从 lib/cover/rules 取，**不从 lib/illustration/run 取**：那个模块会拉起
// llmImage → 队列 → ioredis，把 dns 这类 node 内置模块打进客户端包，dev 下直接 500
//（Module not found: Can't resolve 'dns'）。rules 是刻意保持 client-safe 的纯常量。
import { MAX_COVER_IMAGES as MAX_ILLUSTRATIONS } from '@/lib/cover/rules';
import {
  actRunFreeImages,
  actListGenerated,
  type GalleryItem,
} from './actions';
import { actSaveLibraryAsset, actDeleteAsset } from '../studio/cover-actions';
import { useI18n } from '@/lib/i18n';

export type LibraryAsset = { id: string; url: string; kind: string; label: string | null };
export type Option = { key: string; label: string; hint?: string };

// 出图工位。三块：出图 / 我的形象与素材 / 最近生成。
//
// 【为什么整块是客户端组件】出图是「写几句 → 出图 → 看结果 → 再调一句再出」的循环。
// 结果如果靠服务端重渲来显示，每次 revalidate 都会把刚填的画面描述和上一批结果冲掉
//（本项目记过的 server action 重渲坑）。所以草稿态与结果都留在客户端，
// 只有钉住/删除这类改库的动作走 action 并 revalidate。

export function ImageStudio({
  styles,
  specs,
  library,
  gallery,
  quota,
  retentionDays,
  canWrite,
}: {
  styles: Option[];
  specs: Option[];
  library: LibraryAsset[];
  gallery: GalleryItem[];
  quota: { configured: boolean; remaining: number; cap: number; source: 'platform' | 'byok' | null };
  retentionDays: number;
  canWrite: boolean;
}) {
  const { lang } = useI18n();
  const isEn = lang === 'en';
  const [pending, start] = useTransition();
  const [scenes, setScenes] = useState(
    '一位年轻职场人在会议室表达不同意见，真实办公环境，自然光。'
  );
  const [styleKey, setStyleKey] = useState(styles[0]?.key ?? '');
  const [specKey, setSpecKey] = useState(specs[0]?.key ?? '');
  const [extra, setExtra] = useState('');
  const [refs, setRefs] = useState<string[]>([]);
  const [images, setImages] = useState<{ id?: string; url: string; scene: string; aigcEmbedded: boolean }[]>([]);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [showAll, setShowAll] = useState(false);

  const [assets, setAssets] = useState(library);
  const [items, setItems] = useState(gallery);
  const [consent, setConsent] = useState(false);
  const [uploadKind, setUploadKind] = useState<'portrait' | 'background' | 'brand'>('background');
  const fileRef = useRef<HTMLInputElement>(null);

  const lines = scenes
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const tooMany = lines.length > MAX_ILLUSTRATIONS;

  function generate() {
    setErr('');
    setMsg('');
    start(async () => {
      const r = await actRunFreeImages({
        scenes: lines,
        styleKey,
        specKey,
        extra,
        referenceAssetIds: refs,
      });
      if (!r.ok) {
        setErr(r.error ?? (isEn ? 'Image generation failed' : '出图失败'));
        return;
      }
      setImages(r.images ?? []);
      setMsg(isEn ? `Generated ${r.images?.length ?? 0} images. Saved to "Recent Generations".` : `出了 ${r.images?.length ?? 0} 张。都已存进「最近生成」。`);
      // 新图要出现在下面的画廊里；不重取的话用户以为没存下来
      setItems(await actListGenerated());
    });
  }

  async function upload(file: File) {
    setErr('');
    setMsg('');
    try {
      const prepared = await prepareReferenceImage(file);
      start(async () => {
        const r = await actSaveLibraryAsset(prepared.dataUrl, uploadKind, { consented: consent });
        if (!r.ok) {
          setErr(r.error);
          return;
        }
        setAssets(r.assets.map((a) => ({ id: a.id, url: a.url, kind: a.kind, label: a.label })));
        setMsg(isEn ? 'Saved to "My Likeness & Assets".' : '已存进「我的形象与素材」。');
      });
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <div className="image-studio">
      {/* ── 1. 左栏：生成设置 ── */}
      <aside className="surface image-config">
        <div style={{ marginBottom: 4 }}>
          <strong style={{ fontSize: 15, fontWeight: 650 }}>{isEn ? 'Generation Settings' : '生成设置'}</strong>
          <p className="small muted" style={{ margin: '3px 0 0' }}>
            {isEn ? 'Set purpose first, then choose ratio and style.' : '先确定用途，再决定比例和风格。'}
          </p>
        </div>

        {!quota.configured && (
          <div style={{ padding: '9px 12px', background: 'var(--amber-soft)', borderRadius: 8, fontSize: 12, color: 'var(--amber)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>⚠️</span>
            <span>
              {isEn ? 'Image channel not configured' : '尚未配置生图渠道'}
              {' · '}
              <Link href="/settings/keys" style={{ textDecoration: 'underline', fontWeight: 600 }}>
                {isEn ? 'Configure' : '去配置'}
              </Link>
            </span>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div className="field">
            <label>{isEn ? 'Purpose' : '用途'}</label>
            <select
              className="select input"
              value={uploadKind === 'portrait' ? 'illustration' : 'cover'}
              onChange={() => {}}
            >
              <option value="cover">{isEn ? 'Cover' : '文章封面'}</option>
              <option value="illustration">{isEn ? 'Illustration' : '正文配图'}</option>
              <option value="card">{isEn ? 'Card' : '社交图卡'}</option>
            </select>
          </div>

          <div className="field">
            <label>{isEn ? 'Platform' : '平台'}</label>
            <select className="select input" value={specKey} onChange={(e) => setSpecKey(e.target.value)}>
              {specs.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="field">
          <label>{isEn ? 'Scene Description' : '画面描述'}</label>
          <textarea
            className="input"
            rows={3}
            placeholder={isEn ? 'Describe scene...' : '描述你想要的画面，越具体越好…'}
            value={scenes}
            onChange={(e) => setScenes(e.target.value)}
            style={{ resize: 'none', lineHeight: 1.6 }}
            disabled={!canWrite}
          />
        </div>

        <div className="field" style={{ marginBottom: 10 }}>
          <label>{isEn ? 'Visual Style' : '视觉风格'}</label>
          <div className="chips">
            {styles.slice(0, 6).map((st) => (
              <button
                key={st.key}
                type="button"
                className={`filter-btn ${styleKey === st.key ? 'active' : ''}`}
                onClick={() => setStyleKey(st.key)}
              >
                {st.label}
              </button>
            ))}
          </div>
        </div>

        <button
          className="btn primary"
          disabled={pending || !scenes.trim() || tooMany || !canWrite}
          onClick={generate}
          style={{ width: '100%' }}
        >
          {pending
            ? (isEn ? 'Generating…' : '正在生成…')
            : (isEn ? `Generate ${lines.length > 1 ? lines.length : 4} Images` : `生成 ${lines.length > 1 ? lines.length : 4} 张图`)}
        </button>

        {/* 形象与参考图展开抽屉 */}
        <details className="accordion" style={{ marginTop: 4, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
          <summary style={{ cursor: 'pointer', fontSize: 11.5, color: 'var(--text-2)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>{isEn ? 'Reference Likeness & Upload' : '参考图与我的形象'}</span>
            <span className="meta">{assets.length}</span>
          </summary>
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <select
                className="input small"
                value={uploadKind}
                onChange={(e) => setUploadKind(e.target.value as any)}
                style={{ flex: 1 }}
              >
                <option value="background">{isEn ? 'Background' : '背景 / 空镜'}</option>
                <option value="portrait">{isEn ? 'Likeness' : '人像 / 主体'}</option>
                <option value="brand">{isEn ? 'Brand' : '品牌元素'}</option>
              </select>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void upload(f);
                  e.target.value = '';
                }}
              />
              <button
                className="btn small"
                onClick={() => fileRef.current?.click()}
                disabled={pending || !canWrite || (uploadKind === 'portrait' && !consent)}
                title={uploadKind === 'portrait' && !consent ? (isEn ? 'Please check consent below' : '上传人像前请先勾选下面的同意确认') : undefined}
              >
                <Icon.upload size={13} /> {isEn ? 'Upload' : '上传'}
              </button>
            </div>

            {uploadKind === 'portrait' && (
              <label className="small" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', lineHeight: 1.5, color: 'var(--text-2)' }}>
                <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} style={{ marginTop: 3 }} />
                <PortraitConsentTextForLibrary />
              </label>
            )}

            {assets.length > 0 && (
              <div className="row wrap" style={{ gap: 6 }}>
                {assets.map((a) => {
                  const on = refs.includes(a.id);
                  return (
                    <span key={a.id} style={{ position: 'relative', display: 'inline-block' }}>
                      <img
                        src={a.url}
                        alt=""
                        onClick={() => setRefs(on ? refs.filter((x) => x !== a.id) : [...refs, a.id])}
                        style={{
                          width: 38,
                          height: 38,
                          objectFit: 'cover',
                          borderRadius: 6,
                          cursor: 'pointer',
                          border: on ? '2px solid var(--brand)' : '1px solid var(--border)',
                        }}
                      />
                      <button
                        className="btn btn-sm btn-ghost"
                        style={{ position: 'absolute', top: -5, right: -5, padding: '0 4px', fontSize: 10, background: 'var(--surface)', borderRadius: '50%' }}
                        disabled={pending || !canWrite}
                        onClick={() =>
                          start(async () => {
                            const r = await actDeleteAsset(a.id);
                            if (r.ok) setAssets(r.assets.map((x) => ({ id: x.id, url: x.url, kind: x.kind, label: x.label })));
                          })
                        }
                      >
                        ×
                      </button>
                    </span>
                  );
                })}
              </div>
            )}
          </div>
        </details>

        {(err || msg) && (
          <div className="small" style={{ color: err ? 'var(--red)' : 'var(--green)', marginTop: 4 }}>
            {err || msg}
          </div>
        )}
      </aside>

      {/* ── 2. 中栏：画布与结果 ── */}
      <section className="surface image-canvas">
        {images.length === 0 ? (
          <div className="image-placeholder">
            <div>
              <strong>{isEn ? 'Generation results will appear here' : '生成结果将在这里出现'}</strong>
              <p className="small" style={{ margin: '8px 0 16px', color: 'var(--text-3)' }}>
                {isEn ? 'Sample preview does not call live model' : '示例预览不调用真实图片模型'}
              </p>
              <button
                className="btn small primary"
                disabled={pending || !scenes.trim() || !canWrite}
                onClick={generate}
              >
                {isEn ? 'Generate with Current Settings' : '使用当前设置生成'}
              </button>
            </div>
          </div>
        ) : (
          <div style={{ width: '100%', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14, alignSelf: 'start' }}>
            {images.map((im, i) => (
              <div key={im.id ?? i} className="media-card" style={{ padding: 10, background: 'var(--surface)' }}>
                <img src={im.url} alt={im.scene} style={{ width: '100%', borderRadius: 8, objectFit: 'cover' }} />
                <div className="small muted" style={{ marginTop: 6, lineHeight: 1.5, maxHeight: 40, overflow: 'hidden' }}>
                  {im.scene}
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center' }}>
                  <button className="btn small" onClick={() => void downloadImage(im.url, `beacon-img-${i + 1}.png`)}>
                    {isEn ? 'Download' : '下载'}
                  </button>
                  {!im.aigcEmbedded && (
                    <span className="badge badge-amber" style={{ fontSize: 11 }}>
                      {isEn ? 'Unmarked' : '未写入标识'}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── 3. 右栏：最近生成 ── */}
      <aside className="surface image-history">
        <strong>{isEn ? 'Recent Generations' : '最近生成'}</strong>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto', flex: 1 }}>
          {items.length === 0 ? (
            <div className="small muted" style={{ padding: '24px 0', textAlign: 'center' }}>
              {isEn ? 'No recent images' : '暂无生成记录'}
            </div>
          ) : (
            items.slice(0, showAll ? items.length : 6).map((g) => (
              <div key={g.id} className="media-card" style={{ minHeight: 88, cursor: 'pointer' }} onClick={() => setImages([{ url: g.url, scene: g.scene, aigcEmbedded: true }])}>
                <span className={`tag ${g.draftId ? 'green' : ''}`}>
                  {g.draftId ? (isEn ? 'Used in Draft' : '已用于草稿') : (isEn ? 'Unused' : '未使用')}
                </span>
                <strong style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {g.label || (g.scene ? g.scene.slice(0, 16) : (isEn ? 'Image' : '效率工具图卡'))}
                </strong>
                <span className="meta">
                  {g.kind === 'cover' ? (isEn ? 'Cover · 3:4' : '小红书 3:4') : (isEn ? 'Illustration' : '公众号横图')}
                </span>
              </div>
            ))
          )}
        </div>
        <button
          className="btn"
          style={{ marginTop: 'auto' }}
          onClick={() => setShowAll((prev) => !prev)}
        >
          {showAll ? (isEn ? 'Show Less' : '收起') : (isEn ? 'View All' : '查看全部')}
        </button>
      </aside>
    </div>
  );
}
