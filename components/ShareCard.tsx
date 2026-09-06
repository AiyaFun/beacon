'use client';

import { useEffect, useRef, useState } from 'react';
import type { BattleReport } from '@/lib/battle/report';
import { fmtNum } from '@/lib/format';
import { beijingDayKey } from '@/lib/beijing';

// 本周作战报告的分享图（2026-09-05 增长：可分享产物）。
//
// 【为什么在浏览器里画】服务端出图要一份中文字体文件（几 MB，仓库里没有），而浏览器有系统字体。
// 画的全是报告里已经算好的数：指标 null 印「—」不印 0（与 BattleReport 同口径）。
// 1080×1350（3:4）是小红书/朋友圈最常见的竖图比例。底部带产品名与站点地址，不带二维码
//（不引依赖），复制链接按钮给的是公开的今日选题榜。
const W = 1080;
const H = 1350;

function metricText(m: BattleReport['metrics'][number]): string {
  if (m.value === null) return '—';
  if (m.kind === 'wan') return m.value >= 10000 ? `${(m.value / 10000).toFixed(1)}w` : fmtNum(m.value);
  if (m.kind === 'pct') return `${m.value.toFixed(1)}%`;
  return fmtNum(m.value);
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const ch of text) {
    if (ctx.measureText(line + ch).width > maxWidth) {
      out.push(line);
      line = ch;
      if (out.length === maxLines) break;
    } else line += ch;
  }
  if (out.length < maxLines && line) out.push(line);
  if (out.length === maxLines && ctx.measureText(text).width > maxWidth * maxLines) out[maxLines - 1] = out[maxLines - 1].slice(0, -1) + '…';
  return out;
}

export function ShareCard({ report, accountName, site, lang }: { report: BattleReport; accountName: string; site: string; lang: string }) {
  const en = lang === 'en';
  const ref = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const font = (w: number, s: number) => `${w} ${s}px -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`;
    ctx.fillStyle = '#0f1626';
    ctx.fillRect(0, 0, W, H);
    // 顶部品牌条
    ctx.fillStyle = '#ff6a42';
    ctx.fillRect(0, 0, W, 14);
    ctx.fillStyle = '#ffffff';
    ctx.font = font(800, 40);
    ctx.fillText(en ? 'Weekly battle' : '本周作战', 72, 120);
    ctx.fillStyle = '#b7c4d6';
    ctx.font = font(500, 26);
    ctx.fillText(`${accountName} · ${beijingDayKey()}`, 72, 166);

    // 四个指标
    const cols = report.metrics.slice(0, 4);
    const cw = (W - 144 - 24 * 3) / 4;
    cols.forEach((m, i) => {
      const x = 72 + i * (cw + 24);
      ctx.fillStyle = '#171f2e';
      ctx.beginPath();
      ctx.roundRect(x, 210, cw, 140, 16);
      ctx.fill();
      ctx.fillStyle = '#7f8da8';
      ctx.font = font(500, 22);
      ctx.fillText(m.label, x + 20, 250);
      ctx.fillStyle = '#ffffff';
      ctx.font = font(800, 44);
      ctx.fillText(metricText(m), x + 20, 312);
    });

    // 三条选题
    ctx.fillStyle = '#ffffff';
    ctx.font = font(700, 30);
    ctx.fillText(en ? 'Top topics this week' : '这周排在前面的选题', 72, 430);
    let y = 470;
    const ideas = report.ideas.slice(0, 3);
    if (ideas.length === 0) {
      ctx.fillStyle = '#7f8da8';
      ctx.font = font(500, 26);
      ctx.fillText(en ? 'No recommendations yet.' : '还没有推荐——先跑一次选题引擎。', 72, y + 40);
      y += 90;
    }
    ideas.forEach((idea, i) => {
      ctx.fillStyle = '#171f2e';
      ctx.beginPath();
      ctx.roundRect(72, y, W - 144, 200, 18);
      ctx.fill();
      ctx.fillStyle = '#ff6a42';
      ctx.font = font(800, 34);
      ctx.fillText(String(i + 1), 100, y + 58);
      ctx.fillStyle = '#ffffff';
      ctx.font = font(700, 30);
      wrap(ctx, idea.title, W - 144 - 90, 2).forEach((l, k) => ctx.fillText(l, 150, y + 58 + k * 40));
      ctx.fillStyle = '#b7c4d6';
      ctx.font = font(500, 24);
      wrap(ctx, idea.angle || idea.reason || '', W - 144 - 90, 2).forEach((l, k) => ctx.fillText(l, 150, y + 140 + k * 32));
      y += 224;
    });

    // 页脚
    ctx.fillStyle = '#243149';
    ctx.fillRect(72, H - 150, W - 144, 1);
    ctx.fillStyle = '#ffffff';
    ctx.font = font(700, 30);
    ctx.fillText(en ? 'Beacon · Know what to make before you write.' : '烽火台 · 先知道做什么，再谈怎么写', 72, H - 96);
    ctx.fillStyle = '#7f8da8';
    ctx.font = font(500, 24);
    ctx.fillText(site.replace(/^https?:\/\//, ''), 72, H - 54);
    setReady(true);
  }, [report, accountName, site, en]);

  function download() {
    const c = ref.current;
    if (!c) return;
    const a = document.createElement('a');
    a.href = c.toDataURL('image/png');
    a.download = `beacon-weekly-${beijingDayKey()}.png`;
    a.click();
  }
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(`${site}/topics-today`);
      setMsg(en ? 'Link copied' : '链接已复制');
      setTimeout(() => setMsg(''), 2000);
    } catch {
      setMsg(`${site}/topics-today`);
    }
  }

  return (
    <div className="card" style={{ padding: 16, marginTop: 16 }}>
      <div className="row-between" style={{ gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
        <div>
          <b>{en ? 'Share this week' : '把这周晒出去'}</b>
          <div className="small muted">{en ? '3:4 image for Xiaohongshu / Moments. Numbers are exactly what the report shows; missing metrics print as —.' : '3:4 竖图，适合小红书 / 朋友圈。数字与报告完全一致，拿不到的指标印「—」。'}</div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button type="button" className="btn btn-sm btn-primary" onClick={download} disabled={!ready}>{en ? 'Download image' : '下载分享图'}</button>
          <button type="button" className="btn btn-sm" onClick={copyLink}>{en ? 'Copy public link' : '复制公开链接'}</button>
          {msg && <span className="small muted">{msg}</span>}
        </div>
      </div>
      <canvas ref={ref} width={W} height={H} style={{ width: '100%', maxWidth: 360, height: 'auto', borderRadius: 12, border: '1px solid var(--border)' }} />
    </div>
  );
}
