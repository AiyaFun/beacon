'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui';

// 视频拆解入口：选一个本地视频（或贴一条能直接播放的直链）→ 拆出钩子、节奏时间线、爆点。
//
// 【为什么是 SSE 而不是普通 fetch】视频推理是分钟级的，生产走 nginx 反代，
// 安静等待 90 秒的普通请求会被 proxy_read_timeout 掐成 504——而那时方舟的钱已经花了。
// 接口每 10 秒发一次心跳，这里顺手把它变成「还在跑」的可见状态：分钟级的等待里，
// 用户最需要的不是进度百分比，是「它没死」。

const MAX_MB = 25;

type Phase = { kind: 'idle' } | { kind: 'running'; hint: string; secs: number } | { kind: 'error'; msg: string };

export function VideoAnalyzeCard({ hasArkChannel }: { hasArkChannel: boolean }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<'rival' | 'self'>('rival');
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const running = phase.kind === 'running';

  async function run(body: FormData | string) {
    setPhase({ kind: 'running', hint: '正在提交…', secs: 0 });
    const started = Date.now();
    const tick = setInterval(
      () =>
        setPhase((p) => (p.kind === 'running' ? { ...p, secs: Math.floor((Date.now() - started) / 1000) } : p)),
      1000,
    );
    try {
      const res = await fetch('/api/video/analyze', {
        method: 'POST',
        ...(typeof body === 'string'
          ? { headers: { 'Content-Type': 'application/json' }, body }
          : { body }),
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({ error: '请求失败' }));
        throw new Error(j.error ?? '请求失败');
      }
      // SSE 逐块读。事件之间用空行分隔，跨块切割要靠 buffer 累积——
      // 不累积的话一个刚好被切成两半的 JSON 会静默丢事件。
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
          const dataLine = /data:\s*(.*)/.exec(c)?.[1];
          if (!ev || !dataLine) continue;
          const data = JSON.parse(dataLine) as Record<string, unknown>;
          if (ev === 'start') setPhase((p) => (p.kind === 'running' ? { ...p, hint: String(data.hint ?? '') } : p));
          if (ev === 'failed') throw new Error(String(data.error ?? '分析失败'));
          if (ev === 'done') {
            clearInterval(tick);
            setPhase({ kind: 'idle' });
            setUrl('');
            setNote('');
            if (fileRef.current) fileRef.current.value = '';
            router.refresh(); // 新条目已在库里，刷出来
            return;
          }
        }
      }
      throw new Error('连接中断，分析可能仍在服务端跑完并入库——刷新页面看看。');
    } catch (e) {
      setPhase({ kind: 'error', msg: (e as Error).message });
    } finally {
      clearInterval(tick);
    }
  }

  function submitFile() {
    const f = fileRef.current?.files?.[0];
    if (!f) return setPhase({ kind: 'error', msg: '先选一个视频文件' });
    if (f.size > MAX_MB * 1024 * 1024) {
      return setPhase({ kind: 'error', msg: `视频 ${(f.size / 1024 / 1024).toFixed(1)}MB，超过 ${MAX_MB}MB 上限。先压一下再传。` });
    }
    const fd = new FormData();
    fd.set('file', f);
    fd.set('mode', mode);
    if (note) fd.set('note', note);
    void run(fd);
  }

  return (
    <Card title="拆解一条视频" sub="逐帧看完出结论：开头钩子、节奏时间线、它凭什么跑起来" style={{ marginBottom: 16 }}>
      <div className="small muted" style={{ marginBottom: 10, lineHeight: 1.6 }}>
        ℹ️ 豆包视频理解是<b>抽帧看画面</b>的，<b>听不到声音</b>——有硬字幕的视频能把口播读出来，
        纯语音无字幕的读不到。<br />
        想连口播一起拆：在作品页上用采集助手右键「一键拆解」，它会顺手把<b>平台自己的字幕轨</b>
        （带时间戳的原文）取回来，比听音轨还准。
      </div>
      {!hasArkChannel && (
        <div className="alert-gradient-amber small" style={{ padding: '10px 14px', marginBottom: 12, lineHeight: 1.7 }}>
          视频拆解要用<b>你自己的火山方舟 API Key</b>——一次视频推理抵几十次文本调用，平台不垫付这笔钱。
          到 <a href="/settings">设置 → 模型渠道</a> 加一个「火山引擎 豆包」渠道即可。
          <div style={{ marginTop: 6 }}>
            模型名推荐填 <code className="mono">doubao-seed-evolving</code>（已实测跑通），
            并记得先在方舟控制台<b>开通</b>它。<br />
            ⚠️ <code className="mono">doubao-pro</code> 这类纯文本的不行；
            <code className="mono">doubao-seedance</code> 是<b>文生视频</b>不是看视频，填错很贵。
            若报模型不存在，改填控制台「推理接入点」里 <code className="mono">ep-</code> 开头的 ID。
          </div>
        </div>
      )}

      <div className="stack" style={{ gap: 12 }}>
        <div className="row wrap small" style={{ gap: 12, alignItems: 'center' }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="radio" checked={mode === 'rival'} onChange={() => setMode('rival')} disabled={running} />
            别人的作品（学方法）
          </label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="radio" checked={mode === 'self'} onChange={() => setMode('self')} disabled={running} />
            我自己的作品（找改进点）
          </label>
        </div>

        <div>
          <div className="small muted" style={{ marginBottom: 6 }}>
            ① 上传本地视频（{MAX_MB}MB 以内，mp4 / mov / mkv / webm）
          </div>
          <div className="row wrap" style={{ gap: 8 }}>
            <input ref={fileRef} type="file" accept="video/mp4,video/quicktime,video/x-matroska,video/webm" disabled={running} />
            <button className="btn" onClick={submitFile} disabled={running || !hasArkChannel}>
              分析这个文件
            </button>
          </div>
        </div>

        <div>
          <div className="small muted" style={{ marginBottom: 6 }}>
            ② 或贴一条<b>能直接播放的视频直链</b>（.mp4 之类）
          </div>
          <div className="row wrap" style={{ gap: 8 }}>
            <input
              className="input"
              style={{ flex: 1 }}
              placeholder="https://…/video.mp4"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={running}
            />
            <button
              className="btn"
              onClick={() => run(JSON.stringify({ url: url.trim(), mode, note: note || undefined }))}
              disabled={running || !url.trim() || !hasArkChannel}
            >
              分析这条链接
            </button>
          </div>
          <div className="small muted" style={{ marginTop: 6, lineHeight: 1.6 }}>
            ⚠️ 抖音 / B站 / 小红书 / 视频号 / YouTube 的<b>作品页链接不行</b>——那是网页不是视频文件，
            平台的播放地址带鉴权和防盗链，我们不去解也不去绕。这些请<b>自己下载后走上面的上传</b>。
          </div>
        </div>

        <input
          className="input"
          placeholder="想重点看什么？（选填，例如「它的前 3 秒怎么留人」）"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={running}
        />

        {running && (
          <div className="alert-gradient-blue small" style={{ padding: '10px 14px' }}>
            ⏳ {phase.hint || '正在分析'}…已等待 {phase.secs}s。视频推理通常 2–5 分钟（10 秒的片子实测约 2 分钟），这个页面别关。
          </div>
        )}
        {phase.kind === 'error' && (
          <div className="alert-gradient-amber small" style={{ padding: '10px 14px', lineHeight: 1.6 }}>⚠️ {phase.msg}</div>
        )}
      </div>
    </Card>
  );
}
