'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Overlay } from './Overlay';

// 报告里「起稿」的就地执行面板 —— 点了不跳走，在报告上原地把初稿写出来。
//
// 【复用什么】走的就是创作工坊「AI 生成初稿」那条**流式路由** /api/studio/draft/stream：
// 同一套 draft-core（定位/上下文/prompt/落库），两条路写出来的东西必须一致。
// 服务端在流读完后自己落库（DraftVersion），并且 resolveDraftTarget 会把这条选题置为
// drafting —— 于是起完稿它就退出 recommended，下次报告不再冒出来，状态迁移不用我们额外做。
//
// 【为什么用居中 Overlay 而不是右抽屉】项目的硬规矩：弹层必须走 components/Overlay.tsx
// （portal 到 body + 锁滚动 + Esc）。就地渲染的 fixed 遮罩会被 .card:hover 的 transform
// 关进卡片里。为还原原型的右抽屉去重写这套 portal 机制、还撞那个裁剪 bug，不值得。
//
// 【诚实】没配生成 Key / 配额用尽时流式路由回 4xx/5xx 带原文，这里红字如实展示并给去配 Key
// 的入口，不假装在转圈；已生成但落库失败也如实说（额度已经花了）。

type Done = { draftId?: string; seq?: number; warning?: string };

export function BattleStartDraft({ topicId, title }: { topicId: string; title: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [preview, setPreview] = useState('');
  const [done, setDone] = useState<Done | null>(null);
  const [err, setErr] = useState('');
  const [finished, setFinished] = useState(false); // 起完稿后按钮变「已起稿」
  const previewRef = useRef<HTMLDivElement>(null);
  // 已经起过一版后，这里存住那份草稿的 id。「再写一版」必须带 draftId 复投——
  // ⚠️ 只带 topicId 再投一次会**新建第二份草稿**（resolveDraftTarget 的副作用，
  // 见 lib/studio/draft-core.ts 文件头警告）。带 draftId 才是往同一份加新版本。
  const draftIdRef = useRef<string | undefined>(undefined);

  async function run() {
    setOpen(true);
    setStreaming(true);
    setPreview('');
    setDone(null);
    setErr('');
    let landedDraftId: string | undefined = draftIdRef.current;
    try {
      const res = await fetch('/api/studio/draft/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // 复用已有草稿则投 draftId（加版本），首次才投 topicId（建草稿并置选题 drafting）
        body: JSON.stringify(draftIdRef.current ? { draftId: draftIdRef.current } : { topicId }),
      });
      if (!res.ok || !res.body) {
        // 设计内拒绝（没配 Key / 配额 / 无权限）：如实展示，不回落重跑白烧额度
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setErr(data.error ?? '生成失败');
        setStreaming(false);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done: rdone, value } = await reader.read();
        if (rdone) break;
        buf += decoder.decode(value, { stream: true });
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
            setPreview((p) => p + String(data));
            requestAnimationFrame(() => previewRef.current?.scrollTo({ top: previewRef.current.scrollHeight }));
          } else if (ev === 'done') {
            const d = data as Done;
            const did = d.draftId ?? landedDraftId;
            draftIdRef.current = did; // 记住草稿 id，供「再写一版」复投
            setStreaming(false);
            setDone({ draftId: did, seq: d.seq, warning: d.warning });
            setFinished(true);
            return;
          } else if (ev === 'error') {
            setStreaming(false);
            setErr((data as { error?: string }).error ?? '生成失败');
            setPreview('');
            return;
          }
        }
      }
      // 流结束却没收到 done：也当失败处理，别让面板卡在「正在写」
      if (!done) {
        setStreaming(false);
        if (!err) setErr('生成中断，请重试');
      }
    } catch (e) {
      setStreaming(false);
      setErr((e as Error).message || '网络中断，请重试');
    }
  }

  const draftId = done?.draftId;
  const keyIssue = /Key|密钥|配额|quota|渠道|模型/.test(err);

  return (
    <>
      {finished ? (
        <div className="stack" style={{ gap: 6, minWidth: 128 }}>
          <span className="badge badge-green" style={{ justifyContent: 'center' }}>✓ 已起稿</span>
          {draftId ? (
            <a href={`/studio?draft=${draftId}`} className="btn btn-sm btn-primary" style={{ width: '100%' }}>去精修 →</a>
          ) : null}
        </div>
      ) : (
        <button type="button" className="btn btn-sm btn-primary" style={{ width: '100%' }} onClick={run}>✎ 起稿 →</button>
      )}

      {open && (
        <Overlay onClose={() => setOpen(false)} label="就地起稿" closable={!streaming}>
          <div className="card" style={{ width: 'min(560px, 94vw)', maxHeight: '86vh', display: 'flex', flexDirection: 'column' }}>
            <div className="row-between" style={{ marginBottom: 6 }}>
              <div className="card-title">✎ 就地起稿</div>
              {!streaming && (
                <button className="btn btn-sm btn-ghost" onClick={() => setOpen(false)}>✕</button>
              )}
            </div>
            <div className="small muted" style={{ marginBottom: 12 }}>
              选题 · <b style={{ color: 'var(--text)' }}>{title}</b> ｜ 走你的人设与原句风格，写完自动存进草稿箱
            </div>

            {err ? (
              <div className="stack" style={{ gap: 10 }}>
                <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--red)', background: 'var(--red-soft)', border: '1px solid var(--red-soft)', borderRadius: 10, padding: '11px 13px' }}>{err}</div>
                {keyIssue && (
                  <a href="/settings/keys" className="btn btn-sm">去配模型 Key →</a>
                )}
                <button className="btn btn-sm" onClick={run}>重试</button>
              </div>
            ) : (
              <>
                <div
                  ref={previewRef}
                  style={{
                    flex: 1, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 10,
                    padding: 14, fontSize: 13, lineHeight: 1.85, color: 'var(--text-2)',
                    whiteSpace: 'pre-wrap', minHeight: 200, background: 'var(--surface)',
                  }}
                >
                  {preview || <span className="muted">正在按你的风格起草…</span>}
                  {streaming && <span className="battle-caret">▍</span>}
                </div>

                {done && (
                  <div className="small" style={{ marginTop: 10, color: 'var(--green)' }}>
                    ✓ 已生成第 {done.seq} 版初稿，存进草稿箱
                    {done.warning && <span style={{ color: 'var(--amber)' }}>｜⚠️ {done.warning}</span>}
                  </div>
                )}

                <div className="row" style={{ gap: 8, marginTop: 14 }}>
                  {done ? (
                    <>
                      {draftId && (
                        <a href={`/studio?draft=${draftId}`} className="btn btn-sm btn-primary" style={{ flex: 1, justifyContent: 'center' }}>去编辑器精修 →</a>
                      )}
                      {/* 再 roll 一版：不满意就地重来，不用跳去编辑器。复投 draftId → 同一份草稿加新版本 */}
                      <button className="btn btn-sm" onClick={run} title="按同一选题再生成一版，存为新版本">↻ 再写一版</button>
                      <button className="btn btn-sm btn-ghost" onClick={() => setOpen(false)}>完成</button>
                    </>
                  ) : (
                    <button className="btn btn-sm" disabled style={{ flex: 1, justifyContent: 'center' }}>
                      {streaming ? '正在写…' : '准备中…'}
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </Overlay>
      )}
    </>
  );
}
