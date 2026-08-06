'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/components/icons';
import { actAttachPublishUrl } from './actions';

// 给缺发布链接的记录行内补链接：解析出作品 ID 后这条记录才进入自动回流集合。
// 与 MetricsUpdater 同构（行内展开、useTransition、成功后 router.refresh）。
export function AttachUrl({ publishId }: { publishId: string }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [pending, start] = useTransition();
  const [err, setErr] = useState('');
  const router = useRouter();

  function submit() {
    setErr('');
    start(async () => {
      const r = await actAttachPublishUrl(publishId, url);
      if (!r.ok) {
        setErr(r.error ?? '补链接失败');
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  if (!open) {
    return (
      <button className="btn btn-sm btn-ghost" style={{ color: 'var(--amber)' }} onClick={() => setOpen(true)}>
        <Icon.plus size={13} /> 补链接
      </button>
    );
  }
  return (
    <div className="row wrap" style={{ gap: 6, alignItems: 'center' }}>
      <input
        className="input"
        style={{ width: 220 }}
        placeholder="粘贴作品发布链接"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && !pending && url.trim() && submit()}
      />
      <button className="btn btn-sm btn-primary" onClick={submit} disabled={pending || !url.trim()}>
        {pending ? '解析中…' : '保存'}
      </button>
      <button className="btn btn-sm btn-ghost" onClick={() => setOpen(false)} disabled={pending}>
        取消
      </button>
      {err && <span className="small" style={{ color: 'var(--red)' }}>{err}</span>}
    </div>
  );
}
