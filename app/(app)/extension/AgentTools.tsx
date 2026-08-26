'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { actToggleAgentTool } from './actions';

// 「AI 能力」清单 + 开关。
//
// 【为什么留在采集助手这一页】这一页回答的是「接进来之后它能干什么」：
// 上半页是浏览器扩展能采到什么，这一段是 AI 能替你动什么。同一个问题的两半，
// 分两页反而要问「我要找的那个在哪一页」。任务台侧栏的「能力」直接指这张卡（#abilities）。
//
// 【但「插件」这个词已经不再指它了】2026-08-20 收口：插件 = 浏览器扩展（用户要去装的东西），
// 这批叫**能力**（AI 会替他做的事）——后者跟智能体、技能是同一个问题的三个答案，
// 跟「我该装什么」无关。四类的分工见 lib/agent/roles.ts，页面上就印在这张卡顶部。
//
// 【只读成员看得到但改不了】清单本身是有价值的信息（AI 到底能干什么），
// 藏起来只会让人以为 AI 什么都能干或什么都不能干。

export type ToolRow = {
  name: string;
  label: string;
  description: string;
  write: boolean;
  costly: boolean;
  enabled: boolean;
  allowedByRole: boolean;
};

export function AgentTools({ tools, readOnly }: { tools: ToolRow[]; readOnly: boolean }) {
  const router = useRouter();
  const [, start] = useTransition();
  const [err, setErr] = useState('');
  /**
   * 正在提交的那一项。
   *
   * 【为什么不能直接用 useTransition 的 pending】它是**整个组件共享的一个布尔**：
   * 拿它去 disable 每一行的 checkbox，点任意一个开关，33 行会一起变灰再一起恢复——
   * 用户 2026-08-26 的原话「点能力的开关，直接整排暗了再关闭和开」。
   * 与模板市场 busyId 那次是同一个坑（tests/workflow/market-ui.test.ts 钉着那条）。
   */
  const [busy, setBusy] = useState('');
  // 乐观开关：等一次往返再翻会让人以为没点上，于是连点两下把它又关回去
  const [local, setLocal] = useState<Record<string, boolean>>({});

  function toggle(name: string, next: boolean) {
    setLocal((m) => ({ ...m, [name]: next }));
    setErr('');
    setBusy(name);
    start(async () => {
      const r = await actToggleAgentTool(name, next);
      // 必须在**任何 return 之前**清掉，否则失败那一行会一直卡在禁用态
      setBusy('');
      if (!r.ok) {
        setErr(r.error ?? '改不动，请重试');
        setLocal((m) => ({ ...m, [name]: !next })); // 失败翻回去，别让界面撒谎
        return;
      }
      router.refresh();
    });
  }

  const on = (t: ToolRow) => local[t.name] ?? t.enabled;
  const offCount = tools.filter((t) => !on(t)).length;

  return (
    <div>
      <div className="row wrap" style={{ gap: 8, marginBottom: 12 }}>
        <span className="badge badge-gray">共 {tools.length} 项</span>
        {offCount > 0 && <span className="badge badge-amber">已关闭 {offCount} 项</span>}
        <span className="small muted">关掉之后 AI 既看不到它，也调不动它。</span>
      </div>

      {err && <p className="small" style={{ color: 'var(--red)' }}>{err}</p>}

      <div className="stack" style={{ gap: 2 }}>
        {tools.map((t) => {
          const enabled = on(t);
          return (
            <div key={t.name} className="tool-row">
              <span className="tool-main">
                <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  <strong style={{ fontSize: 13 }}>{t.label}</strong>
                  <code className="small muted">{t.name}</code>
                  {t.write && <span className="badge badge-amber">会改数据</span>}
                  {t.costly && <span className="badge badge-gray">花配额</span>}
                  {!t.allowedByRole && <span className="badge badge-gray">你的角色用不了</span>}
                </span>
                <span className="small muted">{t.description}</span>
              </span>
              <label className="row small" style={{ gap: 6, flexShrink: 0, cursor: readOnly ? 'default' : 'pointer' }}>
                <input
                  type="checkbox"
                  checked={enabled}
                  disabled={readOnly || busy === t.name}
                  onChange={() => toggle(t.name, !enabled)}
                  aria-label={`${t.label} 开关`}
                />
                <span className={enabled ? undefined : 'muted'}>{enabled ? '开' : '关'}</span>
              </label>
            </div>
          );
        })}
      </div>

      {readOnly && (
        <p className="small muted" style={{ marginTop: 10 }}>
          你的角色可以查看这份清单，但改开关需要管理员权限（与模型接入同一档）。
        </p>
      )}
    </div>
  );
}
