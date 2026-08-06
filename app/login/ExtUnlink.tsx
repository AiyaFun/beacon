'use client';

import { useEffect } from 'react';

// 账号注销后通知浏览器插件解绑（对称于 app/(app)/extension/ExtAutoConfig.tsx 的 config-token：
// 一个把令牌下发进插件，一个在注销时把它连同缓存一起收回来）。
//
// 服务端那半边**已经是对的**：注销时 Workspace 随 Tenant 级联删除，ingestToken 当场作废，
// 插件之后每一次回传都是 401。这个组件解决的是另一半——插件本机还留着令牌串、工作区名、
// 竞对清单、自有账号清单，而且定时闹钟还挂着，会每天照常起来撞一次 401 再弹一条失败通知。
//
// 【为什么挂在登录页而不是注销按钮上】actDeleteAccount 是 server action，成功即 redirect，
// 在按钮的点击处理里发消息时当前页已经在跳转了，postMessage 必然打空。落地页是唯一稳的时机。
//
// 【为什么要等 ext-present】content/bridge.js 是 document_idle 注入的，早于它的 postMessage
// 没有任何人在听。两头都堵：先挂监听等它主动宣告，再 ping 一次覆盖「它比 React 先加载完」那一路。
//
// 【为什么普通「退出」不做这件事】退出是日常动作，每天可能好几次；每次都把插件设置清空
// 是敌意设计。这里只对注销生效——注销之后那枚令牌在服务端本来就已经不存在了。
export function ExtUnlink({ scope }: { scope: 'tenant' | 'member' }) {
  useEffect(() => {
    const reason =
      scope === 'tenant'
        ? '账号已注销，采集令牌随工作区一并作废。插件已停止全部自动采集，并清除了本机缓存的工作区数据。'
        : '你已退出该工作区。插件的采集令牌与本机缓存已清除，不会再向该工作区回传数据。';

    let sent = false;
    const fire = () => {
      if (sent) return;
      sent = true;
      window.postMessage({ __beacon: 'clear-token', reason }, '*');
    };

    function onMessage(e: MessageEvent) {
      if (e.source !== window || !e.data || typeof e.data !== 'object') return;
      if ((e.data as { __beacon?: string }).__beacon === 'ext-present') fire();
    }

    window.addEventListener('message', onMessage);
    window.postMessage({ __beacon: 'ping' }, '*');
    return () => window.removeEventListener('message', onMessage);
  }, [scope]);

  return null;
}
