'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Overlay } from '@/components/Overlay';
import { AIGC_LABEL } from '@/lib/compliance/aigc';
import { parsePublishUrl } from '@/lib/publish/parse-url';
import { platformName } from '@/lib/constants';
import { actRegisterPublish } from './actions';

export function PublishForm({ draftId }: { draftId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [aigcConfirmed, setAigcConfirmed] = useState(false);
  const [msg, setMsg] = useState('');
  const [closedMsg, setClosedMsg] = useState('');

  function submit() {
    start(async () => {
      setMsg('');
      const r = await actRegisterPublish(draftId, { url: url.trim() || undefined, aigcConfirmed });
      if (!r.ok) {
        setMsg(r.error ?? '登记失败');
        return;
      }
      setOpen(false);
      setClosedMsg(r.warning ? `已登记，但${r.warning}` : '已登记发布');
      setUrl('');
      setAigcConfirmed(false);
      setMsg('');
      router.refresh();
    });
  }

  const parseResult = useMemo(() => url.trim() ? parsePublishUrl(url.trim()) : null, [url]);

  if (!open) {
    return (
      <span className="row" style={{ gap: 8, alignItems: 'center' }}>
        <button className="btn btn-sm" onClick={() => { setOpen(true); setClosedMsg(''); }}>
          登记发布
        </button>
        {closedMsg && (
          <span className="small" style={{ color: closedMsg.includes('不可用') || closedMsg.includes('不一致') ? 'var(--amber)' : 'var(--green)' }}>
            {closedMsg}
          </span>
        )}
      </span>
    );
  }

  return (
    <Overlay label="登记发布" onClose={() => setOpen(false)} closable={!pending}>
      <div className="card" style={{ width: 420, maxWidth: '92vw', padding: 24 }}>
        <h3 style={{ margin: '0 0 16px' }}>登记发布</h3>

        <label className="small" style={{ display: 'block', marginBottom: 4 }}>发布链接（可选）</label>
        <input
          className="input"
          placeholder="粘贴发布后的作品链接，用于自动回流数据"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          style={{ width: '100%', marginBottom: url.trim() ? 4 : 16 }}
        />
        {url.trim() && parseResult && (
          <div className="small" style={{ marginTop: 4, marginBottom: 8 }}>
            {parseResult.ok ? (
              <span style={{ color: 'var(--green)' }}>识别为 {platformName(parseResult.platform)} 作品，可自动回流数据</span>
            ) : (
              <span style={{ color: 'var(--amber)' }}>{parseResult.message}</span>
            )}
          </div>
        )}

        <label className="small" style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={aigcConfirmed}
            onChange={(e) => setAigcConfirmed(e.target.checked)}
            style={{ marginTop: 3 }}
          />
          <span>
            我确认已在发布平台完成 AI 使用声明，并知悉本内容将标注「{AIGC_LABEL}」
            （依据《人工智能生成合成内容标识办法》）
          </span>
        </label>

        {msg && <div className="small" style={{ marginTop: 12, color: 'var(--danger)' }}>{msg}</div>}

        <div className="row" style={{ gap: 8, marginTop: 20, justifyContent: 'flex-end' }}>
          <button className="btn" onClick={() => setOpen(false)} disabled={pending}>取消</button>
          <button
            className="btn btn-primary"
            onClick={submit}
            disabled={pending || !aigcConfirmed}
          >
            {pending ? '登记中…' : '确认登记'}
          </button>
        </div>
      </div>
    </Overlay>
  );
}
