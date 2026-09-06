'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { actFetchMarket, actInstallFromMarket, actCheckSkillUpdates } from './actions';
import { useI18n } from '@/lib/i18n/context';

// 技能市场。
//
// 【为什么要有它】此前「获取技能」只有两条路：平台内置（要发版才能加）、
// 用户自己粘一个链接。前者慢，后者只有已经知道该粘什么的人才用得上。
// 市场回答的是「有哪些现成的东西可以装」——这是新用户唯一问得出口的问题。

type Entry = {
  kind: string;
  slug: string;
  name: string;
  description: string;
  emoji: string;
  version: string;
  author: string;
  platform: string;
  url: string;
  state: 'not_installed' | 'installed' | 'update_available';
  installedVersion?: string;
};

type Update = { skillId: string; name: string; installed: string; latest: string; sourceUrl: string };

const KIND_LABEL: Record<string, { zh: string; en: string }> = {
  skill: { zh: '技能', en: 'Skill' },
  workflow: { zh: '智能体', en: 'Agent' },
  persona: { zh: '人设', en: 'Persona' },
};

export function Market({ readOnly }: { readOnly: boolean }) {
  const router = useRouter();
  const { lang } = useI18n();
  const isEn = lang === 'en';
  const [pending, start] = useTransition();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [updates, setUpdates] = useState<Update[] | null>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  function load() {
    setErr(''); setMsg('');
    start(async () => {
      const r = await actFetchMarket();
      if (!r.ok) { setErr(r.error ?? (isEn ? 'Cannot connect to market' : '连不上市场')); setEntries([]); return; }
      setEntries(r.entries as Entry[]);
    });
  }

  function install(e: Entry) {
    setErr(''); setMsg('');
    start(async () => {
      const r = await actInstallFromMarket(e.url);
      if (!r.ok) { setErr(r.error ?? (isEn ? 'Failed to install' : '装不上')); return; }
      setMsg(r.updated
        ? (isEn ? `"${r.name}" updated to ${e.version}` : `「${r.name}」已更新到 ${e.version}`)
        : (isEn ? `"${r.name}" installed, ready to use in Studio` : `「${r.name}」装好了，去创作工坊就能用`));
      load();
      router.refresh();
    });
  }

  function check() {
    setErr(''); setMsg('');
    start(async () => {
      const r = await actCheckSkillUpdates();
      setUpdates(r.updates);
      if (r.updates.length === 0) setMsg(isEn ? 'All installed items are up to date' : '装着的都是最新的');
    });
  }

  return (
    <div>
      <div className="row wrap" style={{ gap: 8, marginBottom: 12 }}>
        <button className="btn btn-sm btn-primary" disabled={pending} onClick={load}>
          {entries === null ? (isEn ? 'Browse Market' : '看看市场里有什么') : (isEn ? 'Refresh' : '刷新')}
        </button>
        <button className="btn btn-sm btn-ghost" disabled={pending} onClick={check}>
          {isEn ? 'Check Updates' : '检查更新'}
        </button>
        {msg && <span className="small" style={{ color: 'var(--green)' }}>{msg}</span>}
        {err && <span className="small" style={{ color: 'var(--red)' }}>{err}</span>}
      </div>

      {/* 检查更新的结果：**只报告，不自动更新**。
          上游一改用户手上那条技能就变了而没人告诉他，比「有新版本没装」糟得多 */}
      {updates && updates.length > 0 && (
        <div className="card" style={{ padding: 12, marginBottom: 12, borderColor: 'var(--amber)' }}>
          <b className="small">{isEn ? `${updates.length} updates available` : `有 ${updates.length} 个可以更新`}</b>
          <div className="stack" style={{ gap: 4, marginTop: 6 }}>
            {updates.map((u) => (
              <div key={u.skillId} className="row-between small">
                <span>{u.name}　<span className="muted">{u.installed} → {u.latest}</span></span>
                {!readOnly && (
                  <button
                    className="btn btn-sm"
                    disabled={pending}
                    onClick={() => start(async () => {
                      const r = await actInstallFromMarket(u.sourceUrl);
                      if (!r.ok) { setErr(r.error ?? (isEn ? 'Update failed' : '更新失败')); return; }
                      setMsg(isEn ? `"${u.name}" updated` : `「${u.name}」已更新`);
                      setUpdates((list) => (list ?? []).filter((x) => x.skillId !== u.skillId));
                      router.refresh();
                    })}
                  >
                    {isEn ? 'Update' : '更新'}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {entries !== null && entries.length === 0 && !err && (
        <p className="small muted">{isEn ? 'The market is currently empty.' : '市场里暂时是空的。'}</p>
      )}

      {entries !== null && entries.length > 0 && (
        <>
          <div className="stack" style={{ gap: 2 }}>
            {entries.map((e) => (
              <div key={`${e.kind}-${e.slug}`} className="tool-row">
                <span className="run-main">
                  <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: 13 }}>{e.emoji} {e.name}</strong>
                    <span className="badge badge-gray">{isEn ? KIND_LABEL[e.kind]?.en ?? e.kind : KIND_LABEL[e.kind]?.zh ?? e.kind}</span>
                    <span className="badge badge-gray">v{e.version}</span>
                    {e.state === 'installed' && <span className="badge badge-green">{isEn ? 'Installed' : '已装'}</span>}
                    {e.state === 'update_available' && (
                      <span className="badge badge-amber">{isEn ? `Update available (${e.installedVersion})` : `可更新（装着 ${e.installedVersion}）`}</span>
                    )}
                  </span>
                  <span className="small muted">
                    {e.description}
                    {e.author ? (isEn ? ` · Author: ${e.author}` : ` · 来源：${e.author}`) : ''}
                  </span>
                </span>
                {!readOnly && e.state !== 'installed' && (
                  <button className="btn btn-sm" disabled={pending} onClick={() => install(e)}>
                    {e.state === 'update_available' ? (isEn ? 'Update' : '更新') : (isEn ? 'Install' : '装上')}
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* 这句话不能省：包里的 author 只是一行字，没有签名机制。
              渲染成一枚「认证」徽章就是在骗人 */}
          <p className="small muted" style={{ marginTop: 10, lineHeight: 1.8 }}>
            {isEn ? (
              <>
                Items in the market are <b>prompt templates and workflow configs</b> without executable code.
                &quot;Author&quot; is declared in the package and <b>not a verified identity</b>.
                Personas are <b>disabled by default</b> upon install until you review the full content.
              </>
            ) : (
              <>
                市场里的东西都是<b>提示词模板与步骤配置</b>，不含可执行代码——装上不会让它在你机器上跑任何程序。
                「来源」是包里自己声明的一行字，<b>不是经过认证的身份</b>；
                人设类装进来<b>默认不启用</b>，要你自己看过全文再打开（它会进每次生成的设定里）。
              </>
            )}
          </p>
        </>
      )}
    </div>
  );
}
