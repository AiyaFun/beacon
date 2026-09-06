'use client';

import { useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { Icon } from '@/components/icons';
import { Card } from '@/components/ui';
import { PortraitConsentTextForLibrary } from '@/components/PortraitConsent';
import { prepareReferenceImage, downloadImage } from '@/lib/cover/client-image';
// 张数上限从 lib/cover/rules 取，**不从 lib/illustration/run 取**：那个模块会拉起
// llmImage → 队列 → ioredis，把 dns 这类 node 内置模块打进客户端包，dev 下直接 500
//（Module not found: Can't resolve 'dns'）。rules 是刻意保持 client-safe 的纯常量。
import { MAX_SUBJECT_IMAGES, MAX_COVER_IMAGES as MAX_ILLUSTRATIONS } from '@/lib/cover/rules';
import {
  actRunFreeImages,
  actListGenerated,
  actPinGenerated,
  actDeleteGenerated,
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
  const [scenes, setScenes] = useState('');
  const [styleKey, setStyleKey] = useState(styles[0]?.key ?? '');
  const [specKey, setSpecKey] = useState(specs[0]?.key ?? '');
  const [extra, setExtra] = useState('');
  const [refs, setRefs] = useState<string[]>([]);
  const [images, setImages] = useState<{ id?: string; url: string; scene: string; aigcEmbedded: boolean }[]>([]);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

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
    <>
      <Card
        title={isEn ? 'Generate Images' : '出图'}
        sub={isEn ? `One scene per line, max ${MAX_ILLUSTRATIONS} per batch · No overlaid text here (use "Title & Cover" in Studio for text)` : `一行一句画面，一次最多 ${MAX_ILLUSTRATIONS} 张 · 这里出的图一律不上字（要上字用创作工坊的「标题与封面」）`}
      >
        {!quota.configured ? (
          <div className="alert-gradient-amber small" style={{ padding: '12px 16px', borderRadius: 8, lineHeight: 1.7 }}>
            {isEn ? 'No image generation channel configured yet. Go to ' : '还没有可用的生图渠道。到 '}
            <Link href="/settings/keys">{isEn ? 'Integrations & Keys' : '接入与密钥'}</Link>
            {isEn ? ' to add a "Volcengine Doubao" channel. ' : ' 加一个「火山引擎 豆包」渠道。'}
            <b>{isEn ? 'Image generation only supports Volcengine Ark' : '生图只认火山方舟'}</b>：
            {isEn ? 'Visible watermarks rely on Jimeng’s watermark parameter.' : '显式水印靠即梦的 watermark 参数，别家没有这个开关。'}
          </div>
        ) : (
          <>
            <textarea
              className="input"
              rows={4}
              placeholder={isEn ? 'One scene per line, for example:\nMorning wooden desk, steaming cup of coffee, side backlight\nCity rooftop overlooking traffic flow, blue hour' : '一行一张，例如：\n清晨的书桌，一杯冒热气的咖啡，侧逆光\n城市天台俯瞰车流，蓝调时刻'}
              value={scenes}
              onChange={(e) => setScenes(e.target.value)}
              style={{ width: '100%', lineHeight: 1.7 }}
              disabled={!canWrite}
            />
            <div className="row wrap" style={{ gap: 10, marginTop: 10, alignItems: 'center' }}>
              <label className="small muted">
                {isEn ? 'Style' : '风格'}
                <select
                  className="input"
                  value={styleKey}
                  onChange={(e) => setStyleKey(e.target.value)}
                  style={{ marginLeft: 6 }}
                >
                  {styles.map((s) => (
                    <option key={s.key} value={s.key} title={s.hint}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="small muted">
                {isEn ? 'Ratio' : '比例'}
                <select
                  className="input"
                  value={specKey}
                  onChange={(e) => setSpecKey(e.target.value)}
                  style={{ marginLeft: 6 }}
                >
                  {specs.map((s) => (
                    <option key={s.key} value={s.key} title={s.hint}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
              <input
                className="input"
                placeholder={isEn ? 'Additional requirements (optional)' : '补充要求（可选）'}
                value={extra}
                onChange={(e) => setExtra(e.target.value)}
                style={{ flex: 1, minWidth: 180 }}
              />
            </div>

            {assets.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div className="small muted" style={{ marginBottom: 6 }}>
                  {isEn ? `Reference images (maintain character / product consistency, max ${MAX_SUBJECT_IMAGES} in prompt)` : `参考图（保持人物 / 产品跨图一致，最多 ${MAX_SUBJECT_IMAGES} 张进提示词）`}
                </div>
                <div className="row wrap" style={{ gap: 8 }}>
                  {assets.map((a) => {
                    const on = refs.includes(a.id);
                    return (
                      <button
                        key={a.id}
                        className={`btn btn-sm ${on ? 'btn-primary' : ''}`}
                        onClick={() => setRefs(on ? refs.filter((x) => x !== a.id) : [...refs, a.id])}
                        style={{ padding: 4 }}
                        title={a.label ?? a.kind}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={a.url} alt="" style={{ width: 36, height: 36, objectFit: 'cover', borderRadius: 4 }} />
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="row wrap" style={{ gap: 10, marginTop: 14, alignItems: 'center' }}>
              <button
                className="btn btn-primary"
                disabled={pending || lines.length === 0 || tooMany || !canWrite}
                onClick={generate}
              >
                {pending ? (isEn ? 'Generating…' : '出图中…') : (isEn ? `Generate ${Math.min(lines.length, MAX_ILLUSTRATIONS) || ''} Images` : `出 ${Math.min(lines.length, MAX_ILLUSTRATIONS) || ''} 张图`)}
              </button>
              <span className="small muted">
                {isEn ? `Remaining today: ${quota.remaining}/${quota.cap} images` : `今日还能出 ${quota.remaining}/${quota.cap} 张`}
                {quota.source === 'byok' ? (isEn ? ' (using your custom Key)' : '（走你自己的 Key）') : quota.source === 'platform' ? (isEn ? ' (using platform quota)' : '（走平台额度）') : ''}
              </span>
              {tooMany && <span className="small" style={{ color: 'var(--red)' }}>{isEn ? `Max ${MAX_ILLUSTRATIONS} lines per batch` : `一次最多 ${MAX_ILLUSTRATIONS} 行`}</span>}
            </div>
          </>
        )}

        {(err || msg) && (
          <div className="small" style={{ marginTop: 10, color: err ? 'var(--red)' : 'var(--green)' }}>
            {err || msg}
          </div>
        )}

        {images.length > 0 && (
          <div className="row wrap" style={{ gap: 12, marginTop: 14 }}>
            {images.map((im, i) => (
              <div key={im.id ?? i} className="card" style={{ padding: 8, width: 200 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={im.url} alt={im.scene} style={{ width: '100%', borderRadius: 6, display: 'block' }} />
                <div className="small muted" style={{ marginTop: 6, lineHeight: 1.5 }}>
                  {im.scene.slice(0, 40)}
                </div>
                <div className="row" style={{ gap: 6, marginTop: 6 }}>
                  <button
                    className="btn btn-sm"
                    onClick={() => void downloadImage(im.url, `beacon-img-${i + 1}.png`)}
                  >
                    {isEn ? 'Download' : '下载'}
                  </button>
                  {!im.aigcEmbedded && (
                    <span className="badge badge-amber" title={isEn ? 'AI generation mark could not be embedded in this image. Do not use where disclosure is required.' : '这张图没能写进 AI 生成标识，请勿用于需要标识的场合'}>
                      {isEn ? 'Unmarked' : '未写入标识'}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card
        title={isEn ? 'My Likeness & Assets' : '我的形象与素材'}
        sub={isEn ? 'Save once, select directly for future generations · Likeness encrypted, deletable anytime' : '存一次，之后每次出图直接勾 · 人像加密保存，随时可删'}
        style={{ marginTop: 16 }}
      >
        <div className="row wrap" style={{ gap: 10, alignItems: 'center' }}>
          <label className="small muted">
            {isEn ? 'Type' : '类型'}
            <select
              className="input"
              value={uploadKind}
              onChange={(e) => setUploadKind(e.target.value as 'portrait' | 'background' | 'brand')}
              style={{ marginLeft: 6 }}
            >
              <option value="background">{isEn ? 'Background / Scenery' : '背景 / 空镜'}</option>
              <option value="portrait">{isEn ? 'Likeness / Subject' : '人像 / 主体'}</option>
              <option value="brand">{isEn ? 'Brand Elements' : '品牌元素'}</option>
            </select>
          </label>
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
            className="btn btn-sm"
            onClick={() => fileRef.current?.click()}
            disabled={pending || !canWrite || (uploadKind === 'portrait' && !consent)}
            title={uploadKind === 'portrait' && !consent ? (isEn ? 'Please check the consent box below before uploading likeness' : '上传人像前请先勾选下面的同意确认') : undefined}
          >
            <Icon.upload size={13} /> {isEn ? 'Upload' : '上传'}
          </button>
        </div>

        {/* 人像 = 敏感个人信息，单独同意的那段字与封面工位共用一份 */}
        {uploadKind === 'portrait' && (
          <label
            className="small"
            style={{ display: 'flex', gap: 8, alignItems: 'flex-start', lineHeight: 1.6, marginTop: 10, color: 'var(--text-2)' }}
          >
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} style={{ marginTop: 3 }} />
            <PortraitConsentTextForLibrary />
          </label>
        )}

        {assets.length === 0 ? (
          <p className="small muted" style={{ marginTop: 10 }}>{isEn ? 'No assets yet.' : '还没有素材。'}</p>
        ) : (
          <div className="row wrap" style={{ gap: 10, marginTop: 12 }}>
            {assets.map((a) => (
              <span key={a.id} style={{ position: 'relative', display: 'inline-block' }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={a.url} alt="" style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 6 }} />
                <button
                  className="btn btn-sm btn-ghost"
                  style={{ position: 'absolute', top: -6, right: -6, padding: '0 6px' }}
                  disabled={pending || !canWrite}
                  onClick={() =>
                    start(async () => {
                      const r = await actDeleteAsset(a.id);
                      if (r.ok) setAssets(r.assets.map((x) => ({ id: x.id, url: x.url, kind: x.kind, label: x.label })));
                    })
                  }
                  title={isEn ? 'Delete' : '删除'}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </Card>

      <Card
        title={isEn ? 'Recent Generations' : '最近生成'}
        sub={isEn ? `Covers and illustrations both appear here · Unpinned items auto-purged after ${retentionDays} days (pinned items kept)` : `封面与配图都在这里 · 未钉住的 ${retentionDays} 天后自动清理（钉住的不清）`}
        style={{ marginTop: 16 }}
      >
        {items.length === 0 ? (
          <p className="small muted">{isEn ? 'No images generated yet.' : '还没有生成过图。'}</p>
        ) : (
          <div className="row wrap" style={{ gap: 12 }}>
            {items.map((g) => (
              <div key={g.id} className="card" style={{ padding: 8, width: 170 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={g.url} alt={g.scene} style={{ width: '100%', borderRadius: 6, display: 'block' }} />
                <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                  <span className="badge badge-gray">{g.kind === 'cover' ? (isEn ? 'Cover' : '封面') : (isEn ? 'Illustration' : '配图')}</span>
                  {g.pinned && <span className="badge badge-green">{isEn ? 'Pinned' : '已钉住'}</span>}
                </div>
                <div className="row" style={{ gap: 6, marginTop: 6 }}>
                  <button
                    className="btn btn-sm"
                    disabled={pending || !canWrite}
                    onClick={() =>
                      start(async () => {
                        const r = await actPinGenerated(g.id, !g.pinned);
                        if (r.ok) setItems(items.map((x) => (x.id === g.id ? { ...x, pinned: !g.pinned } : x)));
                        else setErr(r.error ?? '');
                      })
                    }
                  >
                    {g.pinned ? (isEn ? 'Unpin' : '取消钉住') : (isEn ? 'Pin' : '钉住')}
                  </button>
                  <button className="btn btn-sm" onClick={() => void downloadImage(g.url, `beacon-${g.id}.png`)}>
                    {isEn ? 'Download' : '下载'}
                  </button>
                  <button
                    className="btn btn-sm btn-ghost"
                    disabled={pending || !canWrite}
                    onClick={() =>
                      start(async () => {
                        const r = await actDeleteGenerated(g.id);
                        if (r.ok) setItems(items.filter((x) => x.id !== g.id));
                        else setErr(r.error ?? '');
                      })
                    }
                  >
                    {isEn ? 'Delete' : '删除'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
