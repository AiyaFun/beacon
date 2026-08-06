// 烽火台 app ↔ 插件 桥接。只注入烽火台自己的域名。
// 作用：让 app「对标账号」卡片里的「一键采集」按钮驱动插件批量采集，并把进度回传给页面。
// app 与本脚本同处一个窗口，用 window.postMessage 通信；本脚本再转发给后台 service worker。
//
// 安全：只处理来自本窗口(e.source===window)的消息；触发的只是「打开用户自己订阅的竞对公开主页并采集」
// 这一无害动作（等价于用户逐个点开），不涉及任何越权。

(function () {
  const announce = () => window.postMessage({ __beacon: 'ext-present' }, '*');
  announce(); // 页面加载即宣告插件在场，app 据此启用按钮

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || typeof e.data !== 'object') return;
    const d = e.data;
    if (d.__beacon === 'ping') { announce(); return; }
    if (d.__beacon === 'config-token' && d.host && d.token) {
      chrome.storage.sync.set({ host: d.host, token: d.token }, () => {
        window.postMessage({ __beacon: 'config-token-done' }, '*');
      });
      return;
    }
    // 账号注销后的对称动作：令牌此刻在服务端已随工作区一并作废，但插件本机还留着令牌串
    // 和一整套工作区缓存（竞对清单/账号清单/工作区名）。交给 sw.js 统一清——
    // 闹钟只有后台停得掉，内容脚本碰不到 chrome.alarms。
    if (d.__beacon === 'clear-token') {
      chrome.runtime
        .sendMessage({ type: 'beacon-unlink', reason: d.reason || '' })
        .then(() => window.postMessage({ __beacon: 'clear-token-done' }, '*'))
        .catch(() => {});
      return;
    }
    if (d.__beacon === 'batch-collect') {
      chrome.runtime.sendMessage({ type: 'batch-collect' }).catch(() => {});
    }
  });

  // 后台的批量进度（chrome.tabs.sendMessage 送到本内容脚本）→ 转发给 app 页面
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && (msg.type === 'batch-progress' || msg.type === 'batch-done')) {
      window.postMessage({ __beacon: msg.type, data: msg }, '*');
    }
    return undefined;
  });
})();
