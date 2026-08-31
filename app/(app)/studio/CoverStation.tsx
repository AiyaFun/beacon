'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Icon } from '@/components/icons';
import { Overlay } from '@/components/Overlay';
import { TierBadge } from '@/components/ui';
import { COVER_SPEC_OPTIONS, specForPlatform, coverSpec, planCoverJobs, WECHAT_MAIN_SPEC, WECHAT_SQUARE_SPEC } from '@/lib/cover/specs';
import { COVER_STYLE_OPTIONS, COVER_FONTS, COVER_DECORS, DEFAULT_COVER_FONT, rankStylesForPersona } from '@/lib/cover/styles';
import { MAX_SUBJECT_IMAGES, MAX_BACKGROUND_IMAGES, COVER_TITLE_SOFT_MAX, COVER_TITLE_HARD_MAX, COVER_SUBTITLE_HARD_MAX, COVER_EXTRA_HARD_MAX, MAX_COVER_IMAGES } from '@/lib/cover/rules';
import { PortraitConsentText } from '@/components/PortraitConsent';
import { prepareReferenceImage, downloadImage } from '@/lib/cover/client-image';
import type { MediaAssetSummary } from '@/lib/media/store';
import { actSaveLibraryAsset, actDeleteAsset, actDraftCovers, actSetDraftCover, actSaveStylePreset, actDeleteStylePreset, type StylePreset } from './cover-actions';

// 封面工位（「标题与封面」tab 顶部）。外部封面工具要用户想四件事：比例、标题、风格、素材；
// 这里四件事都有默认来源：比例按草稿平台、大字用采纳的标题 / 标题矩阵带入、风格按人设赛道推荐、
// 人像上传前先看到「传给谁 / 存不存」。用户真正要决定的只剩「换不换风格」和「带不带我的脸」。
//
// 生成走 /api/cover/generate（Route Handler + SSE）：绕开 server action 的 1MB 请求体上限与 60s 墙钟，
// 拿回来的是**已打隐式 AIGC 标识**的 data URL——预览 / 下载 / 右键另存三条出口同一份字节。

export type CoverText = { mainTitle: string; subTitle: string };

export type CoverQuota = {
  /** 这个租户能不能生图（有没有可用的豆包渠道 / 平台兜底） */
  configured: boolean;
  /** 今日还能出几张（图像专属日上限），未配置时无意义 */
  remaining: number;
  cap: number;
  source: 'platform' | 'byok' | null;
};

type CoverImage = {
  id?: string;
  url: string;
  mime: string;
  aigcEmbedded: boolean;
  bytes: number;
  /** 多风格 / 公众号成对时每张各不相同，要按各自的比例渲染、按各自的名字下载 */
  styleKey?: string;
  styleName?: string;
  specKey?: string;
  specLabel?: string;
  aspect?: number;
};
type DoneEvent = {
  images: CoverImage[];
  meta: { mainTitle: string; subTitle?: string };
  metaFromUser: boolean;
  spec: { key: string; label: string; aspect: number; fileStem: string };
  styleKey: string;
  mocked: boolean;
  riskLevel: string;
  hits: { word: string; tier: string; suggestion?: string }[];
  warning?: string;
};

type Phase =
  | { kind: 'idle' }
  | { kind: 'running'; hint: string; secs: number }
  | { kind: 'error'; msg: string };

type RefImage = { dataUrl: string; bytes: number };

const RISK_LABEL: Record<string, { text: string; cls: string }> = {
  low: { text: '合规风险低', cls: 'badge-green' },
  medium: { text: '合规风险中', cls: 'badge-amber' },
  high: { text: '合规风险高', cls: 'badge-red' },
};

