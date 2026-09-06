'use client';

import { useState, useTransition, useRef, useEffect, useCallback } from 'react';
import { Overlay } from '@/components/Overlay';
import { actExportCards } from './actions';
import { CARD_W, CARD_H, DEFAULT_CARD_THEME, type Card, type CardThemeKey } from '@/lib/deliverable/card';
import { drawCard, cardToPng } from '@/lib/deliverable/canvas';
import { AIGC_LABEL } from '@/lib/compliance/aigc';
import { useI18n } from '@/lib/i18n';

type Loaded = {
  byTheme: Record<CardThemeKey, Card[]>;
  themes: { key: CardThemeKey; name: string }[];
};

const BETA_HINT = '本地排版新功能，尚未经过大量真实稿件验证。下载前请扫一眼缩略图，遇到排版异常欢迎反馈。';
const BETA_HINT_EN = 'New card layout feature. Please preview thumbnails before downloading; feedback is welcome if formatting issues arise.';

const THEME_NAMES_EN: Record<string, string> = {
  plain: 'Minimal White',
  magazine: 'Magazine Red',
  night: 'Dark Night',
  note: 'Memo Yellow',
};

export function CardExport({ draftId }: { draftId: string }) {
  const { lang } = useI18n();
  const [data, setData] = useState<Loaded | null>(null);
  const [theme, setTheme] = useState<CardThemeKey>(DEFAULT_CARD_THEME);
  const [meta, setMeta] = useState('');
  const [title, setTitle] = useState('');
  const [msg, setMsg] = useState('');
  const [pending, start] = useTransition();
  const refs = useRef<(HTMLCanvasElement | null)[]>([]);

  // 四套模板的指令一次全拿到，切模板只是换一份指令重画：不再调模型、不再等
  const cards = data?.byTheme[theme] ?? null;

  // 描图放 effect 里而不是 requestAnimationFrame：调 server action 会重渲当前路由
  // （Next 15 的既定行为，与 revalidatePath 无关），画在提交之前会被抹掉。
  // ref 回调里也画一次，覆盖「元素重新挂载」这条路径。
  useEffect(() => {
    cards?.forEach((c, i) => {
      const el = refs.current[i];
      if (el) drawCard(el, c);
    });
  }, [cards]);

  function close() {
    setData(null);
    setMsg('');
  }

  const attach = useCallback(
    (i: number) => (el: HTMLCanvasElement | null) => {
      refs.current[i] = el;
      if (el && cards?.[i]) drawCard(el, cards[i]);
    },
    [cards],
  );

  function load() {
    setMsg('');
    start(async () => {
      const r = await actExportCards(draftId);
      if (!r.ok) {
        setMsg(r.error);
        return;
      }
      setData({ byTheme: r.byTheme, themes: r.themes });
      setTheme(r.defaultTheme);
      setMeta(r.aigcMetadata);
      setTitle(r.title);
    });
  }

  async function save(index: number) {
    const el = refs.current[index];
    if (!el) return;
    // 隐式标识（第五条）在 cardToPng 里写进 PNG 的 iTXt 分块，随图片走，转存/上传都不会掉
    const png = await cardToPng(el, meta);
    const url = URL.createObjectURL(new Blob([png as BlobPart], { type: 'image/png' }));
    const a = document.createElement('a');
    a.href = url;
    const defaultTitle = lang === 'en' ? 'card' : '图文卡';
    a.download = `${title || defaultTitle}-${theme}-${String(index + 1).padStart(2, '0')}.png`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function saveAll() {
    if (!cards) return;
    for (let i = 0; i < cards.length; i++) {
      await save(i);
      // 连续触发下载浏览器会拦，隔一拍再来下一张
      await new Promise((r) => setTimeout(r, 220));
    }
    setMsg(lang === 'en' ? `Exported ${cards.length} cards` : `已导出 ${cards.length} 张`);
  }

  const betaHint = lang === 'en' ? BETA_HINT_EN : BETA_HINT;

  if (!cards || !data) {
    return (
      <span className="row" style={{ gap: 6 }}>
        <button className="btn btn-sm" onClick={load} disabled={pending} title={betaHint}>
          {pending ? (lang === 'en' ? 'Formatting…' : '排版中…') : (lang === 'en' ? 'Export Cards' : '导出图文卡')}
        </button>
        <span className="badge badge-amber" title={betaHint}>Beta</span>
        {msg && <span className="small" style={{ color: 'var(--red)' }}>{msg}</span>}
      </span>
    );
  }

  const overlayTitle = lang === 'en' ? 'Export Cards' : '图文卡导出';

  return (
    <Overlay label={overlayTitle} onClose={close}>
    <div
      className="card"
      style={{ padding: 20, background: 'var(--surface)', width: 720, maxWidth: '94vw', maxHeight: '88vh', overflowY: 'auto' }}
    >
      <div className="row-between" style={{ marginBottom: 10 }}>
        <span className="row" style={{ gap: 6 }}>
          <b className="small">
            {lang === 'en' ? `Cards · ${cards.length} cards (3:4, 1080×1440)` : `图文卡 · ${cards.length} 张（3:4，1080×1440）`}
          </b>
          <span className="badge badge-amber" title={betaHint}>Beta</span>
        </span>
        <span className="row" style={{ gap: 6 }}>
          <button className="btn btn-sm btn-accent" onClick={saveAll}>
            {lang === 'en' ? 'Download All' : '下载全部'}
          </button>
          <button className="btn btn-sm btn-ghost" onClick={close}>
            {lang === 'en' ? 'Close' : '关闭'}
          </button>
        </span>
      </div>
      <div className="row wrap" style={{ gap: 6, marginBottom: 10 }}>
        {data.themes.map((t) => (
          <button
            key={t.key}
            className={`btn btn-sm ${t.key === theme ? 'btn-accent' : 'btn-ghost'}`}
            onClick={() => setTheme(t.key)}
          >
            {lang === 'en' ? (THEME_NAMES_EN[t.key] || t.name) : t.name}
          </button>
        ))}
      </div>
      <div className="small muted" style={{ marginBottom: 10, lineHeight: 1.6 }}>
        {lang === 'en'
          ? `Each card includes "${AIGC_LABEL}" label with generator metadata embedded. Please do not remove this label. Click below each card to save individually.`
          : `每张图左下角都带「${AIGC_LABEL}」标识，且 PNG 元数据里写了生成信息（《标识办法》第四、五条）。请勿删除标识。单张点图片下方按钮即可单独存。`}
        <br />
        <b>Beta：</b>{betaHint}
      </div>
      <div className="row wrap" style={{ gap: 10 }}>
        {cards.map((c, i) => (
          <div key={i} className="stack" style={{ gap: 4 }}>
            <canvas
              ref={attach(i)}
              width={CARD_W}
              height={CARD_H}
              style={{ width: 150, height: 200, border: '1px solid var(--border)', borderRadius: 6, background: c.bg }}
            />
            <button className="btn btn-sm btn-ghost" onClick={() => save(i)}>
              {lang === 'en' ? `Save #${i + 1}` : `存第 ${i + 1} 张`}
            </button>
          </div>
        ))}
      </div>
      {msg && <div className="small" style={{ marginTop: 8, color: 'var(--green)' }}>{msg}</div>}
    </div>
    </Overlay>
  );
}
