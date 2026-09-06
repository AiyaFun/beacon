'use client';

import { useState, useTransition } from 'react';
import { Card } from '@/components/ui';
import { fmtTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { actCheckAllConnections } from './actions';
import type { CheckRow } from '@/lib/settings/connectivity';

const STATE_META: Record<CheckRow['state'], { dot: string; labelZh: string; labelEn: string; color: string }> = {
  ok: { dot: 'dot-green', labelZh: '通', labelEn: 'OK', color: 'var(--green)' },
  warn: { dot: 'dot-amber', labelZh: '注意', labelEn: 'Warn', color: 'var(--amber)' },
  fail: { dot: 'dot-red', labelZh: '不通', labelEn: 'Fail', color: 'var(--red)' },
  idle: { dot: 'dot-gray', labelZh: '未配', labelEn: 'Idle', color: 'var(--text-3)' },
};

// 一键检测。**不做的事要说出来**：不发测试消息、不真出图——
// 否则用户点一下"检测"，群里多一条消息、账上少几毛钱，这比不检测还糟。
export function CheckAllCard({ readOnly }: { readOnly: boolean }) {
  const { lang } = useI18n();
  const isEn = lang === 'en';
  const [pending, start] = useTransition();
  const [rows, setRows] = useState<CheckRow[] | null>(null);
  const [ranAt, setRanAt] = useState('');
  const [err, setErr] = useState('');

  function run() {
    setErr('');
    start(async () => {
      const r = await actCheckAllConnections();
      if (!r.ok || !r.report) {
        setErr(r.error ?? (isEn ? 'Check failed' : '检测失败'));
        return;
      }
      setRows(r.report.rows);
      setRanAt(fmtTime(r.report.ranAt));
    });
  }

  const bad = rows?.filter((r) => r.state === 'fail').length ?? 0;
  const warn = rows?.filter((r) => r.state === 'warn').length ?? 0;

  return (
    <Card
      title={isEn ? 'One-Click Connectivity Test' : '一键检测'}
      sub={isEn ? 'Probe all integrations in this workspace · Never sends test messages or generates images' : '逐条探这个工作区的所有接入 · 不发测试消息、不真出图'}
      style={{ marginBottom: 16 }}
      action={
        <button className="btn btn-sm btn-primary" disabled={pending || readOnly} onClick={run}>
          {pending ? (isEn ? 'Checking…' : '检测中…') : rows ? (isEn ? 'Recheck' : '重新检测') : (isEn ? 'Start Check' : '开始检测')}
        </button>
      }
    >
      {!rows && !err && (
        <p className="small muted" style={{ margin: 0 }}>
          {isEn ? (
            <>What it does: Sends minimal requests to each model channel, exchanges tokens with official account / bot credentials, reads local status. <b>What it will NOT do</b>: Send test messages to your groups (that is the individual "Test Send" button on each bot), or actually generate images (images are billed per generation).</>
          ) : (
            <>会做的事：给每条模型渠道发一次最小请求、用公众号/机器人凭据换一次 token、读一遍本地状态。<b>不会做的事</b>：往你的群里发测试消息（那是每条机器人上单独的「测试发送」按钮）、真生成一张图（图像按张计费）。</>
          )}
        </p>
      )}

      {rows && (
        <>
          <div className="row wrap" style={{ gap: 8, marginBottom: 12 }}>
            <span className={`badge ${bad > 0 ? 'badge-red' : 'badge-green'}`}>
              {bad > 0 ? (isEn ? `${bad} Failed` : `${bad} 项不通`) : (isEn ? 'All Passed' : '没有不通的项')}
            </span>
            {warn > 0 && <span className="badge badge-amber">{isEn ? `${warn} Warnings` : `${warn} 项要留意`}</span>}
            <span className="small muted">{isEn ? `Tested at ${ranAt}` : `${ranAt} 检测`}</span>
          </div>

          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 200 }}>{isEn ? 'Integration' : '接入'}</th>
                  <th style={{ width: 80 }}>{isEn ? 'Result' : '结果'}</th>
                  <th>{isEn ? 'Details & Resolution' : '说明'}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const m = STATE_META[r.state];
                  return (
                    <tr key={i}>
                      <td>{r.name}</td>
                      <td className="small" style={{ color: m.color }}>
                        <span className={`dot ${m.dot}`} /> {isEn ? m.labelEn : m.labelZh}
                      </td>
                      <td className="small">
                        <div>{r.detail}</div>
                        {r.fix && <div className="muted" style={{ marginTop: 2 }}>{isEn ? 'How to fix: ' : '怎么办：'}{r.fix}</div>}
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
