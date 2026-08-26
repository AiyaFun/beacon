'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { actFetchMarket, actInstallFromMarket, actCheckSkillUpdates } from './actions';

// 技能市场。
//
// 【为什么要有它】此前「获取技能」只有两条路：平台内置（要发版才能加）、
// 用户自己粘一个链接。前者慢，后者只有已经知道该粘什么的人才用得上。
// 市场回答的是「有哪些现成的东西可以装」——这是新用户唯一问得出口的问题。
//
// 【入口收敛】这一页原来有四条获取路径（内置装/卸、从网址导入、自己写、封面工位直通），
// 用户得先弄懂它们的区别才能开始。现在统一成一个「添加技能」，
// 里面分三路：**从市场挑 / 贴个链接 / 自己写**。beaconPack 与宽松识别链的区别
// 是实现细节，不该让用户理解。
//
// 【一条必须说破的话】包里的 author 只是一行字，**没有签名机制**。
// 把它渲染成一枚「认证」徽章就是在骗人——所以这里明写「来源仅供参考」。

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

const KIND_LABEL: Record<string, string> = { skill: '技能', workflow: '智能体', persona: '人设' };

export function Market({ readOnly }: { readOnly: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [updates, setUpdates] = useState<Update[] | null>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  function load() {
    setErr(''); setMsg('');
    start(async () => {
      const r = await actFetchMarket();
      if (!r.ok) { setErr(r.error ?? '连不上市场'); setEntries([]); return; }
      setEntries(r.entries as Entry[]);
    });
  }

  function install(e: Entry) {
    setErr(''); setMsg('');
    start(async () => {
      const r = await actInstallFromMarket(e.url);
      if (!r.ok) { setErr(r.error ?? '装不上'); return; }
      setMsg(r.updated ? `「${r.name}」已更新到 ${e.version}` : `「${r.name}」装好了，去创作工坊就能用`);
      load();
      router.refresh();
    });
  }

  function check() {
    setErr(''); setMsg('');
    start(async () => {
      const r = await actCheckSkillUpdates();
      setUpdates(r.updates);
      if (r.updates.length === 0) setMsg('装着的都是最新的');
    });
  }

  return (
    <div>
      <div className="row wrap" style={{ gap: 8, marginBottom: 12 }}>
        <button className="btn btn-sm btn-primary" disabled={pending} onClick={load}>
          {entries === null ? '看看市场里有什么' : '刷新'}
        </button>
        <button className="btn btn-sm btn-ghost" disabled={pending} onClick={check}>
          检查更新
        </button>
        {msg && <span className="small" style={{ color: 'var(--green)' }}>{msg}</span>}
        {err && <span className="small" style={{ color: 'var(--red)' }}>{err}</span>}
      </div>

      {/* 检查更新的结果：**只报告，不自动更新**。
          上游一改用户手上那条技能就变了而没人告诉他，比「有新版本没装」糟得多 */}
      {updates && updates.length > 0 && (
        <div className="card" style={{ padding: 12, marginBottom: 12, borderColor: 'var(--amber)' }}>
          <b className="small">有 {updates.length} 个可以更新</b>
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
                      if (!r.ok) { setErr(r.error ?? '更新失败'); return; }
                      setMsg(`「${u.name}」已更新`);
                      setUpdates((list) => (list ?? []).filter((x) => x.skillId !== u.skillId));
                      router.refresh();
                    })}
                  >
                    更新
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {entries !== null && entries.length === 0 && !err && (
        <p className="small muted">市场里暂时是空的。</p>
      )}

      {entries !== null && entries.length > 0 && (
        <>
          <div className="stack" style={{ gap: 2 }}>
            {entries.map((e) => (
              <div key={`${e.kind}-${e.slug}`} className="tool-row">
                <span className="run-main">
                  <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: 13 }}>{e.emoji} {e.name}</strong>
                    <span className="badge badge-gray">{KIND_LABEL[e.kind] ?? e.kind}</span>
                    <span className="badge badge-gray">v{e.version}</span>
                    {e.state === 'installed' && <span className="badge badge-green">已装</span>}
                    {e.state === 'update_available' && (
                      <span className="badge badge-amber">可更新（装着 {e.installedVersion}）</span>
                    )}
                  </span>
                  <span className="small muted">
                    {e.description}
                    {e.author ? ` · 来源：${e.author}` : ''}
                  </span>
                </span>
                {!readOnly && e.state !== 'installed' && (
                  <button className="btn btn-sm" disabled={pending} onClick={() => install(e)}>
                    {e.state === 'update_available' ? '更新' : '装上'}
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* 这句话不能省：包里的 author 只是一行字，没有签名机制。
              渲染成一枚「认证」徽章就是在骗人 */}
          <p className="small muted" style={{ marginTop: 10, lineHeight: 1.8 }}>
            市场里的东西都是<b>提示词模板与步骤配置</b>，不含可执行代码——装上不会让它在你机器上跑任何程序。
            「来源」是包里自己声明的一行字，<b>不是经过认证的身份</b>；
            人设类装进来<b>默认不启用</b>，要你自己看过全文再打开（它会进每次生成的设定里）。
          </p>
        </>
      )}
    </div>
  );
}