export function CoverStation({
  draftId,
  platform,
  draftTitle,
  hasContent,
  personaText,
  defaultStyleKey,
  defaultFontKey,
  quota,
  coverText,
  onCoverTextChange,
  initialLibrary,
  initialCovers,
  initialCoverAssetId,
  initialStylePresets,
}: {
  draftId?: string;
  platform?: string;
  draftTitle?: string;
  hasContent: boolean;
  /** 人设的赛道 / 语气 / 身份拼成的一段，只用来给风格排序 */
  personaText: string;
  /** 人设「品牌视觉」里设的默认值（空 = 按赛道推荐 / 随风格） */
  defaultStyleKey?: string;
  defaultFontKey?: string;
  quota: CoverQuota;
  /** 「我的形象」里已存的素材（服务端算好传下来，避免开页就发一次 action） */
  initialLibrary: MediaAssetSummary[];
  /** 这篇稿子已经出过的封面 */
  initialCovers: MediaAssetSummary[];
  initialCoverAssetId: string | null;
  /** 「我的风格库」：用户自己写的风格档（key 形如 custom:<id>） */
  initialStylePresets: StylePreset[];
  /** 封面大字 / 副字：由父容器持有（标题矩阵的「作封面大字」要写进来） */
  coverText: CoverText;
  onCoverTextChange: (t: CoverText) => void;
}) {
  const [specKey, setSpecKey] = useState(specForPlatform(platform).key);
  const ranked = useMemo(() => rankStylesForPersona(personaText), [personaText]);
  // 默认风格：人设里设过就用它，没设过按赛道推荐的第一档
  const [styleKey, setStyleKey] = useState(
    defaultStyleKey && COVER_STYLE_OPTIONS.some((o) => o.key === defaultStyleKey)
      ? defaultStyleKey
      : (ranked[0]?.style.key ?? COVER_STYLE_OPTIONS[0].key),
  );
  const [fontKey, setFontKey] = useState(
    defaultFontKey && COVER_FONTS.some((f) => f.key === defaultFontKey) ? defaultFontKey : DEFAULT_COVER_FONT,
  );
  const [decors, setDecors] = useState<string[]>([]);
  const [extra, setExtra] = useState('');
  const [textless, setTextless] = useState(false);
  const [subject, setSubject] = useState<RefImage[]>([]);
  const [backgrounds, setBackgrounds] = useState<RefImage[]>([]);
  const [consent, setConsent] = useState(false);
  const [refErr, setRefErr] = useState('');
  const [showMore, setShowMore] = useState(false);
  const [showAllStyles, setShowAllStyles] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [result, setResult] = useState<DoneEvent | null>(null);
  const [remaining, setRemaining] = useState(quota.remaining);
  // 「我的形象」：已存素材 + 本次勾选了哪几张
  const [library, setLibrary] = useState<MediaAssetSummary[]>(initialLibrary);
  const [pickedAssets, setPickedAssets] = useState<string[]>([]);
  const [saveToLibrary, setSaveToLibrary] = useState(false);
  // 本稿封面历史
  const [covers, setCovers] = useState<MediaAssetSummary[]>(initialCovers);
  const [coverAssetId, setCoverAssetId] = useState<string | null>(initialCoverAssetId);
  const [busy, setBusy] = useState('');
  // 一次出几张 / 多选风格 / 公众号成对
  const [variants, setVariants] = useState(1);
  const [multiStyles, setMultiStyles] = useState<string[]>([]);
  const [wechatSquareToo, setWechatSquareToo] = useState(false);
  // 我的风格库
  const [presets, setPresets] = useState<StylePreset[]>(initialStylePresets);
  const [newStyleName, setNewStyleName] = useState('');
  const [newStyleDesc, setNewStyleDesc] = useState('');
  const [styleErr, setStyleErr] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  // 切草稿：比例跟着新草稿的平台走（用户手动改过也重置——那是上一篇的选择）
  useEffect(() => {
    setSpecKey(specForPlatform(platform).key);
    setResult(null);
    setPhase({ kind: 'idle' });
    setCovers(initialCovers);
    setCoverAssetId(initialCoverAssetId);
    setPickedAssets([]);
    // initialCovers / initialCoverAssetId 由服务端随草稿一起下发，跟着 draftId 变
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId, platform]);

  // 从「写完之后 → 封面」跳过来时把工位滚进视野
  useEffect(() => {
    const onJump = (e: Event) => {
      const anchor = (e as CustomEvent<{ anchor?: string }>).detail?.anchor;
      if (anchor === 'cover-station') {
        // 先等 tab 面板从 hidden 变可见再滚；用瞬时滚动——smooth 在某些内嵌浏览器里会被随后的布局变化打断
        setTimeout(() => rootRef.current?.scrollIntoView({ block: 'start' }), 80);
      }
    };
    window.addEventListener('studio:tab', onJump);
    return () => window.removeEventListener('studio:tab', onJump);
  }, []);

  const spec = coverSpec(specKey);
  const mainTitle = coverText.mainTitle;
  const titleLen = [...mainTitle.trim()].length;
  const titleTooLong = titleLen > COVER_TITLE_SOFT_MAX;
  const hasRefs = subject.length + backgrounds.length + pickedAssets.length > 0;
  const needsDerive = !mainTitle.trim() && !textless;
  // 这次出哪几张：与服务端**同一个** planCoverJobs（lib/cover/specs.ts）。
  // 各算各的时，「出 3 张 + 连 1:1 次图」这种组合上两边会给出不同的结果，
  // 而张数还对得上——次图被静默丢掉，界面不会有任何提示。
  const plannedJobs = planCoverJobs({
    specKey,
    styleKey,
    styleKeys: multiStyles.length > 1 ? multiStyles : undefined,
    variants,
    wechatSquareToo,
    max: MAX_COVER_IMAGES,
  });
  const plannedImages = plannedJobs.length;
  const pairing = wechatSquareToo && specKey === WECHAT_MAIN_SPEC;
  const pairedSquare = plannedJobs.some((j) => j.specKey === WECHAT_SQUARE_SPEC);
  // 成对时次图先占一格，主图预算相应少一张——下拉里就只给到这么多，
  // 而不是让用户选了 3 再在服务端悄悄变成 2（选项本身就该是真能选的那些）。
  const mainBudget = pairing ? MAX_COVER_IMAGES - 1 : MAX_COVER_IMAGES;
  // 名额 = 出图张数（每张一次真实调用）+ 需要抽文案时的那一次
  const slots = plannedImages + (needsDerive ? 1 : 0);
  const running = phase.kind === 'running';
  const topStyles = ranked.slice(0, 6);
  const canGenerate =
    !!draftId && quota.configured && !running && (mainTitle.trim().length > 0 || hasContent || textless) && (!hasRefs || consent);

  async function pick(files: FileList | null, kind: 'subject' | 'background') {
    setRefErr('');
    if (!files || files.length === 0) return;
    const max = kind === 'subject' ? MAX_SUBJECT_IMAGES : MAX_BACKGROUND_IMAGES;
    const cur = kind === 'subject' ? subject : backgrounds;
    const room = max - cur.length;
    if (room <= 0) {
      setRefErr(kind === 'subject' ? `人像/主体最多 ${max} 张` : `背景最多 ${max} 张`);
      return;
    }
    const picked: RefImage[] = [];
    for (const f of Array.from(files).slice(0, room)) {
      try {
        const p = await prepareReferenceImage(f);
        picked.push({ dataUrl: p.dataUrl, bytes: p.bytes });
      } catch (e) {
        setRefErr((e as Error).message);
      }
    }
    if (!picked.length) return;
    if (kind === 'subject') setSubject((prev) => [...prev, ...picked].slice(0, MAX_SUBJECT_IMAGES));
    else setBackgrounds((prev) => [...prev, ...picked].slice(0, MAX_BACKGROUND_IMAGES));

    // 勾了「存进我的形象」才落库。默认不存：直接选文件上传的是**一次性使用、不保存**，
    // 存不存必须是用户点的，不能替他决定（隐私政策里两种口径分开写的就是这件事）。
    if (saveToLibrary) {
      for (const p of picked) {
        const r = await actSaveLibraryAsset(p.dataUrl, kind === 'subject' ? 'portrait' : 'background', { consented: consent });
        if (!r.ok) {
          setRefErr(r.error);
          break;
        }
        setLibrary(r.assets);
      }
    }
  }

  function togglePickedAsset(id: string) {
    setPickedAssets((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function removeAsset(id: string) {
    if (!window.confirm('从「我的形象」里删掉这张？删了就没有了。')) return;
    setBusy('deleting');
    const r = await actDeleteAsset(id);
    setBusy('');
    if (r.ok) {
      setLibrary(r.assets);
      setPickedAssets((prev) => prev.filter((x) => x !== id));
    } else {
      setRefErr(r.error);
    }
  }

  async function setAsDraftCover(assetId: string) {
    if (!draftId) return;
    setBusy('setting');
    const r = await actSetDraftCover(draftId, assetId);
    setBusy('');
    if (r.ok) {
      setCovers(r.covers);
      setCoverAssetId(r.coverAssetId);
    }
  }

  async function refreshCovers() {
    if (!draftId) return;
    const r = await actDraftCovers(draftId);
    if (r.ok) {
      setCovers(r.covers);
      setCoverAssetId(r.coverAssetId);
    }
  }

  async function generate(overrides?: { styleKey?: string; reuseMeta?: boolean }) {
    if (!draftId) return;
    const useStyle = overrides?.styleKey ?? styleKey;
    if (overrides?.styleKey) setStyleKey(overrides.styleKey);
    // 「换一张 / 换风格」复用上一次抽到的文案：不再重抽标题，只花一次生图
    const reuse = overrides?.reuseMeta && result ? result.meta : null;
    const body = {
      draftId,
      specKey,
      styleKey: useStyle,
      styleKeys: multiStyles.length > 1 && !overrides?.styleKey ? multiStyles : undefined,
      variants,
      wechatSquareToo,
      fontKey,
      decors,
      extra: extra.slice(0, COVER_EXTRA_HARD_MAX),
      textless,
      mainTitle: (reuse?.mainTitle ?? mainTitle).slice(0, COVER_TITLE_HARD_MAX),
      subTitle: (reuse?.subTitle ?? coverText.subTitle).slice(0, COVER_SUBTITLE_HARD_MAX),
      subjectImages: subject.map((s) => s.dataUrl),
      backgroundImages: backgrounds.map((s) => s.dataUrl),
      // 「我的形象」里勾选的按 kind 分到两组（服务端解密取字节，不经过前端）
      subjectAssetIds: pickedAssets.filter((id) => library.find((a) => a.id === id)?.kind === 'portrait'),
      backgroundAssetIds: pickedAssets.filter((id) => {
        const k = library.find((a) => a.id === id)?.kind;
        return k === 'background' || k === 'brand';
      }),
      portraitConsent: hasRefs ? consent : false,
    };
    setPhase({ kind: 'running', hint: '正在提交…', secs: 0 });
    const started = Date.now();
    const tick = setInterval(
      () => setPhase((p) => (p.kind === 'running' ? { ...p, secs: Math.floor((Date.now() - started) / 1000) } : p)),
      1000,
    );
    try {
      const res = await fetch('/api/cover/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({ error: '请求失败' }));
        throw new Error(j.error ?? '请求失败');
      }
      // 2026-08-17 生产实测：请求体超过网关缓冲区时，宝塔 WAF 会回一个**状态码 200 的 HTML 错误页**；
      // 登录过期时中间件则把请求 307 到 /login，fetch 跟随后同样是 200 + HTML。
      // 两种情况下 res.ok 都为真，硬解 SSE 只会在最后抛一句「连接中断」——与真因毫无关系。
      // 所以先认响应类型：不是事件流就说清楚是被谁挡了，而不是让用户对着一句没用的错误猜。
      const ctype = res.headers.get('content-type') ?? '';
      if (!ctype.includes('text/event-stream')) {
        throw new Error(
          res.redirected || res.url.includes('/login')
            ? '登录已过期，刷新页面重新登录后再生成。'
            : '请求没到达服务（多半被网关拦下了，常见于图片太大）。换张小一点的参考图，或稍后重试。',
        );
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const chunks = buf.split('\n\n');
        buf = chunks.pop() ?? '';
        for (const c of chunks) {
          const ev = /event:\s*(\w+)/.exec(c)?.[1];
          const dataLine = /data:\s*([\s\S]*)/.exec(c)?.[1];
          if (!ev || !dataLine) continue;
          const data = JSON.parse(dataLine) as Record<string, unknown>;
          if (ev === 'start' || ev === 'progress') {
            const hint = String(data.hint ?? data.message ?? '');
            setPhase((p) => (p.kind === 'running' ? { ...p, hint } : p));
          }
          if (ev === 'failed') throw new Error(String(data.error ?? '生成失败'));
          if (ev === 'done') {
            clearInterval(tick);
            const d = data as unknown as DoneEvent;
            setResult(d);
            setPhase({ kind: 'idle' });
            setRemaining((n) => Math.max(0, n - (d.images?.length ?? 1)));
            // 抽出来的文案回填到大字框：下一次「换一张」就不再花抽取那一次
            if (!d.metaFromUser && d.meta?.mainTitle) {
              onCoverTextChange({ mainTitle: d.meta.mainTitle, subTitle: d.meta.subTitle ?? '' });
            }
            void refreshCovers(); // 新出的这张已经落库了，历史列表跟上
            return;
          }
        }
      }
      throw new Error('连接中断，请重试（如果扣了额度而没出图，稍后会自动归还）。');
    } catch (e) {
      setPhase({ kind: 'error', msg: (e as Error).message });
    } finally {
      clearInterval(tick);
    }
  }

  const risk = result ? RISK_LABEL[result.riskLevel] : null;

  return (
    <div ref={rootRef} id="cover-station" className="stack" style={{ gap: 12 }}>
      {/* 第一行：比例 · 大字 · 副字 */}
      <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
        <select
          className="select"
          style={{ maxWidth: 170 }}
          value={specKey}
          onChange={(e) => {
            setSpecKey(e.target.value);
            // 成对只对公众号主图成立：换走比例就把它关掉，别留一个勾着却不生效的开关
            if (e.target.value !== WECHAT_MAIN_SPEC) setWechatSquareToo(false);
          }}
          title="比例按草稿平台自动选好了，需要别的比例可以换"
        >
          {COVER_SPEC_OPTIONS.map((o) => (
            <option key={o.key} value={o.key} title={o.hint}>{o.label}</option>
          ))}
        </select>
        <input
          className="input"
          style={{ flex: '1 1 220px', minWidth: 0 }}
          placeholder={hasContent ? '封面大字（留空则从正文自动提炼）' : '封面大字（这稿还没正文，先填一句）'}
          value={mainTitle}
          maxLength={COVER_TITLE_HARD_MAX}
          onChange={(e) => onCoverTextChange({ ...coverText, mainTitle: e.target.value })}
        />
        <input
          className="input"
          style={{ flex: '1 1 160px', minWidth: 0 }}
          placeholder="副字（可选）"
          value={coverText.subTitle}
          maxLength={COVER_SUBTITLE_HARD_MAX}
          onChange={(e) => onCoverTextChange({ ...coverText, subTitle: e.target.value })}
        />
      </div>
      {titleTooLong && (
        <div className="small" style={{ color: 'var(--amber)', marginTop: -6 }}>
          大字 {titleLen} 字，超过 {COVER_TITLE_SOFT_MAX} 字上图会挤，建议精简（不会替你截断）
        </div>
      )}
      {!mainTitle.trim() && draftTitle && (
        <div className="row wrap" style={{ gap: 6, alignItems: 'center', marginTop: -6 }}>
          <span className="small muted">要不要直接用草稿标题？</span>
          <button className="btn btn-xs btn-ghost" onClick={() => onCoverTextChange({ ...coverText, mainTitle: draftTitle.slice(0, COVER_TITLE_HARD_MAX) })}>
            用「{draftTitle.slice(0, 18)}{draftTitle.length > 18 ? '…' : ''}」
          </button>
        </div>
      )}

      {/* 第二行：风格 chips（按赛道推荐排前） */}
      <div className="row wrap" style={{ gap: 6, alignItems: 'center' }}>
        <span className="small muted" style={{ marginRight: 2 }}>风格</span>
        {topStyles.map(({ style, recommended }) => (
          <button
            key={style.key}
            className={`btn btn-sm ${styleKey === style.key ? 'btn-accent' : 'btn-ghost'}`}
            onClick={() => setStyleKey(style.key)}
            title={style.hint}
          >
            {style.name}
            {recommended && <span className="small" style={{ marginLeft: 4, opacity: 0.8 }}>· 推荐</span>}
          </button>
        ))}
        {!topStyles.some((s) => s.style.key === styleKey) && (
          <button className="btn btn-sm btn-accent" onClick={() => setShowAllStyles(true)}>
            {COVER_STYLE_OPTIONS.find((s) => s.key === styleKey)?.name}
          </button>
        )}
        {presets.slice(0, 3).map((p) => (
          <button
            key={p.id}
            className={`btn btn-sm ${styleKey === `custom:${p.id}` ? 'btn-accent' : 'btn-ghost'}`}
            onClick={() => setStyleKey(`custom:${p.id}`)}
            title={p.description}
          >
            {p.name}
          </button>
        ))}
        <button className="btn btn-sm btn-ghost" onClick={() => setShowAllStyles(true)}>
          全部 {COVER_STYLE_OPTIONS.length + presets.length} 种 ▸
        </button>
        {multiStyles.length > 1 && (
          <span className="small muted">
            已多选 {multiStyles.length} 个风格，各出一张
            {/* 勾了成对出图时次图占掉一格，排在后面的风格这次排不进来——说出来，
                别让用户勾了三个只出两个还以为是坏了 */}
            {multiStyles.length > mainBudget
              ? `（这次只出前 ${mainBudget} 个：1:1 次图占了一张名额）`
              : ''}
          </span>
        )}
      </div>

      {/* 第三行：人像 · 背景 · 留白 · 更多选项 */}
      <div className="row wrap" style={{ gap: 10, alignItems: 'center' }}>
        <span className="small muted">人像/主体</span>
        {subject.map((s, i) => (
          <Thumb key={i} src={s.dataUrl} onRemove={() => setSubject((p) => p.filter((_, j) => j !== i))} />
        ))}
        {subject.length < MAX_SUBJECT_IMAGES && (
          <UploadButton
            label="+ 添加你的照片"
            disabled={!consent}
            title={consent ? '人像出镜的封面效果最好；不上传也能出图' : '先勾选下面的同意确认，再上传照片'}
            onFiles={(f) => pick(f, 'subject')}
          />
        )}
        <span className="small muted" style={{ marginLeft: 6 }}>背景</span>
        {backgrounds.map((s, i) => (
          <Thumb key={i} src={s.dataUrl} onRemove={() => setBackgrounds((p) => p.filter((_, j) => j !== i))} />
        ))}
        {backgrounds.length < MAX_BACKGROUND_IMAGES && (
          <UploadButton
            label="+ 背景图"
            multiple
            disabled={!consent}
            title={consent ? '空镜 / 场景图，AI 会从中取材或融合' : '先勾选下面的同意确认，再上传'}
            onFiles={(f) => pick(f, 'background')}
          />
        )}
        <label className="small muted" style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 6 }}>
          <input type="checkbox" checked={textless} onChange={(e) => setTextless(e.target.checked)} />
          文字留白版
        </label>
        {/* 一次出几张：每张都是一次真实付费调用，所以上限 3、且按钮上明示占几个名额 */}
        <label className="small muted" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          出
          <select
            className="select"
            style={{ width: 58, padding: '2px 6px', fontSize: 12.5 }}
            value={multiStyles.length > 1 ? Math.min(multiStyles.length, mainBudget) : Math.min(variants, mainBudget)}
            disabled={multiStyles.length > 1}
            onChange={(e) => setVariants(Number(e.target.value))}
            title={
              multiStyles.length > 1
                ? '多选了风格时，张数 = 选中的风格数'
                : pairing
                  ? `勾了成对出图，1:1 次图占掉一张，主图最多 ${mainBudget} 张`
                  : '同一风格出几张不同的变体'
            }
          >
            {Array.from({ length: mainBudget }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>{n} 张</option>
            ))}
          </select>
          {pairing && <span>主图</span>}
        </label>
        {specKey === WECHAT_MAIN_SPEC && (
          <label className="small muted" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={wechatSquareToo} onChange={(e) => setWechatSquareToo(e.target.checked)} />
            连 1:1 次图一起出（公众号要两张）
          </label>
        )}
        <button className="btn btn-sm btn-ghost" onClick={() => setShowMore(true)}>
          <Icon.settings size={13} /> 更多选项
          {(fontKey !== DEFAULT_COVER_FONT || decors.length > 0 || extra.trim()) ? '（已设置）' : ''}
        </button>
      </div>
      {refErr && <div className="small" style={{ color: 'var(--red)', marginTop: -6 }}>{refErr}</div>}

      {/* 我的形象：存过的素材下次直接勾，不用重传。存不存是用户点的——直接选文件上传的一律不落库。 */}
      {(library.length > 0 || subject.length + backgrounds.length > 0) && (
        <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
          {library.length > 0 && <span className="small muted">我的形象</span>}
          {library.map((a) => {
            const on = pickedAssets.includes(a.id);
            return (
              <span key={a.id} style={{ position: 'relative', display: 'inline-block' }}>
                <button
                  onClick={() => togglePickedAsset(a.id)}
                  title={`${a.kind === 'portrait' ? '人像' : a.kind === 'background' ? '背景' : '品牌元素'}${a.label ? ' · ' + a.label : ''}（点一下这次用它）`}
                  style={{
                    padding: 0,
                    border: on ? '2px solid var(--accent)' : '1px solid var(--border)',
                    borderRadius: 6,
                    background: 'none',
                    cursor: 'pointer',
                    lineHeight: 0,
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={a.url} alt={a.label ?? '形象素材'} style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 5 }} />
                </button>
                <button
                  className="btn btn-xs"
                  style={{ position: 'absolute', top: -6, right: -6, padding: '0 5px', lineHeight: 1.4 }}
                  title="从我的形象里删掉"
                  onClick={() => void removeAsset(a.id)}
                  disabled={busy === 'deleting'}
                >×</button>
              </span>
            );
          })}
          {subject.length + backgrounds.length > 0 && (
            <label className="small muted" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input type="checkbox" checked={saveToLibrary} onChange={(e) => setSaveToLibrary(e.target.checked)} />
              把刚上传的存进「我的形象」（下次直接勾，不用重传）
            </label>
          )}
        </div>
      )}

      {/* 单独同意：目的 / 方式 / 接收方 / 保存期 / 本人或已授权。未勾选时上传按钮置灰不隐藏。 */}
      <label className="small" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', lineHeight: 1.6, color: 'var(--text-2)' }}>
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} style={{ marginTop: 3 }} />
        {/* 这段字与出图工位共用一份（components/PortraitConsent.tsx）：合规文本不许有第二个版本 */}
        <PortraitConsentText />
      </label>

      {/* 生成 */}
      <div className="row wrap" style={{ gap: 10, alignItems: 'center' }}>
        <button
          className="btn btn-primary"
          onClick={() => generate()}
          disabled={!canGenerate}
          title={
            !draftId
              ? '先在左侧选中一份草稿'
              : !quota.configured
                ? '还没有可用的生图渠道'
                : hasRefs && !consent
                  ? '上传了照片就需要先勾选同意确认'
                  : undefined
          }
        >
          <Icon.sparkles size={14} /> {running ? '生成中…' : '生成封面'}
        </button>
        {quota.configured ? (
          <span className="small muted">
            本次出 {plannedImages} 张{pairedSquare ? `（${plannedImages - 1} 张主图 + 1 张 1:1 次图）` : ''} · 约占 {slots} 个 AI 名额
            {needsDerive ? '（含提炼文案 1 次）' : ''} · 今日还能出 {remaining} 张
          </span>
        ) : (
          <span className="small muted">
            还没有可用的生图渠道——到{' '}
            <Link href="/settings/keys" style={{ textDecoration: 'underline' }}>接入与密钥</Link> 加一个「火山引擎 豆包」渠道，封面就能用它出图（不用另配 Key）。
          </span>
        )}
      </div>
      {running && (
        <div className="small muted" style={{ marginTop: -4 }}>
          <Icon.clock size={12} /> {phase.hint}（{phase.secs}s）
        </div>
      )}
      {phase.kind === 'error' && <div className="small" style={{ color: 'var(--red)', marginTop: -4 }}>{phase.msg}</div>}

      {/* 结果 */}
      {result && (
        <div className="card" style={{ padding: 14, boxShadow: 'none', background: 'var(--surface-2)' }}>
          <div className="row-between wrap" style={{ gap: 8, marginBottom: 8 }}>
            <div className="row wrap" style={{ gap: 6, alignItems: 'center' }}>
              <b className="small">{result.spec.label} 封面</b>
              {/* 风格名优先取每张图自己记下的（自定义风格不在内置清单里，查不到名字） */}
              <span className="badge badge-gray">
                {result.images[0]?.styleName ??
                  COVER_STYLE_OPTIONS.find((s) => s.key === result.styleKey)?.name ??
                  '风格'}
              </span>
              {result.mocked && <span className="badge badge-amber" title="抽标题那步用的是演示模型；图是真的">文案为演示结果</span>}
              {risk && <span className={`badge ${risk.cls}`}>{risk.text}</span>}
            </div>
            <span className="small muted">
              图上「AI生成」角标 = 显式标识；文件内已写入隐式 AIGC 标识
              {result.images.some((i) => !i.aigcEmbedded) ? '（部分格式无法写入）' : ''}
            </span>
          </div>
          {!textless && result.meta?.mainTitle && (
            <div className="small muted" style={{ marginBottom: 8 }}>
              封面文案：<b>{result.meta.mainTitle}</b>
              {result.meta.subTitle ? ` · ${result.meta.subTitle}` : ''}
            </div>
          )}
          <div className="row wrap" style={{ gap: 12, alignItems: 'flex-start' }}>
            {result.images.map((img, i) => (
              <div key={i} className="stack" style={{ gap: 6 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={img.url}
                  alt={`${img.specLabel ?? result.spec.label} 封面`}
                  style={{
                    width: (img.aspect ?? result.spec.aspect) >= 1 ? 360 : 240,
                    maxWidth: '100%',
                    aspectRatio: String(img.aspect ?? result.spec.aspect),
                    objectFit: 'cover',
                    borderRadius: 10,
                    border: '1px solid var(--border)',
                    background: 'var(--surface)',
                  }}
                />
                {result.images.length > 1 && (
                  <div className="small muted" style={{ fontSize: 11 }}>
                    {img.styleName ?? ''}{img.specLabel ? ` · ${img.specLabel}` : ''}
                  </div>
                )}
                <div className="row wrap" style={{ gap: 6 }}>
                  <button
                    className="btn btn-sm"
                    onClick={() => void downloadImage(img.url, `${coverSpec(img.specKey ?? result.spec.key).fileStem}.${img.mime === 'image/png' ? 'png' : 'jpg'}`)}
                  >
                    <Icon.download size={13} /> 下载
                  </button>
                  {img.id && draftId && (
                    <button
                      className={`btn btn-sm ${coverAssetId === img.id ? 'btn-accent' : 'btn-ghost'}`}
                      onClick={() => void setAsDraftCover(img.id!)}
                      disabled={busy === 'setting'}
                      title="选定为这篇稿子的封面（选定的不会被保留期清理掉）"
                    >
                      {coverAssetId === img.id ? '✓ 本稿封面' : '设为本稿封面'}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
          {result.warning && <div className="small muted" style={{ marginTop: 8 }}>{result.warning}</div>}
          {result.hits.length > 0 && (
            <>
              <div className="divider" />
              <div className="small muted" style={{ marginBottom: 6 }}>封面文案里这些词发布前建议再斟酌：</div>
              <div className="stack" style={{ gap: 6 }}>
                {result.hits.map((h, i) => (
                  <div key={i} className="row wrap" style={{ gap: 6, alignItems: 'center' }}>
                    <TierBadge tier={h.tier} />
                    <span className="mono small">「{h.word}」</span>
                    {h.suggestion && <span className="small muted">→ {h.suggestion}</span>}
                  </div>
                ))}
              </div>
            </>
          )}
          <div className="divider" />
          <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
            <button className="btn btn-sm btn-ghost" onClick={() => generate({ reuseMeta: true })} disabled={running} title="同一套文案与设置再出一张（只花一次出图）">
              <Icon.refresh size={13} /> 换一张
            </button>
            <span className="small muted">换风格再来一张：</span>
            {ranked.slice(0, 5).filter((s) => s.style.key !== styleKey).map(({ style }) => (
              <button key={style.key} className="btn btn-xs btn-ghost" onClick={() => generate({ styleKey: style.key, reuseMeta: true })} disabled={running} title={style.hint}>
                {style.name}
              </button>
            ))}
            <button className="btn btn-xs btn-ghost" onClick={() => setShowAllStyles(true)} disabled={running}>更多…</button>
          </div>
        </div>
      )}

      {/* 本稿封面：落库之后才有的东西——此前封面只在 state 里，刷新即丢 */}
      {covers.length > 0 && (
        <div className="stack" style={{ gap: 8 }}>
          <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
            <b className="small">本稿封面（{covers.length}）</b>
            <span className="small muted">最近生成的都在这里，刷新页面也还在</span>
          </div>
          <div className="row wrap" style={{ gap: 10 }}>
            {covers.map((c) => {
              const isCurrent = coverAssetId === c.id;
              const stem = String((c.meta.specKey as string) ?? '') ;
              return (
                <div key={c.id} className="stack" style={{ gap: 4, width: 108 }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={c.url}
                    alt={String(c.meta.mainTitle ?? '封面')}
                    style={{
                      width: 108,
                      height: 108,
                      objectFit: 'cover',
                      borderRadius: 8,
                      border: isCurrent ? '2px solid var(--accent)' : '1px solid var(--border)',
                      background: 'var(--surface)',
                    }}
                  />
                  <div className="small muted" style={{ fontSize: 11, lineHeight: 1.4, minHeight: 15 }}>
                    {isCurrent ? '本稿封面' : String(c.meta.mainTitle ?? '').slice(0, 10)}
                  </div>
                  <div className="row wrap" style={{ gap: 4 }}>
                    <button
                      className="btn btn-xs"
                      onClick={() => void downloadImage(c.url, `${coverSpec(stem).fileStem}.${c.mime === 'image/png' ? 'png' : 'jpg'}`)}
                    >
                      下载
                    </button>
                    {draftId && !isCurrent && (
                      <button className="btn btn-xs btn-ghost" onClick={() => void setAsDraftCover(c.id)} disabled={busy === 'setting'}>
                        设为封面
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 更多选项弹层：字体倾向 / 装饰 / 备注 */}
      {showMore && (
        <Overlay label="封面更多选项" onClose={() => setShowMore(false)}>
          <div className="card" style={{ padding: 20, background: 'var(--surface)', width: 520, maxWidth: '94vw', maxHeight: '88vh', overflowY: 'auto' }}>
            <div className="row-between" style={{ marginBottom: 12 }}>
              <b className="small">更多选项</b>
              <button className="btn btn-xs btn-ghost" onClick={() => setShowMore(false)}>关闭</button>
            </div>
            <div className="field">
              <label className="field-label">字体倾向</label>
              <div className="row wrap" style={{ gap: 6 }}>
                {COVER_FONTS.map((f) => (
                  <button key={f.key} className={`btn btn-sm ${fontKey === f.key ? 'btn-accent' : 'btn-ghost'}`} onClick={() => setFontKey(f.key)} title={f.prompt || '由风格决定'}>
                    {f.name}
                  </button>
                ))}
              </div>
              <div className="small muted" style={{ marginTop: 6 }}>
                这是给 AI 的「字体感」描述，不是真字体文件——所以这里不做预览，实际字形以出图为准。
              </div>
            </div>
            <div className="field" style={{ marginTop: 12 }}>
              <label className="field-label">装饰点缀（可多选）</label>
              <div className="row wrap" style={{ gap: 6 }}>
                {COVER_DECORS.map((d) => {
                  const on = decors.includes(d.key);
                  return (
                    <button key={d.key} className={`btn btn-sm ${on ? 'btn-accent' : 'btn-ghost'}`} onClick={() => setDecors((p) => (on ? p.filter((x) => x !== d.key) : [...p, d.key]))} title={d.prompt}>
                      {d.name}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="field" style={{ marginTop: 12 }}>
              <label className="field-label">给 AI 的其他要求（可选）</label>
              <textarea
                className="input"
                rows={3}
                placeholder="比如：背景要有咖啡馆 / 整体偏冷色 / 人物放右边"
                value={extra}
                maxLength={COVER_EXTRA_HARD_MAX}
                onChange={(e) => setExtra(e.target.value)}
              />
            </div>
          </div>
        </Overlay>
      )}

      {/* 全部风格弹层 */}
      {showAllStyles && (
        <Overlay label="选择封面风格" onClose={() => setShowAllStyles(false)}>
          <div className="card" style={{ padding: 20, background: 'var(--surface)', width: 720, maxWidth: '94vw', maxHeight: '88vh', overflowY: 'auto' }}>
            <div className="row-between" style={{ marginBottom: 12 }}>
              <b className="small">封面风格</b>
              <button className="btn btn-xs btn-ghost" onClick={() => setShowAllStyles(false)}>关闭</button>
            </div>
            <div className="small muted" style={{ marginBottom: 10, lineHeight: 1.6 }}>
              点一个 = 用它出图。想一次比几种，勾右上角的方框多选（最多 {MAX_COVER_IMAGES} 个，各出一张）。
            </div>

            {presets.length > 0 && (
              <>
                <b className="small" style={{ display: 'block', marginBottom: 6 }}>我的风格</b>
                <div className="grid grid-2" style={{ gap: 8, marginBottom: 14 }}>
                  {presets.map((p) => {
                    const key = `custom:${p.id}`;
                    return (
                      <div
                        key={p.id}
                        className="card"
                        style={{
                          padding: 12,
                          boxShadow: 'none',
                          background: styleKey === key ? 'var(--accent-soft)' : 'var(--surface-2)',
                          border: styleKey === key ? '1px solid var(--accent)' : '1px solid var(--border)',
                        }}
                      >
                        <div className="row-between" style={{ gap: 8, alignItems: 'flex-start' }}>
                          <button
                            style={{ background: 'none', border: 'none', padding: 0, textAlign: 'left', cursor: 'pointer', flex: 1 }}
                            onClick={() => {
                              setStyleKey(key);
                              setShowAllStyles(false);
                              if (result) void generate({ styleKey: key, reuseMeta: true });
                            }}
                          >
                            <b className="small">{p.name}</b>
                            <div className="small muted" style={{ marginTop: 4, lineHeight: 1.5 }}>{p.description.slice(0, 60)}{p.description.length > 60 ? '…' : ''}</div>
                          </button>
                          <button
                            className="btn btn-xs btn-ghost"
                            title="删掉这个风格"
                            onClick={async () => {
                              if (!window.confirm(`删掉「${p.name}」？`)) return;
                              const r = await actDeleteStylePreset(p.id);
                              if (r.ok) setPresets(r.presets);
                            }}
                          >×</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            <b className="small" style={{ display: 'block', marginBottom: 6 }}>内置风格</b>
            <div className="grid grid-2" style={{ gap: 8 }}>
              {ranked.map(({ style, recommended }) => {
                const checked = multiStyles.includes(style.key);
                return (
                  <div
                    key={style.key}
                    className="card"
                    style={{
                      padding: 12,
                      boxShadow: 'none',
                      background: styleKey === style.key ? 'var(--accent-soft)' : 'var(--surface-2)',
                      border: styleKey === style.key || checked ? '1px solid var(--accent)' : '1px solid var(--border)',
                    }}
                  >
                    <div className="row-between" style={{ gap: 8, alignItems: 'flex-start' }}>
                      <button
                        style={{ background: 'none', border: 'none', padding: 0, textAlign: 'left', cursor: 'pointer', flex: 1 }}
                        onClick={() => {
                          setStyleKey(style.key);
                          setShowAllStyles(false);
                          if (result) void generate({ styleKey: style.key, reuseMeta: true });
                        }}
                      >
                        <div className="row wrap" style={{ gap: 6, alignItems: 'center' }}>
                          <b className="small">{style.name}</b>
                          {recommended && <span className="badge badge-brand" style={{ fontSize: 10 }}>按你的赛道推荐</span>}
                          {style.portraitFriendly && <span className="badge badge-gray" style={{ fontSize: 10 }}>适合人像</span>}
                        </div>
                        <div className="small muted" style={{ marginTop: 4, lineHeight: 1.5 }}>{style.hint}</div>
                      </button>
                      <input
                        type="checkbox"
                        checked={checked}
                        title="一次比几种：勾上的各出一张"
                        onChange={(e) =>
                          setMultiStyles((prev) =>
                            e.target.checked
                              ? [...prev, style.key].slice(0, MAX_COVER_IMAGES)
                              : prev.filter((k) => k !== style.key),
                          )
                        }
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            {/* 自己写一个：描述原样进提示词，不替他 AI 扩写（要花钱、会走样） */}
            <div className="divider" />
            <b className="small" style={{ display: 'block', marginBottom: 6 }}>自己写一个风格</b>
            <div className="stack" style={{ gap: 8 }}>
              <input
                className="input"
                placeholder="风格名字，比如「我的黑金系列」"
                value={newStyleName}
                maxLength={20}
                onChange={(e) => setNewStyleName(e.target.value)}
              />
              <textarea
                className="input"
                rows={3}
                placeholder="画面长什么样：配色、背景、字怎么排、什么氛围。写得越具体，出图越像你要的。"
                value={newStyleDesc}
                maxLength={600}
                onChange={(e) => setNewStyleDesc(e.target.value)}
              />
              <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
                <button
                  className="btn btn-sm"
                  disabled={busy === 'style'}
                  onClick={async () => {
                    setStyleErr('');
                    setBusy('style');
                    const r = await actSaveStylePreset(newStyleName, newStyleDesc);
                    setBusy('');
                    if (r.ok) {
                      setPresets(r.presets);
                      setNewStyleName('');
                      setNewStyleDesc('');
                    } else {
                      setStyleErr(r.error);
                    }
                  }}
                >
                  存进我的风格
                </button>
                {styleErr && <span className="small" style={{ color: 'var(--red)' }}>{styleErr}</span>}
                <span className="small muted">你写的这段会原样发给出图模型，不会被改写。</span>
              </div>
            </div>

            {result && <div className="small muted" style={{ marginTop: 10 }}>已有结果时，点一个风格会直接用同一套文案再出一张。</div>}
          </div>
        </Overlay>
      )}
    </div>
  );
}

function Thumb({ src, onRemove }: { src: string; onRemove: () => void }) {
  return (
    <span style={{ position: 'relative', display: 'inline-block' }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="参考图" style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--border)' }} />
      <button
        className="btn btn-xs"
        style={{ position: 'absolute', top: -6, right: -6, padding: '0 5px', lineHeight: 1.4 }}
        title="移除"
        onClick={onRemove}
      >×</button>
    </span>
  );
}

function UploadButton({
  label,
  onFiles,
  disabled,
  title,
  multiple,
}: {
  label: string;
  onFiles: (f: FileList | null) => void;
  disabled?: boolean;
  title?: string;
  multiple?: boolean;
}) {
  return (
    <label
      className={`btn btn-sm btn-ghost${disabled ? ' disabled' : ''}`}
      style={{ cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1 }}
      title={title}
    >
      {label}
      <input
        type="file"
        accept="image/*"
        multiple={multiple}
        disabled={disabled}
        style={{ display: 'none' }}
        onChange={(e) => {
          onFiles(e.target.files);
          e.target.value = '';
        }}
      />
    </label>
  );
}
