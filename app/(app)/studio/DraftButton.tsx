'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/components/icons';
import { actDraft } from './actions';

// 「AI 生成初稿」+ 深度模式开关。
//
// 深度模式 = 两段式（先只列要点大纲，再照着你自己的原句样本写成成稿），去 AI 味效果最好，
// **但是两次真实调用**。所以它是一个要用户自己勾的选项，不是默认值——
// 替用户悄悄花两份配额，比 AI 味本身更糟。按钮上直接写明「2 次额度」，不藏在 tooltip 里。
// topicId：从选题引擎「去工坊起这篇稿」带过来、且还没起过稿的那条选题。
// 有它的时候 draftId 一定是 null（见 studio/page.tsx），这一版就落在这条选题上。
//
// 普通模式走**流式**（/api/studio/draft/stream）：边写边显示。
// 深度模式仍走 server action —— 它中间那段是大纲，流式显示大纲会让人以为那就是成稿。
// 流式失败（网关不支持 SSE、反代缓冲、模型不支持流）**自动回落**到 action，
// 用户最多是少了逐字效果，不会因此起不了稿。
export function DraftButton({ draftId, topicId }: { draftId: string | null; topicId?: string }) {
  const [deep, setDeep] = useState(false);
  const [pending, start] = useTransition();
  const [streaming, setStreaming] = useState(false);
  const [preview, setPreview] = useState(''); // 流式增量，仅用于「正在写」的即时反馈
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const router = useRouter();
  const previewRef = useRef<HTMLDivElement>(null);

  function finish(newDraftId: string | undefined, note: string) {
    setMsg(note);
    setPreview('');
    if (newDraftId && newDraftId !== draftId) router.push(`/studio?draft=${newDraftId}`);
    router.refresh();
  }

  function runAction(note = '已生成一版初稿') {
    start(async () => {
      const r = await actDraft(draftId, { deep, topicId });
      if (!r.ok) {
        setErr(r.error ?? '生成失败');
        setPreview('');
        return;
      }
      finish(
        r.draftId,
        (r.stages === 2 ? '深度模式已生成（大纲 → 成稿）' : note) + (r.warning ? `｜⚠️ ${r.warning}` : ''),
      );
    });
  }

  async function runStream() {
    setStreaming(true);
    setPreview('');
    let seenDelta = false;
    let landedDraftId: string | undefined;
    try {
      const res = await fetch('/api/studio/draft/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draftId, topicId }),
      });
      if (!res.ok || !res.body) {
        // 4xx/5xx 是**设计内拒绝**（配额用尽/没选题/无权限），如实展示，不要回落重跑一次白烧额度
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setErr(data.error ?? '生成失败');
        setStreaming(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // SSE 以空行分帧
        const frames = buf.split('\n\n');
        buf = frames.pop() ?? '';
        for (const frame of frames) {
          const evLine = frame.split('\n').find((l) => l.startsWith('event: '));
          const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
          if (!dataLine) continue;
          const ev = evLine?.slice(7).trim() ?? 'message';
          let data: unknown;
          try {
            data = JSON.parse(dataLine.slice(6));
          } catch {
            continue;
          }
          if (ev === 'meta') {
            landedDraftId = (data as { draftId?: string }).draftId;
          } else if (ev === 'delta') {
            seenDelta = true;
            setPreview((p) => p + String(data));
            previewRef.current?.scrollTo({ top: previewRef.current.scrollHeight });
          } else if (ev === 'done') {
            const d = data as { draftId?: string; seq?: number; warning?: string };
            setStreaming(false);
            finish(d.draftId ?? landedDraftId, `已生成第 ${d.seq} 版初稿${d.warning ? `｜⚠️ ${d.warning}` : ''}`);
            return;
          } else if (ev === 'error') {
            setStreaming(false);
            setErr((data as { error?: string }).error ?? '生成失败');
            setPreview('');
            return;
          }
        }
      }
      // 流断了却没收到 done：内容可能已在服务端落库（落库发生在服务端读完之后），
      // 所以这里只刷新页面让用户看真实结果，**不重跑**——重跑就是再烧一次额度。
      setStreaming(false);
      if (seenDelta) {
        finish(landedDraftId, '连接中断，已刷新页面显示实际保存到的版本');
      } else {
        setErr('生成连接中断，请重试');
        setPreview('');
      }
    } catch {
      // 网络层直接抛（浏览器不支持流/被代理断开）→ 回落非流式，用户仍能拿到稿子
      setStreaming(false);
      runAction('已生成一版初稿（本次未用流式）');
    }
  }

  function run() {
    setErr('');
    setMsg('');
    if (deep) runAction();
    else void runStream();
  }

  const busy = pending || streaming;

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <label
          className="row small muted"
          style={{ gap: 4, alignItems: 'center', cursor: 'pointer', whiteSpace: 'nowrap' }}
          title="两段式生成：先只想清楚说什么，再照着你自己的原句样本写成稿。去 AI 味效果最好，代价是两次调用。"
        >
          <input type="checkbox" checked={deep} onChange={(e) => setDeep(e.target.checked)} disabled={busy} />
          深度模式<span style={{ fontSize: 11 }}>（2 次额度）</span>
        </label>
        <button className="btn btn-primary btn-sm" onClick={run} disabled={busy}>
          <Icon.sparkles size={14} />
          {busy ? (deep ? '深度起草中（两步）…' : streaming ? '正在写…' : 'AI 起草中…') : 'AI 生成初稿'}
        </button>
        {msg && <span className="small" style={{ color: 'var(--green)' }}>{msg}</span>}
        {err && <span className="small" style={{ color: 'var(--red)' }}>{err}</span>}
      </div>

      {/* 流式预览：只是「正在写」的即时反馈，最终以落库后的版本为准（写完即清空并刷新页面）。
          这块长在页头动作栏里，不给宽度就会被挤成一条二十来字符的细缝——逐字效果反而看不清；
          （原来写的 --line / --bg-2 两个变量在 globals.css 里并不存在，等于没边框也没底色） */}
      {streaming && (
        <div
          ref={previewRef}
          className="small"
          style={{
            width: 'min(520px, 68vw)',
            maxHeight: 220,
            overflowY: 'auto',
            whiteSpace: 'pre-wrap',
            textAlign: 'left',
            padding: 12,
            borderRadius: 8,
            border: '1px solid var(--border)',
            background: 'var(--surface-2)',
            lineHeight: 1.7,
          }}
        >
          {preview || '模型正在起笔…'}
          <span style={{ opacity: 0.5 }}>▌</span>
        </div>
      )}
    </div>
  );
}
