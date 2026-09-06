'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { actProposeSelectors, actActivateRule, actRollbackRule, actIgnoreIncident } from './actions';

type Incident = {
  id: string; platform: string; platformLabel: string; scope: string; field: string;
  status: string; samples: number; hasSkeleton: boolean; note: string; at: string;
  /** 失败现场截图（dataUrl，可为空）。用来肉眼核对自动上线的规则是不是指对了位置 */
  screenshot: string;
};
type Rule = {
  id: string; platform: string; platformLabel: string; field: string; status: string;
  version: number; selectors: string[]; anchors: string[]; hitRate: number | null; source: string; note: string;
};

export function ParserPanel({ incidents, rules }: { incidents: Incident[]; rules: Rule[] }) {
  const { lang } = useI18n();
  const isEn = lang === 'en';
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, okMsg: string) {
    setErr('');
    setMsg('');
    start(async () => {
      const r = await fn();
      if (!r.ok) {
        setErr(r.error ?? (isEn ? 'Operation failed' : '操作失败'));
        return;
      }
      setMsg(okMsg);
      router.refresh();
    });
  }

  return (
    <>
      <Card
        title={isEn ? 'Suspected Redesign Incidents' : '疑似改版事件'}
        sub={isEn ? 'Same platform & field aggregated; count indicates collision occurrences' : '同一平台同一字段会合并成一条，次数是撞了几回'}
        style={{ marginBottom: 16 }}
      >
        {incidents.length === 0 ? (
          <p className="small muted">{isEn ? 'No pending incidents.' : '暂无待处理事件。'}</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{isEn ? 'Platform / Field' : '平台 / 字段'}</th>
                  <th>{isEn ? 'Count' : '次数'}</th>
                  <th>{isEn ? 'Sample' : '样本'}</th>
                  <th>{isEn ? 'Recent' : '最近'}</th>
                  <th style={{ width: 220 }}>{isEn ? 'Actions' : '操作'}</th>
                </tr>
              </thead>
              <tbody>
                {incidents.map((i) => (
                  <tr key={i.id}>
                    <td>
                      {i.platformLabel} · {i.field}
                      <div className="small muted">
                        {i.scope === 'self' ? (isEn ? 'Self Ingest' : '自有采集') : (isEn ? 'Competitor Ingest' : '竞对采集')}
                        {i.note ? ` · ${i.note}` : ''}
                      </div>
                    </td>
                    <td>{i.samples}</td>
                    <td className="small">
                      {i.hasSkeleton
                        ? (isEn ? 'Structural skeleton present' : '有结构骨架')
                        : <span style={{ color: 'var(--amber)' }}>{isEn ? 'None (unable to diagnose)' : '无（没法诊断）'}</span>}
                      {i.screenshot && (
                        <details style={{ marginTop: 4 }}>
                          <summary style={{ cursor: 'pointer' }}>{isEn ? 'Failure Screenshot' : '失败现场截图'}</summary>
                          {/* dataUrl 直接内联渲染；30 天后被保留期任务清空，这里就不再显示 */}
                          <img
                            src={i.screenshot}
                            alt={`${i.platformLabel} ${i.field} ${isEn ? 'parsing failure screenshot' : '解析失败现场'}`}
                            style={{ maxWidth: 420, width: '100%', borderRadius: 8, marginTop: 6, border: '1px solid var(--line)' }}
                          />
                        </details>
                      )}
                    </td>
                    <td className="small muted">{i.at}</td>
                    <td className="row" style={{ gap: 6 }}>
                      <button
                        className="btn btn-sm btn-primary"
                        disabled={pending || !i.hasSkeleton}
                        title={i.hasSkeleton ? (isEn ? 'Infer new anchors from redacted DOM' : '让模型从脱敏结构里推断新锚点') : (isEn ? 'No structural sample, cannot diagnose' : '这条没有结构样本，诊断不了')}
                        onClick={() => run(() => actProposeSelectors(i.id), isEn ? 'Candidate rule generated, view below' : '已产出候选规则，往下看')}
                      >
                        {isEn ? 'Diagnose with AI' : '让模型诊断'}
                      </button>
                      <button className="btn btn-sm btn-ghost" disabled={pending} onClick={() => run(() => actIgnoreIncident(i.id), isEn ? 'Ignored' : '已忽略')}>
                        {isEn ? 'Ignore' : '忽略'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title={isEn ? 'Parser Rules' : '解析规则'}
        sub={isEn ? 'Candidates require approval before dispatch; active rules are currently used by extension' : '待审的要你点头才会下发到插件；生效中的是插件正在用的那一版'}
      >
        {rules.length === 0 ? (
          <p className="small muted">{isEn ? 'No rules yet.' : '还没有任何规则。'}</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{isEn ? 'Platform / Field' : '平台 / 字段'}</th>
                  <th>{isEn ? 'Version' : '版本'}</th>
                  <th>{isEn ? 'Selectors' : '选择器'}</th>
                  <th>{isEn ? 'Hit Rate' : '命中率'}</th>
                  <th>{isEn ? 'Status' : '状态'}</th>
                  <th style={{ width: 190 }}>{isEn ? 'Actions' : '操作'}</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => {
                  let statusLabel = r.status;
                  if (r.status === 'active') statusLabel = isEn ? 'Active' : '生效中';
                  else if (r.status === 'candidate') statusLabel = isEn ? 'Candidate' : '待审';
                  else statusLabel = isEn ? 'Retired' : '已退休';

                  return (
                    <tr key={r.id}>
                      <td>
                        {r.platformLabel} · {r.field}
                        <div className="small muted">
                          {r.source === 'llm' ? (isEn ? 'Model inferred' : '模型推断') : (isEn ? 'Manual' : '人工填写')}
                          {r.note ? ` · ${r.note}` : ''}
                        </div>
                      </td>
                      <td>v{r.version}</td>
                      <td className="small" style={{ maxWidth: 320, wordBreak: 'break-all' }}>
                        {r.selectors.join(' , ') || '—'}
                        {r.anchors.length > 0 && <div className="muted">{isEn ? 'Anchors: ' : '锚点：'}{r.anchors.join(isEn ? ', ' : '、')}</div>}
                      </td>
                      <td className="small">
                        {/* 没验证过就说没验证过：写成 0% 会让人以为这条规则是坏的 */}
                        {r.hitRate === null ? <span className="muted">{isEn ? 'Unverified' : '未验证'}</span> : `${Math.round(r.hitRate * 100)}%`}
                      </td>
                      <td>
                        <span className={`badge ${r.status === 'active' ? 'badge-green' : r.status === 'candidate' ? 'badge-amber' : 'badge-gray'}`}>
                          {statusLabel}
                        </span>
                      </td>
                      <td className="row" style={{ gap: 6 }}>
                        {r.status === 'candidate' && (
                          <button className="btn btn-sm btn-primary" disabled={pending} onClick={() => run(() => actActivateRule(r.id), isEn ? 'Dispatched' : '已下发')}>
                            {isEn ? 'Approve & Dispatch' : '采纳并下发'}
                          </button>
                        )}
                        {r.status === 'active' && (
                          <button className="btn btn-sm" disabled={pending} onClick={() => run(() => actRollbackRule(r.platform, r.field), isEn ? 'Rolled back' : '已回滚')}>
                            {isEn ? 'Rollback' : '回滚'}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {(msg || err) && <div className="small" style={{ marginTop: 10, color: err ? 'var(--red)' : 'var(--green)' }}>{err || msg}</div>}
      </Card>
    </>
  );
}
