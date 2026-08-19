'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui';
import { Icon } from '@/components/icons';

// 视频拆解入口：选一个本地视频（或贴一条能直接播放的直链）→ 拆出钩子、节奏时间线、爆点。
//
// 【为什么是 SSE 而不是普通 fetch】视频推理是分钟级的，生产走 nginx 反代，
// 安静等待 90 秒的普通请求会被 proxy_read_timeout 掐成 504——而那时方舟的钱已经花了。
// 接口每 10 秒发一次心跳，这里顺手把它变成「还在跑」的可见状态：分钟级的等待里，
// 用户最需要的不是进度百分比，是「它没死」。

const MAX_MB = 50;

type Phase = { kind: 'idle' } | { kind: 'running'; hint: string; secs: number } | { kind: 'error'; msg: string };

export function VideoAnalyzeCard({ hasArkChannel }: { hasArkChannel: boolean }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<'rival' | 'self'>('rival');
  const [inputTab, setInputTab] = useState<'file' | 'url'>('file');
  const [selectedFile, setSelectedFile] = useState<{ name: string; size: number } | null>(null);
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [showTips, setShowTips] = useState(false);
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
      // SSE 逐块读。事件之间用空行分隔，跨块切割要靠 buffer 累积
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
            setSelectedFile(null);
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

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) {
      setSelectedFile({ name: f.name, size: f.size });
      setPhase({ kind: 'idle' });
    } else {
      setSelectedFile(null);
    }
  }

  function submitFile() {
    const f = fileRef.current?.files?.[0];
    if (!f) return setPhase({ kind: 'error', msg: '请先选择或拖入一个视频文件' });
    if (f.size > MAX_MB * 1024 * 1024) {
      const mb = (f.size / 1024 / 1024).toFixed(1);
      return setPhase({
        kind: 'error',
        msg: `当前视频大小为 ${mb}MB，超过网页直接上传上限（${MAX_MB}MB）。建议：① 用剪映/Handbrake 导出为 720p 码率轻松压至 10MB 内（AI 抽帧不影响分析）；② 或上传至阿里云/腾讯云 OSS / 对象存储获取直链，切至右侧「视频直链 URL」解析。`,
      });
    }
    const fd = new FormData();
    fd.set('file', f);
    fd.set('mode', mode);
    if (note) fd.set('note', note);
    void run(fd);
  }

  function submitUrl() {
    if (!url.trim()) return setPhase({ kind: 'error', msg: '请先输入有效的视频直链 URL' });
    void run(JSON.stringify({ url: url.trim(), mode, note: note || undefined }));
  }

  return (
    <Card
      title={
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <Icon.video size={20} style={{ color: 'var(--primary)' }} />
          <span>AI 视频画面级深度拆解</span>
        </div>
      }
      sub="逐帧理解视觉画面：自动提炼开篇钩子、高光时刻、叙事节奏时间轴"
      style={{ marginBottom: 16 }}
    >
      {/* 校验通道提醒 */}
      {!hasArkChannel && (
        <div className="alert-gradient-amber small" style={{ padding: '12px 16px', marginBottom: 14, borderRadius: 8 }}>
          <div className="row-between wrap" style={{ gap: 8 }}>
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              <Icon.info size={18} style={{ flexShrink: 0 }} />
              <span>
                视频拆解需使用<b>你自己配置的火山方舟 API Key</b>（画面推理消耗较大，平台不统一垫付）。
              </span>
            </div>
            <a href="/settings" className="btn btn-sm" style={{ padding: '2px 10px' }}>
              去设置渠道 →
            </a>
          </div>
          <div style={{ marginTop: 8, fontSize: '0.85rem', lineHeight: 1.6 }} className="muted">
            到 <a href="/settings/keys">接入与密钥</a> 添加「火山引擎 豆包」渠道。推荐模型名填{' '}
            <code className="mono">doubao-seed-evolving</code>，并在方舟控制台开通接入点。
          </div>
        </div>
      )}

      {/* 拆解目标模式 Segmented Control */}
      <div className="stack" style={{ gap: 14 }}>
        <div className="row wrap" style={{ gap: 10, alignItems: 'center' }}>
          <span className="small muted" style={{ fontWeight: 600 }}>拆解目标：</span>
          <div className="row" style={{ gap: 6, background: 'var(--surface-2)', padding: 3, borderRadius: 8, border: '1px solid var(--border)' }}>
            <button
              className={`btn btn-sm ${mode === 'rival' ? 'btn-primary' : 'btn-ghost'}`}
              style={{ border: 'none', borderRadius: 6 }}
              onClick={() => setMode('rival')}
              disabled={running}
            >
              🎯 别人的作品（拆解解法 / 爆款逻辑）
            </button>
            <button
              className={`btn btn-sm ${mode === 'self' ? 'btn-primary' : 'btn-ghost'}`}
              style={{ border: 'none', borderRadius: 6 }}
              onClick={() => setMode('self')}
              disabled={running}
            >
              🛠️ 我自己的作品（诊断复盘 / 找改进点）
            </button>
          </div>
        </div>

        {/* 输入方式 Tab 分段切换 */}
        <div>
          <div className="row wrap" style={{ gap: 12, borderBottom: '1px solid var(--border)', paddingBottom: 8, marginBottom: 12 }}>
            <button
              className={`btn btn-sm ${inputTab === 'file' ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setInputTab('file')}
              disabled={running}
            >
              <Icon.upload size={14} />
              上传本地视频文件 (≤{MAX_MB}MB)
            </button>
            <button
              className={`btn btn-sm ${inputTab === 'url' ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setInputTab('url')}
              disabled={running}
            >
              <Icon.link size={14} />
              视频直链 URL 解析
            </button>
            <button
              className="btn btn-sm btn-ghost small muted"
              style={{ marginLeft: 'auto' }}
              onClick={() => setShowTips(!showTips)}
            >
              <Icon.help size={14} />
              {showTips ? '收起拆解说明' : '拆解说明'}
            </button>
          </div>

          {showTips && (
            <div className="small muted" style={{ padding: 10, borderRadius: 8, background: 'var(--surface-2)', marginBottom: 12, lineHeight: 1.65 }}>
              💡 <b>提示：</b>豆包视频模型通过<b>图像抽帧</b>阅读视觉内容。
              具有硬字幕的视频能顺带解析字幕口播；若需要完整的平台原文字幕与音轨时间戳，建议使用浏览器插件在作品页上右键点击<b>「一键拆解」</b>。
            </div>
          )}

          {/* Tab 1: 文件上传 Dropzone */}
          {inputTab === 'file' && (
            <div className="stack" style={{ gap: 10 }}>
              <div
                style={{
                  border: selectedFile ? '2px dashed var(--primary)' : '2px dashed var(--border)',
                  borderRadius: 10,
                  padding: '16px 20px',
                  textAlign: 'center',
                  background: selectedFile ? 'var(--surface-2)' : 'var(--surface-1)',
                  transition: 'all 0.2s ease',
                  cursor: running ? 'not-allowed' : 'pointer',
                }}
                onClick={() => !running && fileRef.current?.click()}
              >
                <input
                  ref={fileRef}
                  type="file"
                  accept="video/mp4,video/quicktime,video/x-matroska,video/webm"
                  disabled={running}
                  onChange={handleFileChange}
                  style={{ display: 'none' }}
                />
                {selectedFile ? (
                  <div className="row wrap" style={{ gap: 10, alignItems: 'center', justifyContent: 'center' }}>
                    <Icon.video size={24} style={{ color: 'var(--primary)' }} />
                    <div style={{ textAlign: 'left' }}>
                      <div style={{ fontWeight: 600, color: 'var(--fg)' }}>{selectedFile.name}</div>
                      <div className="small muted">
                        {(selectedFile.size / (1024 * 1024)).toFixed(2)} MB · 点击可更换文件
                      </div>
                    </div>
                    <span className="badge badge-green" style={{ marginLeft: 8 }}>已就绪</span>
                  </div>
                ) : (
                  <div className="stack" style={{ gap: 6, alignItems: 'center' }}>
                    <Icon.upload size={28} style={{ color: 'var(--muted)' }} />
                    <div style={{ fontWeight: 500 }}>点击选择或拖拽视频文件至此处</div>
                    <div className="small muted">
                      支持 <code className="mono">.mp4</code> <code className="mono">.mov</code> <code className="mono">.webm</code> <code className="mono">.mkv</code>（文件上限 {MAX_MB}MB）
                    </div>
                  </div>
                )}
              </div>

              <div className="row-between wrap" style={{ gap: 8 }}>
                <input
                  className="input"
                  style={{ flex: 1, minWidth: 240 }}
                  placeholder="你想重点关注哪些细节？（选填，如：前 3 秒留人钩子、情绪转折）"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  disabled={running}
                />
                <button
                  className="btn btn-primary"
                  onClick={submitFile}
                  disabled={running || !selectedFile || !hasArkChannel}
                >
                  <Icon.sparkles size={16} />
                  开始分析视频
                </button>
              </div>
            </div>
          )}

          {/* Tab 2: 视频直链解析 */}
          {inputTab === 'url' && (
            <div className="stack" style={{ gap: 10 }}>
              <div className="row wrap" style={{ gap: 8 }}>
                <input
                  className="input"
                  style={{ flex: 1, minWidth: 260 }}
                  placeholder="粘贴可以直接播放的视频文件 URL（以 .mp4 / .mov 等结尾）"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  disabled={running}
                />
                <button
                  className="btn btn-primary"
                  onClick={submitUrl}
                  disabled={running || !url.trim() || !hasArkChannel}
                >
                  <Icon.sparkles size={16} />
                  解析直链
                </button>
              </div>
              <input
                className="input"
                placeholder="你想重点关注哪些细节？（选填，如：视觉镜头转换、文案排版）"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                disabled={running}
              />
              <div className="small muted" style={{ lineHeight: 1.6 }}>
                ⚠️ 抖音/小红书/B站/YouTube 的<b>作品网页链接不可用</b>（受防盗链鉴权限制）。此类作品请下载视频文件后使用左侧「上传本地视频」。
              </div>
            </div>
          )}
        </div>

        {/* 动态运行状态 Indicator */}
        {running && (
          <div
            className="alert-gradient-blue small"
            style={{
              padding: '12px 16px',
              borderRadius: 8,
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <div
              style={{
                width: 18,
                height: 18,
                borderRadius: '50%',
                border: '2px solid var(--primary)',
                borderTopColor: 'transparent',
                animation: 'spin 1s linear infinite',
                flexShrink: 0,
              }}
            />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>{phase.hint || 'AI 多模态画面推理中'}…</div>
              <div className="muted" style={{ marginTop: 2 }}>
                已处理 {phase.secs} 秒 · 视频推理通常需 2–4 分钟（请保持此页面打开）
              </div>
            </div>
          </div>
        )}

        {/* 错误提示 */}
        {phase.kind === 'error' && (
          <div className="alert-gradient-amber small" style={{ padding: '10px 14px', borderRadius: 8, lineHeight: 1.6 }}>
            ⚠️ {phase.msg}
          </div>
        )}
      </div>

      <style jsx>{`
        @keyframes spin {
          to {
            transform: rotate(360deg);
          }
        }
      `}</style>
    </Card>
  );
}
