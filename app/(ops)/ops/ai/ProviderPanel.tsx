'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui';
import { LLM_VENDORS } from '@/lib/constants';
import {
  actCreatePlatformProvider,
  actDeletePlatformProvider,
  actTogglePlatformProvider,
  actTestPlatformProvider,
  actSetPlatformRouting,
} from './actions';

type ProviderView = {
  id: string;
  label: string;
  vendor: string;
  vendorLabel: string;
  model: string;
  region: string;
  enabled: boolean;
  isDefault: boolean;
  status: string;
  routing: string;
};

const STATUS: Record<string, { dot: string; text: string }> = {
  ok: { dot: 'dot-green', text: '连通正常' },
  failed: { dot: 'dot-red', text: '连通失败' },
  untested: { dot: 'dot-amber', text: '未测试' },
};

const EMPTY = { label: '', vendor: 'deepseek', apiKey: '', model: '', region: 'cn' };

export function ProviderPanel({
  providers,
  functions,
}: {
  providers: ProviderView[];
  functions: { key: string; label: string }[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [form, setForm] = useState(EMPTY);
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  function run(fn: () => Promise<{ ok: boolean; error?: string; detail?: string }>, okMsg: string) {
    setErr('');
    setMsg('');
    start(async () => {
      const r = await fn();
      if (!r.ok) {
        setErr(r.error || r.detail || '操作失败');
        return;
      }
      setMsg(r.detail ? `${okMsg}：${r.detail}` : okMsg);
      router.refresh();
    });
  }

  // 当前每个功能被指到哪条渠道（口径与读侧一致：渠道自己的 routing 里存 {fn: 自己的 id}）
  const routedTo = (fn: string): string => {
    for (const p of providers) {
      try {
        const r = JSON.parse(p.routing || '{}') as Record<string, string>;
        if (r[fn] === p.id) return p.id;
      } catch {
        /* 坏 JSON 当没配，不让一条脏数据把整页打挂 */
      }
    }
    return '';
  };

  return (
    <Card
      title="平台渠道"
      sub="平台垫付的模型通道 · 租户配了自己的 Key 时不会走这里"
      style={{ marginBottom: 16 }}
      action={
        <button className="btn btn-sm" onClick={() => setAdding((v) => !v)}>
          {adding ? '收起' : '+ 新增渠道'}
        </button>
      }
    >
      {adding && (
        <div className="row wrap" style={{ gap: 8, marginBottom: 14, alignItems: 'flex-end' }}>
          <input
            className="input"
            placeholder="渠道名称（如：主力生成）"
            value={form.label}
            onChange={(e) => setForm({ ...form, label: e.target.value })}
            style={{ maxWidth: 180 }}
          />
          <select
            className="select"
            value={form.vendor}
            onChange={(e) => {
              const v = e.target.value;
              // 换厂商时把模型名换成该厂商的推荐默认值：留着上一家的模型名去调这一家，
              // 只会换来一句「模型不存在」，而用户以为自己什么都没改。
              setForm({ ...form, vendor: v, model: LLM_VENDORS[v]?.model ?? '', region: LLM_VENDORS[v]?.region ?? 'cn' });
            }}
            style={{ maxWidth: 200 }}
          >
            {Object.values(LLM_VENDORS).map((v) => (
              <option key={v.key} value={v.key}>{v.name}</option>
            ))}
          </select>
          <input
            className="input"
            placeholder="模型名"
            value={form.model}
            onChange={(e) => setForm({ ...form, model: e.target.value })}
            style={{ maxWidth: 180 }}
          />
          <input
            className="input"
            type="password"
            placeholder="API Key（加密入库，永不回显）"
            value={form.apiKey}
            onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
            style={{ maxWidth: 240 }}
          />
          <button
            className="btn btn-sm btn-primary"
            disabled={pending}
            onClick={() =>
              run(async () => {
                const r = await actCreatePlatformProvider({
                  ...form,
                  baseUrl: LLM_VENDORS[form.vendor]?.baseUrl ?? '',
                });
                if (r.ok) {
                  setForm(EMPTY);
                  setAdding(false);
                }
                return r;
              }, '已添加')
            }
          >
            保存
          </button>
        </div>
      )}

      {providers.length === 0 ? (
        <p className="small muted">
          还没有平台渠道。当前平台侧走 env 里的 BEACON_DEFAULT_LLM_*（没配则全站降级到 Mock 示例内容）。
        </p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>渠道</th><th>厂商 / 模型</th><th>状态</th><th>默认</th><th>启用</th><th style={{ width: 190 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {providers.map((p) => (
                <tr key={p.id}>
                  <td>
                    {p.label}
                    {p.region === 'overseas' && <span className="badge badge-amber" style={{ marginLeft: 6 }}>海外</span>}
                  </td>
                  <td className="small muted">{p.vendorLabel} · {p.model}</td>
                  <td className="small">
                    <span className={`dot ${STATUS[p.status]?.dot ?? 'dot-amber'}`} /> {STATUS[p.status]?.text ?? p.status}
                  </td>
                  <td>
                    <button
                      className={`btn btn-sm ${p.isDefault ? 'btn-primary' : 'btn-ghost'}`}
                      disabled={pending || p.isDefault}
                      onClick={() => run(() => actTogglePlatformProvider(p.id, { isDefault: true }), '已设为默认')}
                    >
                      {p.isDefault ? '默认' : '设为默认'}
                    </button>
                  </td>
                  <td>
                    <button
                      className="btn btn-sm"
                      disabled={pending}
                      onClick={() => run(() => actTogglePlatformProvider(p.id, { enabled: !p.enabled }), p.enabled ? '已停用' : '已启用')}
                    >
                      {p.enabled ? '已启用' : '已停用'}
                    </button>
                  </td>
                  <td className="row" style={{ gap: 6 }}>
                    <button className="btn btn-sm" disabled={pending} onClick={() => run(() => actTestPlatformProvider(p.id), '测试完成')}>
                      测试
                    </button>
                    <button className="btn btn-sm btn-ghost" disabled={pending} onClick={() => run(() => actDeletePlatformProvider(p.id), '已删除')}>
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <div className="small" style={{ fontWeight: 600, marginBottom: 8 }}>按功能路由</div>
        <div className="grid grid-2" style={{ gap: 8 }}>
          {functions.map((f) => {
            // 图像/视频只有火山方舟走得通（读侧只在 doubao 里挑）。这里就把不可选的过滤掉，
            // 而不是让人选完再收到一句「只能用豆包渠道」。
            const arkOnly = f.key === 'image' || f.key === 'video';
            const options = arkOnly ? providers.filter((p) => p.vendor === 'doubao') : providers;
            return (
              <div key={f.key} className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
                <span className="small">
                  {f.label}
                  {arkOnly && <span className="muted"> · 仅火山方舟</span>}
                </span>
                {arkOnly && options.length === 0 ? (
                  <span className="small muted">需要一条「火山引擎 豆包」渠道</span>
                ) : (
                  <select
                    className="select"
                    style={{ maxWidth: 200, fontSize: 12.5 }}
                    value={routedTo(f.key)}
                    disabled={pending || options.length === 0}
                    onChange={(e) => run(() => actSetPlatformRouting(f.key, e.target.value), '路由已更新')}
                  >
                    <option value="">跟随默认渠道</option>
                    {options.map((p) => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                  </select>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {(msg || err) && (
        <div className="small" style={{ marginTop: 10, color: err ? 'var(--red)' : 'var(--green)' }}>{err || msg}</div>
      )}
    </Card>
  );
}
