'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { PLATFORM_LIST, platformName, platformColor } from '@/lib/constants';
import { Icon } from '@/components/icons';
import { duplicateGroups } from '@/lib/account/duplicate';
import { useLanguage } from '@/lib/i18n';
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

// 多账号管理（2026-09-06 视觉升级）：新建/切换/编辑/归档/合并/删除。每个账号的人设、草稿、选题、记忆、发布数据完全独立。
export function AccountManager({ accounts }: { accounts: ManagedAccount[] }) {
  const { lang } = useLanguage();
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
  const getAccName = (name: string) => (lang === 'en' && (name === '我的账号' || !name)) ? 'My Account' : (name || (lang === 'en' ? 'My Account' : '我的账号'));
  const getPlatformLabel = (platform: string, fallback: string) => platformName(platform, lang) || fallback;

  function refreshAfter(r: { ok: boolean; error?: string }) {
    if (!r.ok) {
      setErr(r.error ?? (lang === 'en' ? 'Operation failed' : '操作失败'));
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
        setErr(r.error ?? (lang === 'en' ? 'Merge failed' : '合并失败'));
        return;
      }
      const movedText = r.moved.length
        ? r.moved.map((m) => `${m.label} ${m.count}`).join(' · ')
        : (lang === 'en' ? 'No data needed to be transferred' : '没有需要搬的数据');
      const droppedText = r.dropped.length
        ? (lang === 'en'
            ? `; Target already has identical records, skipped: ${r.dropped.map((m) => `${m.label} ${m.count}`).join(' · ')}`
            : `；目标已有同一条、已丢弃：${r.dropped.map((m) => `${m.label} ${m.count}`).join(' · ')}`)
        : '';
      setResult(lang === 'en'
        ? `Successfully merged "${r.sourceName}" into "${r.targetName}": ${movedText}${droppedText}.`
        : `已把「${r.sourceName}」并入「${r.targetName}」：${movedText}${droppedText}。`);
      setErr('');
      closePanel();
      router.refresh();
    });
  }

  function submitDelete(id: string) {
    start(async () => {
      const r = await actDeleteAccount(id, confirmText);
      if (!r.ok) {
        setErr(r.error ?? (lang === 'en' ? 'Delete failed' : '删除失败'));
        return;
      }
      setResult(lang === 'en'
        ? `Successfully deleted account "${r.name}" and all associated data.`
        : `已彻底删除账号「${r.name}」及其名下数据。`);
      setErr('');
      closePanel();
      router.refresh();
    });
  }

  // 现代结构化表单卡片
  const formBody = (onSubmit: () => void, submitLabel: string, isNew: boolean) => (
    <form className="acc-form-card" onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
      <div className="acc-form-head">
        <div className="acc-form-title">
          <span style={{ color: 'var(--brand)', display: 'flex' }}>
            {isNew ? <Icon.plus size={16} /> : <Icon.edit size={16} />}
          </span>
          <span>{isNew ? (lang === 'en' ? 'Create New Creator Account' : '新建创作者账号') : (lang === 'en' ? 'Edit Account Information' : '编辑账号信息')}</span>
          <span className="small muted" style={{ fontWeight: 400 }}>
            {lang === 'en' ? '(Data is completely isolated)' : '（草稿、人设、选题数据将独立隔离）'}
          </span>
        </div>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          style={{ padding: '2px 6px', color: 'var(--text-3)' }}
          onClick={() => { setCreating(false); setEditingId(null); setErr(''); }}
        >
          ✕
        </button>
      </div>

      <div className="acc-form-grid">
        {/* 字段 1：账号别名 */}
        <div className="acc-field">
          <label className="acc-field-label">
            <span>{lang === 'en' ? 'Account Name' : '账号名称'}&nbsp;<b style={{ color: 'var(--brand)' }}>*</b></span>
            <span className="acc-field-desc">{lang === 'en' ? 'Workspace label' : '如：小红书主号'}</span>
          </label>
          <div className="acc-input-wrap">
            <span className="acc-input-icon"><Icon.user size={15} /></span>
            <input
              className="input"
              placeholder={lang === 'en' ? 'e.g. Xiaohongshu Main' : '例如：小红书主号、抖音测评'}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
        </div>

        {/* 字段 2：主战平台 */}
        <div className="acc-field">
          <label className="acc-field-label">
            <span>{lang === 'en' ? 'Main Platform' : '所属平台'}&nbsp;<b style={{ color: 'var(--brand)' }}>*</b></span>
            <span className="acc-field-desc">{lang === 'en' ? 'Pipeline target' : '发布阵地'}</span>
          </label>
          <div className="acc-input-wrap">
            <span
              className="acc-input-icon"
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: platformColor(form.platform),
                left: 14,
              }}
            />
            <select
              className="select"
              value={form.platform}
              onChange={(e) => setForm({ ...form, platform: e.target.value })}
            >
              {PLATFORM_LIST.map((p) => (
                <option key={p.key} value={p.key}>{p.name}</option>
              ))}
              <option value="multi">{lang === 'en' ? 'Multi-platform' : '多平台'}</option>
            </select>
          </div>
        </div>

        {/* 字段 3：平台昵称 / ID */}
        <div className="acc-field">
          <label className="acc-field-label">
            <span>{lang === 'en' ? 'Handle / Profile ID' : '平台公开昵称 / ID'}</span>
            <span className="acc-field-desc">{lang === 'en' ? 'Optional' : '选填 · 便于回填'}</span>
          </label>
          <div className="acc-input-wrap">
            <span className="acc-input-icon"><Icon.link size={15} /></span>
            <input
              className="input"
              placeholder={lang === 'en' ? 'e.g. handle or user ID' : '例如：unique_id 或主页昵称'}
              value={form.handle}
              onChange={(e) => setForm({ ...form, handle: e.target.value })}
            />
          </div>
        </div>
      </div>

      <div className="row-between wrap" style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
        <div className="small muted">
          {lang === 'en' ? 'Tip: You can switch active accounts anytime from top bar' : '提示：创建后可在顶栏随时一键切换当前操作账号'}
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => { setCreating(false); setEditingId(null); setErr(''); }}
            disabled={pending}
          >
            {lang === 'en' ? 'Cancel' : '取消'}
          </button>
          <button
            type="submit"
            className="btn btn-sm btn-primary"
            style={{ height: 34, padding: '0 16px' }}
            disabled={pending || !form.name.trim()}
          >
            {pending ? (
              <span className="row" style={{ gap: 6 }}>
                <Icon.refresh size={13} className="spin" /> {lang === 'en' ? 'Saving…' : '正在保存…'}
              </span>
            ) : (
              <span className="row" style={{ gap: 6 }}>
                {submitLabel}
              </span>
            )}
          </button>
        </div>
      </div>
    </form>
  );

  const inventoryLine = (id: string) => {
    if (!inventory || inventory.id !== id) return <span className="small muted">{lang === 'en' ? 'Counting account data…' : '正在数这个账号名下的数据…'}</span>;
    const rows = inventory.rows.filter((r) => r.count > 0);
    if (rows.length === 0) return <span className="small muted">{lang === 'en' ? 'No data found under this account.' : '这个账号名下没有任何数据。'}</span>;
    return <span className="small">{rows.map((r) => `${r.label} ${r.count}`).join(' · ')}</span>;
  };

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="small muted">
        {lang === 'en' ? 'Each account’s persona card, drafts, topics, long-term memory, and publishing data are ' : '每个账号的人设卡、草稿、选题、长期记忆、发布数据都'}
        <b style={{ color: 'var(--text)' }}>{lang === 'en' ? 'completely independent' : '完全独立'}</b>
        {lang === 'en' ? '; switch active account anytime from the top bar.' : '；顶栏可随时切换当前操作账号。'}
      </div>

      {result && (
        <div className="card" style={{ padding: 10, boxShadow: 'none', background: 'var(--surface-2)', borderLeft: '3px solid var(--green)' }}>
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <span className="small">{result}</span>
            <span className="spacer" />
            <button className="btn btn-sm btn-ghost" onClick={() => setResult('')}>{lang === 'en' ? 'Dismiss' : '知道了'}</button>
          </div>
        </div>
      )}

      {/* 疑似重复账号提醒 */}
      {dupGroups.map((g) => {
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
                {lang === 'en' ? (
                  <>
                    <b>{g.map((a) => `"${getAccName(a.name)}"`).join(' and ')}</b> appear to be the same {getPlatformLabel(g[0].platform, g[0].platformLabel)} account—data is tracked separately; merging unifies your baseline and analytics.
                  </>
                ) : (
                  <>
                    <b>{g.map((a) => `「${getAccName(a.name)}」`).join('和')}</b> 看起来是同一个 {getPlatformLabel(g[0].platform, g[0].platformLabel)} 账号——
                    两个号的数据是分开统计的，合并后基线和数据看板才是完整的。
                  </>
                )}
              </span>
              <span className="spacer" />
              <button className="btn btn-sm btn-ghost" disabled={pending} onClick={() => openPanel(source.id, 'merge', target.id)}>
                {lang === 'en' ? 'Merge' : '去合并'}
              </button>
            </div>
          </div>
        );
      })}

      {/* 账号卡片列表 */}
      <div className="acc-list">
        {accounts.map((a) => {
          const color = platformColor(a.platform);
          return (
            <div
              key={a.id}
              className={`acc-card ${a.isCurrent ? 'current' : ''}`}
              style={{
                opacity: a.status === 'archived' && panel?.id !== a.id ? 0.6 : 1,
              }}
            >
              <div className="row wrap" style={{ gap: 10, alignItems: 'center' }}>
                {/* 平台色标点 */}
                <span
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: '50%',
                    background: color,
                    flexShrink: 0,
                  }}
                />

                {/* 账号名 */}
                <b style={{ fontSize: 14, color: 'var(--text)' }}>{getAccName(a.name)}</b>

                {/* 平台标签 */}
                <span
                  className="badge"
                  style={{
                    fontSize: 11,
                    padding: '2px 8px',
                    background: 'var(--surface-2)',
                    color: color,
                    fontWeight: 600,
                  }}
                >
                  {getPlatformLabel(a.platform, a.platformLabel)}
                </span>

                {a.handle && <span className="small muted">@{a.handle}</span>}

                {/* 当前账号微标 */}
                {a.isCurrent && (
                  <span className="badge badge-brand" style={{ fontSize: 11, padding: '2px 8px' }}>
                    <Icon.check size={11} /> {lang === 'en' ? 'Current' : '当前操作中'}
                  </span>
                )}

                {a.status === 'archived' && (
                  <span className="badge badge-gray">{lang === 'en' ? 'Archived' : '已归档'}</span>
                )}

                {/* 统计指标 */}
                <span className="small muted">
                  {lang === 'en'
                    ? `· ${a.draftCount} drafts · ${a.publishCount} published`
                    : `· ${a.draftCount} 篇草稿 · ${a.publishCount} 次发布`}
                </span>

                <span className="spacer" />

                {/* 动作按键群 */}
                {a.status === 'active' && !a.isCurrent && (
                  <button
                    className="btn btn-sm btn-ghost"
                    disabled={pending}
                    onClick={() => start(async () => refreshAfter(await actSwitchAccount(a.id)))}
                    style={{ fontSize: 12 }}
                  >
                    {lang === 'en' ? 'Switch' : '切换到此账号'}
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
                  style={{ fontSize: 12 }}
                >
                  <Icon.edit size={13} /> {lang === 'en' ? 'Edit' : '编辑'}
                </button>

                {accounts.length > 1 && (
                  <button
                    className="btn btn-sm btn-ghost"
                    disabled={pending}
                    onClick={() => (panel?.id === a.id && panel.kind === 'merge' ? closePanel() : openPanel(a.id, 'merge'))}
                    title={lang === 'en' ? 'Merge this account data into another account and delete it' : '把这个账号的数据并进另一个账号，然后删掉它'}
                    style={{ fontSize: 12 }}
                  >
                    {lang === 'en' ? 'Merge' : '合并'}
                  </button>
                )}

                {a.status === 'active' ? (
                  <button
                    className="btn btn-sm btn-ghost"
                    disabled={pending}
                    onClick={() => start(async () => refreshAfter(await actArchiveAccount(a.id)))}
                    title={lang === 'en' ? 'Archiving keeps data intact, can be restored anytime' : '归档不删除数据，可随时恢复'}
                    style={{ fontSize: 12, color: 'var(--text-3)' }}
                  >
                    {lang === 'en' ? 'Archive' : '归档'}
                  </button>
                ) : (
                  <>
                    <button
                      className="btn btn-sm btn-ghost"
                      disabled={pending}
                      onClick={() => start(async () => refreshAfter(await actRestoreAccount(a.id)))}
                      style={{ fontSize: 12 }}
                    >
                      {lang === 'en' ? 'Restore' : '恢复'}
                    </button>
                    <button
                      className="btn btn-sm btn-ghost"
                      style={{ color: 'var(--red)', fontSize: 12 }}
                      disabled={pending}
                      onClick={() => (panel?.id === a.id && panel.kind === 'delete' ? closePanel() : openPanel(a.id, 'delete'))}
                      title={lang === 'en' ? 'Permanently delete this account and its data, cannot be undone' : '彻底删除这个账号及其名下数据，不可恢复'}
                    >
                      {lang === 'en' ? 'Delete' : '删除'}
                    </button>
                  </>
                )}
              </div>

              {/* 编辑态嵌入在该账号下方 */}
              {editingId === a.id && formBody(() => submitEdit(a.id), lang === 'en' ? 'Save Changes' : '保存修改', false)}

              {/* ── 合并面板 ── */}
              {panel?.id === a.id && panel.kind === 'merge' && (
                <div className="stack" style={{ gap: 8, marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                  <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
                    <span className="small">
                      {lang === 'en' ? (
                        <>Merge data from <b>"{getAccName(a.name)}"</b> into</>
                      ) : (
                        <>把「<b>{getAccName(a.name)}</b>」的数据并入</>
                      )}
                    </span>
                    <select className="select" style={{ maxWidth: 220 }} value={mergeTarget} onChange={(e) => setMergeTarget(e.target.value)}>
                      <option value="">{lang === 'en' ? 'Select target account to keep…' : '选择保留的账号…'}</option>
                      {accounts.filter((o) => o.id !== a.id).map((o) => (
                        <option key={o.id} value={o.id}>
                          {getAccName(o.name)}（{getPlatformLabel(o.platform, o.platformLabel)}{o.status === 'archived' ? (lang === 'en' ? ' · Archived' : '·已归档') : ''}）
                        </option>
                      ))}
                    </select>
                    {mergeTarget && (
                      <button className="btn btn-sm btn-ghost" disabled={pending} onClick={() => openPanel(mergeTarget, 'merge', a.id)}>
                        {lang === 'en' ? `⇄ Swap (Keep "${getAccName(a.name)}")` : `⇄ 反过来（保留「${getAccName(a.name)}」）`}
                      </button>
                    )}
                  </div>
                  <div>{lang === 'en' ? 'Will transfer: ' : '将搬过去：'}{inventoryLine(a.id)}</div>
                  <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
                    {lang === 'en' ? (
                      <>
                        <li>After merging, <b>"{getAccName(a.name)}" will be deleted</b>; kept account name, handle, persona card, and style fingerprint remain unchanged.</li>
                        <li>Persona card and version history of "{getAccName(a.name)}" <b>will NOT be merged</b> and will be deleted.</li>
                        <li>When the same record exists on both sides, the kept account's record remains.</li>
                        <li>If the browser extension is linked to "{getAccName(a.name)}", re-select the account in extension dropdown after merge.</li>
                      </>
                    ) : (
                      <>
                        <li>合并后「{getAccName(a.name)}」<b>会被删除</b>；保留账号的名称、平台昵称、人设卡、风格指纹都不变。</li>
                        <li>「{getAccName(a.name)}」的人设卡与人设版本历史<b>不会合并</b>，随它一起删除（版本号按账号自增，两段历史并进来会分不清谁是谁）。</li>
                        <li>同一条数据两边都有时（同一天的账号数据、同一篇发布记录），保留账号那条留下，另一条补空后丢弃。</li>
                        <li>插件里如果绑的是「{getAccName(a.name)}」，合并后要到插件的账号下拉框里重新选一次。</li>
                      </>
                    )}
                  </ul>
                  {mergeTarget && byId.get(mergeTarget) && a.personaScore > (byId.get(mergeTarget)!.personaScore ?? 0) && (
                    <div className="small" style={{ color: 'var(--amber)' }}>
                      {lang === 'en'
                        ? `Notice: "${getAccName(a.name)}" persona card completeness (${a.personaScore}%) is higher than target "${getAccName(byId.get(mergeTarget)!.name)}" (${byId.get(mergeTarget)!.personaScore}%). Persona cards are not merged—if you want to keep this one, swap merge direction or copy content first.`
                        : `注意：「${getAccName(a.name)}」的人设卡完善度（${a.personaScore}%）高于保留账号「${getAccName(byId.get(mergeTarget)!.name)}」（${byId.get(mergeTarget)!.personaScore}%）。人设卡不会被合并——如果要留的是这一张，请反过来合并，或先把内容复制到保留账号里。`}
                    </div>
                  )}
                  <div className="row" style={{ gap: 8 }}>
                    <button className="btn btn-sm btn-primary" disabled={pending || !mergeTarget} onClick={() => submitMerge(a.id)}>
                      {pending ? (lang === 'en' ? 'Merging…' : '合并中…') : (lang === 'en' ? 'Confirm Merge' : '确认合并')}
                    </button>
                    <button className="btn btn-sm btn-ghost" disabled={pending} onClick={closePanel}>{lang === 'en' ? 'Cancel' : '取消'}</button>
                  </div>
                </div>
              )}

              {/* ── 删除面板（只对已归档的号开放）── */}
              {panel?.id === a.id && panel.kind === 'delete' && (
                <div className="stack" style={{ gap: 8, marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                  <div className="small" style={{ color: 'var(--red)' }}>
                    <b>{lang === 'en' ? 'Permanent deletion, cannot be recovered.' : '彻底删除，不可恢复。'}</b>
                    {lang === 'en' ? ' If this data is still useful, use "Merge" to combine them into another account instead.' : '如果这些数据还有用，请改用「合并」把它们并到另一个账号里。'}
                  </div>
                  <div>{lang === 'en' ? 'Will be deleted: ' : '将被删除：'}{inventoryLine(a.id)}</div>
                  <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
                    {lang === 'en' ? (
                      <>
                        <li>Inspirations will be retained and converted to workspace shared items.</li>
                        <li>Collection ledger is retained as compliance proof of what was collected and when.</li>
                        <li>Bot sessions in groups bound to this account will be unlinked.</li>
                      </>
                    ) : (
                      <>
                        <li>灵感会保留下来，转为工作区共享（它们本就可以不属于任何账号）。</li>
                        <li>采集台账保留：它是「什么时候采了什么」的合规凭证，账号名已存了快照。</li>
                        <li>群里绑定到这个账号的机器人会话会解绑，下次要重新指定账号。</li>
                      </>
                    )}
                  </ul>
                  <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
                    <input
                      className="input"
                      style={{ maxWidth: 220 }}
                      placeholder={lang === 'en' ? `Type "${getAccName(a.name)}" to confirm` : `输入「${getAccName(a.name)}」以确认`}
                      value={confirmText}
                      onChange={(e) => setConfirmText(e.target.value)}
                    />
                    <button
                      className="btn btn-sm btn-primary"
                      style={{ background: 'var(--red)', borderColor: 'var(--red)' }}
                      disabled={pending || (confirmText.trim() !== a.name && confirmText.trim() !== getAccName(a.name))}
                      onClick={() => submitDelete(a.id)}
                    >
                      {pending ? (lang === 'en' ? 'Deleting…' : '删除中…') : (lang === 'en' ? 'Permanently Delete' : '彻底删除')}
                    </button>
                    <button className="btn btn-sm btn-ghost" disabled={pending} onClick={closePanel}>{lang === 'en' ? 'Cancel' : '取消'}</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 新建账号入口或展开表单 */}
      {creating ? (
        formBody(submitCreate, lang === 'en' ? 'Create & Switch →' : '创建并切换到该账号 →', true)
      ) : (
        <div style={{ marginTop: 4 }}>
          <button
            className="btn btn-sm btn-primary"
            style={{ height: 34, padding: '0 14px' }}
            onClick={() => {
              setCreating(true);
              setEditingId(null);
              setPanel(null);
              setForm({ name: '', platform: 'douyin', handle: '' });
            }}
          >
            <Icon.plus size={14} /> {lang === 'en' ? 'New Account' : '新建账号'}
          </button>
        </div>
      )}

      {err && <span className="small" style={{ color: 'var(--red)', fontWeight: 600 }}>{err}</span>}
    </div>
  );
}

