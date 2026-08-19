'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui';
import { actProposeSelectors, actActivateRule, actRollbackRule, actIgnoreIncident } from './actions';

type Incident = {
  id: string; platform: string; platformLabel: string; scope: string; field: string;
  status: string; samples: number; hasSkeleton: boolean; note: string; at: string;
};
type Rule = {
  id: string; platform: string; platformLabel: string; field: string; status: string;
  version: number; selectors: string[]; anchors: string[]; hitRate: number | null; source: string; note: string;
};

export function ParserPanel({ incidents, rules }: { incidents: Incident[]; rules: Rule[] }) {
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
        setErr(r.error ?? '操作失败');
        return;
      }
      setMsg(okMsg);
      router.refresh();
    });
  }

  return (
    <>
      <Card title="疑似改版事件" sub="同一平台同一字段会合并成一条，次数是撞了几回" style={{ marginBottom: 16 }}>
        {incidents.length === 0 ? (
          <p className="small muted">暂无待处理事件。</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>平台 / 字段</th><th>次数</th><th>样本</th><th>最近</th><th style={{ width: 220 }}>操作</th></tr>
              </thead>
              <tbody>
                {incidents.map((i) => (
                  <tr key={i.id}>
                    <td>
                      {i.platformLabel} · {i.field}
                      <div className="small muted">{i.scope === 'self' ? '自有采集' : '竞对采集'}{i.note ? ` · ${i.note}` : ''}</div>
                    </td>
                    <td>{i.samples}</td>
                    <td className="small">
                      {i.hasSkeleton ? '有结构骨架' : <span style={{ color: 'var(--amber)' }}>无（没法诊断）</span>}
                    </td>
                    <td className="small muted">{i.at}</td>
                    <td className="row" style={{ gap: 6 }}>
                      <button
                        className="btn btn-sm btn-primary"
                        disabled={pending || !i.hasSkeleton}
                        title={i.hasSkeleton ? '让模型从脱敏结构里推断新锚点' : '这条没有结构样本，诊断不了'}
                        onClick={() => run(() => actProposeSelectors(i.id), '已产出候选规则，往下看')}
                      >
                        让模型诊断
                      </button>
                      <button className="btn btn-sm btn-ghost" disabled={pending} onClick={() => run(() => actIgnoreIncident(i.id), '已忽略')}>
                        忽略
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="解析规则" sub="待审的要你点头才会下发到插件；生效中的是插件正在用的那一版">
        {rules.length === 0 ? (
          <p className="small muted">还没有任何规则。</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>平台 / 字段</th><th>版本</th><th>选择器</th><th>命中率</th><th>状态</th><th style={{ width: 190 }}>操作</th></tr>
              </thead>
              <tbody>
                {rules.map((r) => (
                  <tr key={r.id}>
                    <td>
                      {r.platformLabel} · {r.field}
                      <div className="small muted">{r.source === 'llm' ? '模型推断' : '人工填写'}{r.note ? ` · ${r.note}` : ''}</div>
                    </td>
                    <td>v{r.version}</td>
                    <td className="small" style={{ maxWidth: 320, wordBreak: 'break-all' }}>
                      {r.selectors.join(' , ') || '—'}
                      {r.anchors.length > 0 && <div className="muted">锚点：{r.anchors.join('、')}</div>}
                    </td>
                    <td className="small">
                      {/* 没验证过就说没验证过：写成 0% 会让人以为这条规则是坏的 */}
                      {r.hitRate === null ? <span className="muted">未验证</span> : `${Math.round(r.hitRate * 100)}%`}
                    </td>
                    <td>
                      <span className={`badge ${r.status === 'active' ? 'badge-green' : r.status === 'candidate' ? 'badge-amber' : 'badge-gray'}`}>
                        {r.status === 'active' ? '生效中' : r.status === 'candidate' ? '待审' : '已退休'}
                      </span>
                    </td>
                    <td className="row" style={{ gap: 6 }}>
                      {r.status === 'candidate' && (
                        <button className="btn btn-sm btn-primary" disabled={pending} onClick={() => run(() => actActivateRule(r.id), '已下发')}>
                          采纳并下发
                        </button>
                      )}
                      {r.status === 'active' && (
                        <button className="btn btn-sm" disabled={pending} onClick={() => run(() => actRollbackRule(r.platform, r.field), '已回滚')}>
                          回滚
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {(msg || err) && <div className="small" style={{ marginTop: 10, color: err ? 'var(--red)' : 'var(--green)' }}>{err || msg}</div>}
      </Card>
    </>
  );
}
