'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { actSetBrowserRead } from './actions';

// 「让插件替我打开指定网址并读取正文」的开关。
//
// 【为什么它单独一个开关、而且默认关】AI 能力清单里那些开关缺省全开，因为它们做的事
// 都在用户已经理解的范围内（查选题、建草稿）。这一个不一样：它是唯一一件
// **读哪一页由服务端决定**的动作，会让用户已登录的浏览器去打开一个他没点过的网址。
// 这种事不能靠默认值替他决定——用户得知道自己开了什么。
//
// 【为什么把清单摊开写在这里】只说「会读网页」而不说读哪些，用户没法判断要不要开。
// 清单直接从服务端那份常量渲染（与插件端硬编码的那份由测试逐条对账），
// 不在这里手写第二遍——手写的那份迟早与代码对不上，而对不上的方向通常是「写少了」。

export function BrowserReadSwitch({
  enabled,
  allowlist,
  readOnly,
}: {
  enabled: boolean;
  allowlist: string[];
  readOnly: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [local, setLocal] = useState(enabled);
  const [err, setErr] = useState('');

  function toggle(next: boolean) {
    setLocal(next); // 乐观：等一次往返再翻会让人以为没点上
    setErr('');
    start(async () => {
      try {
        await actSetBrowserRead(next);
      } catch (e) {
        // 权限不够 / 演示租户只读：把开关翻回去，并如实说原因。
        // 不翻回去的话，界面上显示「已开启」而库里还是关的——用户会以为开了却一直不生效
        setLocal(!next);
        setErr((e as Error).message.slice(0, 120) || '没改成');
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="card" style={{ padding: 14, marginTop: 12 }}>
      <div className="row-between wrap" style={{ gap: 10, alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 650 }}>
            让插件替我打开网页并读正文
            <span className="badge badge-gray" style={{ marginLeft: 8 }}>默认关闭</span>
          </div>
          <p className="small muted" style={{ margin: '6px 0 0', lineHeight: 1.75 }}>
            开启后，你让 AI 看一条链接、而服务端又抓不到那个平台的内容时（要登录、或整页靠 JS 渲染），
            它会在你的浏览器里用<b>后台标签页</b>打开这一页、把正文读回来、读完立即关闭。
            <b>只读不动</b>：不点击、不填写、不提交、不读 Cookie。
          </p>
        </div>
        <label className="row" style={{ gap: 6, flexShrink: 0, cursor: readOnly ? 'not-allowed' : 'pointer' }}>
          <input
            type="checkbox"
            checked={local}
            disabled={readOnly || pending}
            onChange={(e) => toggle(e.target.checked)}
          />
          <span className="small">{local ? '已开启' : '未开启'}</span>
        </label>
      </div>

      <details style={{ marginTop: 10 }}>
        <summary className="small" style={{ cursor: 'pointer' }}>
          只能打开这 {allowlist.length} 个站点（清单写死在插件里，别的一律拒绝）
        </summary>
        <div className="small muted" style={{ marginTop: 8, lineHeight: 1.9 }}>
          {allowlist.join('　·　')}
          <p style={{ margin: '8px 0 0' }}>
            这份清单<strong>硬编码在插件里、由插件自己校验</strong>，不是由服务端说了算——
            即使服务端下发清单以外的网址，插件也会拒绝。页面跳转之后还会按最终网址再验一次
            （这些站点里有短链和跳转页），落到清单以外就放弃、不读取、不回传。
          </p>
        </div>
      </details>

      {err && <div className="small" style={{ marginTop: 8, color: 'var(--red)' }}>{err}</div>}
    </div>
  );
}
