'use client';

import { useState, useTransition, useRef, useEffect, useCallback } from 'react';
import { Overlay } from '@/components/Overlay';
import { actExportCards } from './actions';
import { CARD_W, CARD_H, DEFAULT_CARD_THEME, type Card, type CardThemeKey } from '@/lib/deliverable/card';
import { drawCard, cardToPng } from '@/lib/deliverable/canvas';
import { AIGC_LABEL } from '@/lib/compliance/aigc';

// 小红书图文卡导出：服务端算排版（纯函数、可单测），这里只把绘制指令描到 canvas 上再存成 PNG。
//
// 为什么图片这一步放在浏览器：服务端出图要么装 chromium（几百 MB + 内存），要么装原生渲染库和中文字体；
// 而 canvas 在每个用户浏览器里都现成，且中文字体用的就是用户系统里那套。
// 代价写在明处：不同系统字体不同，同一张卡在 Mac / Windows 上字形会有细微差别。
//
// 客户端只做两件事：描图、下载。**不做任何排版决策，也不碰 AIGC 标识**——
// 标识是服务端排版指令里就有的一条 text 指令，这里没有能删掉它的路径。

type Loaded = {
  byTheme: Record<CardThemeKey, Card[]>;
  themes: { key: CardThemeKey; name: string }[];
};

// Beta 提示：本地排版这条路刚上线，单测与浏览器出图都验过，但**没有经过大量真实稿件的真机验证**。
// 排版失手的典型表现是「字挤到一起 / 该翻页没翻」，用户下载前扫一眼缩略图就能发现，代价很低；
// 与其等攒够验证再上，不如把不确定性如实标出来。等真机跑过一批稿子再摘掉这个角标。
const BETA_HINT = '本地排版新功能，尚未经过大量真实稿件验证。下载前请扫一眼缩略图，遇到排版异常欢迎反馈。';

export function CardExport({ draftId }: { draftId: string }) {
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
    a.download = `${title || '图文卡'}-${theme}-${String(index + 1).padStart(2, '0')}.png`;
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
    setMsg(`已导出 ${cards.length} 张`);
  }

  if (!cards || !data) {
    return (
      <span className="row" style={{ gap: 6 }}>
        <button className="btn btn-sm" onClick={load} disabled={pending} title={BETA_HINT}>
          {pending ? '排版中…' : '导出图文卡'}
        </button>
        <span className="badge badge-amber" title={BETA_HINT}>Beta</span>
        {msg && <span className="small" style={{ color: 'var(--red)' }}>{msg}</span>}
      </span>
    );
  }

  // 缩略图面板走弹层：它是一块含 4~9 张 150×200 画布的大面板，而触发按钮和其他交付动作
  // 挤在同一行里。就地展开会把那一行整个撑开成半屏高的图墙，旁边的按钮全被推走。
  return (
    <Overlay label="图文卡导出" onClose={close}>
    <div
      className="card"
      style={{ padding: 20, background: 'var(--surface)', width: 720, maxWidth: '94vw', maxHeight: '88vh', overflowY: 'auto' }}
    >
      <div className="row-between" style={{ marginBottom: 10 }}>
        <span className="row" style={{ gap: 6 }}>
          <b className="small">图文卡 · {cards.length} 张（3:4，1080×1440）</b>
          <span className="badge badge-amber" title={BETA_HINT}>Beta</span>
        </span>
        <span className="row" style={{ gap: 6 }}>
          <button className="btn btn-sm btn-accent" onClick={saveAll}>下载全部</button>
          <button className="btn btn-sm btn-ghost" onClick={close}>关闭</button>
        </span>
      </div>
      <div className="row wrap" style={{ gap: 6, marginBottom: 10 }}>
        {data.themes.map((t) => (
          <button
            key={t.key}
            className={`btn btn-sm ${t.key === theme ? 'btn-accent' : 'btn-ghost'}`}
            onClick={() => setTheme(t.key)}
          >
            {t.name}
          </button>
        ))}
      </div>
      <div className="small muted" style={{ marginBottom: 10, lineHeight: 1.6 }}>
        每张图左下角都带「{AIGC_LABEL}」标识，且 PNG 元数据里写了生成信息（《标识办法》第四、五条）。请勿删除标识。
        单张点图片下方按钮即可单独存。
        <br />
        <b>Beta：</b>{BETA_HINT}
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
            <button className="btn btn-sm btn-ghost" onClick={() => save(i)}>存第 {i + 1} 张</button>
          </div>
        ))}
      </div>
      {msg && <div className="small" style={{ marginTop: 8, color: 'var(--green)' }}>{msg}</div>}
    </div>
    </Overlay>
  );
}
