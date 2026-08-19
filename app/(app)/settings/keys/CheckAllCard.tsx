'use client';

import { useState, useTransition } from 'react';
import { Card } from '@/components/ui';
import { fmtTime } from '@/lib/format';
import { actCheckAllConnections } from './actions';
import type { CheckRow } from '@/lib/settings/connectivity';

const STATE_META: Record<CheckRow['state'], { dot: string; label: string; color: string }> = {
  ok: { dot: 'dot-green', label: '通', color: 'var(--green)' },
  warn: { dot: 'dot-amber', label: '注意', color: 'var(--amber)' },
  fail: { dot: 'dot-red', label: '不通', color: 'var(--red)' },
  idle: { dot: 'dot-gray', label: '未配', color: 'var(--text-3)' },
};

// 一键检测。**不做的事要说出来**：不发测试消息、不真出图——
// 否则用户点一下"检测"，群里多一条消息、账上少几毛钱，这比不检测还糟。
export function CheckAllCard({ readOnly }: { readOnly: boolean }) {
  const [pending, start] = useTransition();
  const [rows, setRows] = useState<CheckRow[] | null>(null);
  const [ranAt, setRanAt] = useState('');
  const [err, setErr] = useState('');

  function run() {
    setErr('');
    start(async () => {
      const r = await actCheckAllConnections();
      if (!r.ok || !r.report) {
        setErr(r.error ?? '检测失败');
        return;
      }
      setRows(r.report.rows);
      // 一律走 fmtTime（北京时间）：toLocaleTimeString 取的是**浏览器所在时区**，
      // 用户在国外时看到的检测时间会与服务端日志对不上（守卫测试也会红）
      setRanAt(fmtTime(r.report.ranAt));
    });
  }

  const bad = rows?.filter((r) => r.state === 'fail').length ?? 0;
  const warn = rows?.filter((r) => r.state === 'warn').length ?? 0;

  return (
    <Card
      title="一键检测"
      sub="逐条探这个工作区的所有接入 · 不发测试消息、不真出图"
      style={{ marginBottom: 16 }}
      action={
        <button className="btn btn-sm btn-primary" disabled={pending || readOnly} onClick={run}>
          {pending ? '检测中…' : rows ? '重新检测' : '开始检测'}
        </button>
      }
    >
      {!rows && !err && (
        <p className="small muted" style={{ margin: 0 }}>
          会做的事：给每条模型渠道发一次最小请求、用公众号/机器人凭据换一次 token、读一遍本地状态。
          <b>不会做的事</b>：往你的群里发测试消息（那是每条机器人上单独的「测试发送」按钮）、
          真生成一张图（图像按张计费）。
        </p>
      )}

      {rows && (
        <>
          <div className="row wrap" style={{ gap: 8, marginBottom: 12 }}>
            <span className={`badge ${bad > 0 ? 'badge-red' : 'badge-green'}`}>
              {bad > 0 ? `${bad} 项不通` : '没有不通的项'}
            </span>
            {warn > 0 && <span className="badge badge-amber">{warn} 项要留意</span>}
            <span className="small muted">{ranAt} 检测</span>
          </div>

          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th style={{ width: 200 }}>接入</th><th style={{ width: 80 }}>结果</th><th>说明</th></tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const m = STATE_META[r.state];
                  return (
                    <tr key={i}>
                      <td>{r.name}</td>
                      <td className="small" style={{ color: m.color }}>
                        <span className={`dot ${m.dot}`} /> {m.label}
                      </td>
                      <td className="small">
                        <div>{r.detail}</div>
                        {r.fix && <div className="muted" style={{ marginTop: 2 }}>怎么办：{r.fix}</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {err && <div className="small" style={{ marginTop: 10, color: 'var(--red)' }}>{err}</div>}
    </Card>
  );
}
