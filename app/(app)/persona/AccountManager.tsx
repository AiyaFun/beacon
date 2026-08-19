'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { PLATFORM_LIST } from '@/lib/constants';
import { Icon } from '@/components/icons';
import { duplicateGroups } from '@/lib/account/duplicate';
import {
  actSwitchAccount,
  actCreateAccount,
  actUpdateAccount,
  actArchiveAccount,
  actRestoreAccount,
  actAccountInventory,
  actMergeAccounts,
  actDeleteAccount,
} from '@/app/(app)/actions';

export type ManagedAccount = {
  id: string;
  name: string;
  platform: string;
  platformLabel: string;
  handle: string | null;
  status: string;
  isCurrent: boolean;
  draftCount: number;
  publishCount: number;
  personaScore: number; // 人设卡完善度 0-100：合并时用来提醒「你正要丢掉更完整的那张人设卡」
};

type InventoryRow = { key: string; label: string; count: number };

// 多账号管理：新建/切换/编辑/归档/合并/删除。每个账号的人设、草稿、选题、记忆、发布数据完全独立。
export function AccountManager({ accounts }: { accounts: ManagedAccount[] }) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState('');
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', platform: 'douyin', handle: '' });
  // 合并/删除面板：一次只开一个，面板挂在被操作的那一行下面
  const [panel, setPanel] = useState<{ id: string; kind: 'merge' | 'delete' } | null>(null);
  const [mergeTarget, setMergeTarget] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [inventory, setInventory] = useState<{ id: string; rows: InventoryRow[] } | null>(null);
  // 结果横幅**必须挂在组件根部**：合并/删除后那一行会从服务端列表里消失，
  // 挂在行里的提示会跟着卡片一起卸载，用户点完只看见「东西没了」而不知道搬了些什么。
  const [result, setResult] = useState('');
  const router = useRouter();

  const byId = new Map(accounts.map((a) => [a.id, a]));
  const dupGroups = duplicateGroups(accounts);

  function refreshAfter(r: { ok: boolean; error?: string }) {
    if (!r.ok) {
      setErr(r.error ?? '操作失败');
      return;
    }
    setErr('');
    setCreating(false);
    setEditingId(null);
    setForm({ name: '', platform: 'douyin', handle: '' });
    router.refresh();
  }

  function submitCreate() {
    start(async () => refreshAfter(await actCreateAccount(form.name, form.platform, form.handle)));
  }
  function submitEdit(id: string) {
    start(async () => refreshAfter(await actUpdateAccount(id, { name: form.name, platform: form.platform, handle: form.handle })));
  }

  // 面板一打开就把清单拉回来：合并要让人看见「要搬什么」，删除要让人看见「要毁什么」
  function openPanel(id: string, kind: 'merge' | 'delete', target?: string) {
    setPanel({ id, kind });
    setCreating(false);
    setEditingId(null);
    setErr('');
    setConfirmText('');
    setInventory(null);
    if (kind === 'merge') {
      setMergeTarget(target ?? accounts.find((a) => a.id !== id && a.status === 'active')?.id ?? '');
    }
    start(async () => {
      const r = await actAccountInventory(id);
      if (r.ok) setInventory({ id, rows: r.rows });
    });
  }

  function closePanel() {
    setPanel(null);
    setInventory(null);
    setConfirmText('');
    setErr('');
  }

  function submitMerge(sourceId: string) {
    const source = byId.get(sourceId);
    const target = byId.get(mergeTarget);
    if (!source || !target) return;
    start(async () => {
      const r = await actMergeAccounts(sourceId, mergeTarget);
      if (!r.ok) {
        setErr(r.error ?? '合并失败');
        return;
      }
      const movedText = r.moved.length ? r.moved.map((m) => `${m.label} ${m.count}`).join(' · ') : '没有需要搬的数据';
      const droppedText = r.dropped.length
        ? `；目标已有同一条、已丢弃：${r.dropped.map((m) => `${m.label} ${m.count}`).join(' · ')}`
        : '';
      setResult(`已把「${r.sourceName}」并入「${r.targetName}」：${movedText}${droppedText}。`);
      setErr('');
      closePanel();
      router.refresh();
    });
  }

  function submitDelete(id: string) {
    start(async () => {
      const r = await actDeleteAccount(id, confirmText);
      if (!r.ok) {
        setErr(r.error ?? '删除失败');
        return;
      }
      setResult(`已彻底删除账号「${r.name}」及其名下数据。`);
      setErr('');
      closePanel();
      router.refresh();
    });
  }

  const formBody = (onSubmit: () => void, submitLabel: string) => (
    <form className="row wrap" style={{ gap: 8, alignItems: 'center', marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
      <input
        className="input"
        style={{ maxWidth: 180 }}
        placeholder="账号名称（如：小红书主号）"
        value={form.name}
        onChange={(e) => setForm({ ...form, name: e.target.value })}
      />
      <select className="select" style={{ maxWidth: 130 }} value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })}>
        {PLATFORM_LIST.map((p) => (
          <option key={p.key} value={p.key}>{p.name}</option>
        ))}
        <option value="multi">多平台</option>
      </select>
      <input
        className="input"
        style={{ maxWidth: 160 }}
        placeholder="平台昵称/ID（选填）"
        value={form.handle}
        onChange={(e) => setForm({ ...form, handle: e.target.value })}
      />
      <button type="submit" className="btn btn-sm btn-primary" disabled={pending || !form.name.trim()}>
        {pending ? '保存中…' : submitLabel}
      </button>
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setCreating(false); setEditingId(null); setErr(''); }} disabled={pending}>
        取消
      </button>
    </form>
  );

  const inventoryLine = (id: string) => {
    if (!inventory || inventory.id !== id) return <span className="small muted">正在数这个账号名下的数据…</span>;
    const rows = inventory.rows.filter((r) => r.count > 0);
    if (rows.length === 0) return <span className="small muted">这个账号名下没有任何数据。</span>;
    return <span className="small">{rows.map((r) => `${r.label} ${r.count}`).join(' · ')}</span>;
  };

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="small muted">
        每个账号的人设卡、草稿、选题、长期记忆、发布数据都<b style={{ color: 'var(--text)' }}>完全独立</b>；顶栏可随时切换当前操作账号。
      </div>

      {result && (
        <div className="card" style={{ padding: 10, boxShadow: 'none', background: 'var(--surface-2)', borderLeft: '3px solid var(--green)' }}>
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <span className="small">{result}</span>
            <span className="spacer" />
            <button className="btn btn-sm btn-ghost" onClick={() => setResult('')}>知道了</button>
          </div>
        </div>
      )}

      {/* 疑似重复：同一个真实账号被建成了两条（网页手填一次、插件在作品页又就地建了一次），
          数据从此一分为二，而每个数据页都按 accountId 过滤——不提示的话用户只会觉得「数据丢了」。 */}
      {dupGroups.map((g) => {
        // 默认保留哪个：人设卡更完善的 > 数据更多的 > 活跃的。都只是默认值——
        // 面板里可以改保留账号，也可以一键调换方向，不替用户拍板。
        const target = [...g].sort((x, y) =>
          y.personaScore - x.personaScore
          || (y.draftCount + y.publishCount) - (x.draftCount + x.publishCount)
          || Number(y.status === 'active') - Number(x.status === 'active'),
        )[0];
        const source = g.find((a) => a.id !== target.id)!;
        return (
          <div
            key={g.map((a) => a.id).join('-')}
            className="card"
            style={{ padding: 10, boxShadow: 'none', background: 'var(--surface-2)', borderLeft: '3px solid var(--amber)' }}
          >
            <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
              <span className="small">
                <b>{g.map((a) => `「${a.name}」`).join('和')}</b> 看起来是同一个 {g[0].platformLabel} 账号——
                两个号的数据是分开统计的，合并后基线和数据看板才是完整的。
              </span>
              <span className="spacer" />
              <button className="btn btn-sm btn-ghost" disabled={pending} onClick={() => openPanel(source.id, 'merge', target.id)}>
                去合并
              </button>
            </div>
          </div>
        );
      })}

      {accounts.map((a) => (
        <div
          key={a.id}
          className="card"
          style={{
            padding: 12,
            boxShadow: 'none',
            background: 'var(--surface-2)',
            // 归档行是淡的；但删除确认必须清清楚楚看得见，展开面板时恢复不透明
            opacity: a.status === 'archived' && panel?.id !== a.id ? 0.6 : 1,
          }}
        >
          <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
            <b className="small">{a.name}</b>
            <span className="badge badge-gray">{a.platformLabel}</span>
            {a.handle && <span className="small muted">@{a.handle}</span>}
            {a.isCurrent && <span className="badge badge-brand">当前账号</span>}
            {a.status === 'archived' && <span className="badge badge-gray">已归档</span>}
            <span className="small muted">· {a.draftCount} 篇草稿 · {a.publishCount} 次发布</span>
            <span className="spacer" />
            {a.status === 'active' && !a.isCurrent && (
              <button
                className="btn btn-sm btn-ghost"
                disabled={pending}
                onClick={() => start(async () => refreshAfter(await actSwitchAccount(a.id)))}
              >
                切换到此账号
              </button>
            )}
            <button
              className="btn btn-sm btn-ghost"
              disabled={pending}
              onClick={() => {
                setEditingId(editingId === a.id ? null : a.id);
                setCreating(false);
                setPanel(null);
                setForm({ name: a.name, platform: a.platform, handle: a.handle ?? '' });
              }}
            >
              编辑
            </button>
            {accounts.length > 1 && (
              <button
                className="btn btn-sm btn-ghost"
                disabled={pending}
                onClick={() => (panel?.id === a.id && panel.kind === 'merge' ? closePanel() : openPanel(a.id, 'merge'))}
                title="把这个账号的数据并进另一个账号，然后删掉它"
              >
                合并
              </button>
            )}
            {a.status === 'active' ? (
              <button
                className="btn btn-sm btn-ghost"
                disabled={pending}
                onClick={() => start(async () => refreshAfter(await actArchiveAccount(a.id)))}
                title="归档不删除数据，可随时恢复"
              >
                归档
              </button>
            ) : (
              <>
                <button
                  className="btn btn-sm btn-ghost"
                  disabled={pending}
                  onClick={() => start(async () => refreshAfter(await actRestoreAccount(a.id)))}
                >
                  恢复
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  style={{ color: 'var(--red)' }}
                  disabled={pending}
                  onClick={() => (panel?.id === a.id && panel.kind === 'delete' ? closePanel() : openPanel(a.id, 'delete'))}
                  title="彻底删除这个账号及其名下数据，不可恢复"
                >
                  删除
                </button>
              </>
            )}
          </div>
          {editingId === a.id && formBody(() => submitEdit(a.id), '保存修改')}

          {/* ── 合并面板 ── */}
          {panel?.id === a.id && panel.kind === 'merge' && (
            <div className="stack" style={{ gap: 8, marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
              <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
                <span className="small">把「<b>{a.name}</b>」的数据并入</span>
                <select className="select" style={{ maxWidth: 220 }} value={mergeTarget} onChange={(e) => setMergeTarget(e.target.value)}>
                  <option value="">选择保留的账号…</option>
                  {accounts.filter((o) => o.id !== a.id).map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}（{o.platformLabel}{o.status === 'archived' ? '·已归档' : ''}）
                    </option>
                  ))}
                </select>
                {/* 方向搞反的代价不对称：被合并的那个号会被删掉。给一个一键调换，别让人退出去重点一遍 */}
                {mergeTarget && (
                  <button className="btn btn-sm btn-ghost" disabled={pending} onClick={() => openPanel(mergeTarget, 'merge', a.id)}>
                    ⇄ 反过来（保留「{a.name}」）
                  </button>
                )}
              </div>
              <div>将搬过去：{inventoryLine(a.id)}</div>
              <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
                <li>合并后「{a.name}」<b>会被删除</b>；保留账号的名称、平台昵称、人设卡、风格指纹都不变。</li>
                <li>「{a.name}」的人设卡与人设版本历史<b>不会合并</b>，随它一起删除（版本号按账号自增，两段历史并进来会分不清谁是谁）。</li>
                <li>同一条数据两边都有时（同一天的账号数据、同一篇发布记录），保留账号那条留下，另一条补空后丢弃。</li>
                <li>插件里如果绑的是「{a.name}」，合并后要到插件的账号下拉框里重新选一次。</li>
              </ul>
              {mergeTarget && byId.get(mergeTarget) && a.personaScore > (byId.get(mergeTarget)!.personaScore ?? 0) && (
                <div className="small" style={{ color: 'var(--amber)' }}>
                  注意：「{a.name}」的人设卡完善度（{a.personaScore}%）高于保留账号「{byId.get(mergeTarget)!.name}」（{byId.get(mergeTarget)!.personaScore}%）。
                  人设卡不会被合并——如果要留的是这一张，请反过来合并，或先把内容复制到保留账号里。
                </div>
              )}
              <div className="row" style={{ gap: 8 }}>
                <button className="btn btn-sm btn-primary" disabled={pending || !mergeTarget} onClick={() => submitMerge(a.id)}>
                  {pending ? '合并中…' : '确认合并'}
                </button>
                <button className="btn btn-sm btn-ghost" disabled={pending} onClick={closePanel}>取消</button>
              </div>
            </div>
          )}

          {/* ── 删除面板（只对已归档的号开放）── */}
          {panel?.id === a.id && panel.kind === 'delete' && (
            <div className="stack" style={{ gap: 8, marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
              <div className="small" style={{ color: 'var(--red)' }}>
                <b>彻底删除，不可恢复。</b>如果这些数据还有用，请改用「合并」把它们并到另一个账号里。
              </div>
              <div>将被删除：{inventoryLine(a.id)}</div>
              <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
                <li>灵感会保留下来，转为工作区共享（它们本就可以不属于任何账号）。</li>
                <li>采集台账保留：它是「什么时候采了什么」的合规凭证，账号名已存了快照。</li>
                <li>群里绑定到这个账号的机器人会话会解绑，下次要重新指定账号。</li>
              </ul>
              <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
                <input
                  className="input"
                  style={{ maxWidth: 220 }}
                  placeholder={`输入「${a.name}」以确认`}
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                />
                <button
                  className="btn btn-sm btn-primary"
                  style={{ background: 'var(--red)', borderColor: 'var(--red)' }}
                  disabled={pending || confirmText.trim() !== a.name}
                  onClick={() => submitDelete(a.id)}
                >
                  {pending ? '删除中…' : '彻底删除'}
                </button>
                <button className="btn btn-sm btn-ghost" disabled={pending} onClick={closePanel}>取消</button>
              </div>
            </div>
          )}
        </div>
      ))}

      {creating ? (
        formBody(submitCreate, '创建并切换')
      ) : (
        <div>
          <button
            className="btn btn-sm btn-primary"
            onClick={() => {
              setCreating(true);
              setEditingId(null);
              setPanel(null);
              setForm({ name: '', platform: 'douyin', handle: '' });
            }}
          >
            <Icon.plus size={14} /> 新建账号
          </button>
        </div>
      )}
      {err && <span className="small" style={{ color: 'var(--red)' }}>{err}</span>}
    </div>
  );
}
