'use client';

import { useState, useTransition } from 'react';
import { Card } from '@/components/ui';
import { actSaveShellPolicy } from './shell-actions';

/**
 * 本机命令执行的开关与白名单（只在整机版/私有化出现）。
 *
 * 【为什么这张卡的文案这么直白】命令白名单**不可能滴水不漏**——允许了 git 就等于允许
 * `git -c core.pager=…`，允许了 find 就等于允许 `find -exec`。代码里挡住了几个最常见的口子，
 * 但真正的边界是用户自己选了哪些命令。把这句话藏起来，用户会以为「勾了白名单=安全」，
 * 那比不给这个功能更糟。
 */
export function LocalShellCard({
  enabled, allow, root, mode, timeoutSec, cdpUrl, canBrowser,
}: { enabled: boolean; allow: string[]; root: string | null; mode: string; timeoutSec: number; cdpUrl: string | null; canBrowser: boolean }) {
  const [on, setOn] = useState(enabled);
  const [list, setList] = useState(allow.join(' '));
  const [dir, setDir] = useState(root ?? '');
  const [full, setFull] = useState(mode === 'full');
  const [secs, setSecs] = useState(String(timeoutSec));
  const [cdp, setCdp] = useState(cdpUrl ?? '');
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <Card title="本机命令执行" sub="让 AI 在这台机器上跑命令 · 默认关闭">
      <p className="small muted" style={{ margin: '0 0 12px', lineHeight: 1.9 }}>
        开启后，AI 可以在<b>你指定的目录里</b>执行<b>你列出的命令</b>。不经 shell——
        管道、<code className="mono">;</code>、<code className="mono">&&</code> 这些不会被解释，
        参数里指向目录外的路径会被拒绝。
      </p>
      <p className="small" style={{ margin: '0 0 12px', lineHeight: 1.9, color: 'var(--amber-ink, var(--text-2))' }}>
        <b>请认真对待这份清单。</b>命令白名单挡不住「被允许的命令自己能干的事」——
        放行 <code className="mono">git</code> 就等于放行它的配置项，放行 <code className="mono">python3</code>
        就等于放行任意代码。<b>只列你自己真的会让它用的命令。</b>
      </p>

      <label className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 10 }}>
        <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />
        <span className="small">开启本机命令执行</span>
      </label>

      <div className="stack" style={{ gap: 8 }}>
        <label className="small">
          工作目录（只能在它和它的子目录里动；<b>留空则一律不许跑</b>）
          <input className="input" value={dir} onChange={(e) => setDir(e.target.value)} placeholder="/Users/你/工作目录" />
        </label>
        <label className="small">
          允许的命令（空格分隔，只写命令名不带路径）
          <input className="input" value={list} onChange={(e) => setList(e.target.value)} placeholder="git ls cat" disabled={full} />
        </label>
        <label className="small">
          单条命令超时（秒）。装东西（npm / pip install）动辄几分钟，默认 20 秒会把它直接掐断
          <input className="input" value={secs} onChange={(e) => setSecs(e.target.value)} inputMode="numeric" placeholder="20" />
        </label>

        {/* 【为什么把这一档明明白白摆出来】用户要「能开终端」。而一旦能开终端，
            命令白名单在语义上就不存在了——他敲一句 bash 就什么都能跑。
            与其让白名单在暗地里失效（那是安全剧场），不如给一个他自己知道选了什么的档。 */}
        <label className="row" style={{ gap: 8, alignItems: 'flex-start', marginTop: 4 }}>
          <input type="checkbox" checked={full} onChange={(e) => setFull(e.target.checked)} style={{ marginTop: 5 }} />
          <span className="small">
            <b>不限命令（终端档）</b>
            <span className="muted" style={{ display: 'block', lineHeight: 1.8 }}>
              勾上之后清单失效，AI 能在工作目录里跑<b>任何命令</b>，等于把这台机器在那个目录内交给它。
              目录边界、超时、输出上限仍然生效。<b>只在你完全信任这台机器的用途时才勾。</b>
            </span>
          </span>
        </label>
      </div>

      {/* 本机浏览器驱动：与命令执行同属「这台机器上的能力」，放一张卡里，
          免得用户在两处找同一类开关。**留空即关闭**——不另设开关，
          少一个会和实际状态对不上的字段。 */}
      {canBrowser && (
        <>
          <div className="divider" />
          <b className="small">用本机浏览器抓取</b>
          <p className="small muted" style={{ margin: '4px 0 10px', lineHeight: 1.85 }}>
            填了调试端点之后，AI 能用<b>你自己这个 Chrome</b> 打开网页读内容——
            需要登录才看得见的东西也读得到，因为用的就是你的登录态。
            <b>它只读</b>：不点击、不填写、不提交任何表单，也<b>不会替你输入账号密码</b>。
            也不会去看你已经开着的那些标签，每次都新开一个页面、用完关掉。
          </p>
          <label className="small">
            浏览器调试端点（留空 = 关闭；只能填本机地址）
            <input className="input" value={cdp} onChange={(e) => setCdp(e.target.value)} placeholder="http://127.0.0.1:9222" />
          </label>
          <p className="small muted" style={{ margin: '6px 0 0', lineHeight: 1.85 }}>
            <b>推荐做法：</b>在桌面客户端的托盘菜单点<b>「启动采集浏览器」</b>，
            端点就是上面这个默认值，什么都不用敲。
          </p>
          {/* 【必须说破的两件事】不写清楚，用户上线才会撞上，而且都会先怀疑是我们坏了：
              ① Chrome 同一个 profile 只跑一个进程，**运行中的 Chrome 无法再打开调试端口**——
                 他日常那个开着的话，带参数再启动什么都不会发生；
              ② 调试端口开着时，本机任何程序都能驱动这个浏览器。 */}
          <p className="small muted" style={{ margin: '6px 0 0', lineHeight: 1.85 }}>
            用的是你<b>自己的 Chrome 和已有登录态</b>，不用重新登录任何网站。
            但 Chrome 有个限制：<b>已经开着的 Chrome 没法再打开调试端口</b>——
            所以第一次要<b>完全退出 Chrome</b>（macOS 按 ⌘Q，不是关窗口）再启动一次，
            重开后标签页和登录态都还在。
          </p>
          <p className="small" style={{ margin: '6px 0 0', lineHeight: 1.85, color: 'var(--text-2)' }}>
            <b>要知道的代价：</b>调试端口开着的时候，这台电脑上<b>任何本地程序</b>都能驱动这个浏览器
            （Chrome 只把它绑在本机、不对外网开放）。不采集的时候，正常关掉 Chrome 再普通启动即可。
          </p>
        </>
      )}

      <div className="row" style={{ gap: 8, marginTop: 12, alignItems: 'center' }}>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={pending}
          onClick={() => {
            setMsg(null);
            start(async () => {
              const r = await actSaveShellPolicy({ enabled: on, allow: list, root: dir, full, timeoutSec: secs, cdpUrl: cdp });
              setMsg(r.ok ? '已保存' : (r.error ?? '保存失败'));
            });
          }}
        >
          {pending ? '保存中…' : '保存'}
        </button>
        {msg && <span className="small muted">{msg}</span>}
      </div>
    </Card>
  );
}
