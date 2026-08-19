// 烽火台 app ↔ 插件 桥接。只注入烽火台自己的域名。
// 作用：让 app「对标账号」卡片里的「一键采集」按钮驱动插件批量采集，并把进度回传给页面。
// app 与本脚本同处一个窗口，用 window.postMessage 通信；本脚本再转发给后台 service worker。
//
// 安全：只处理来自本窗口(e.source===window)的消息；触发的只是「打开用户自己订阅的竞对公开主页并采集」
// 这一无害动作（等价于用户逐个点开），不涉及任何越权。
//
// ⚠️ 但 `config-token` 不属于「无害动作」，它写的是采集回传的目的地。
// **Chrome 的 match pattern 不认端口**：manifest 里的 `http://localhost/*` 覆盖的是本机
// **任意端口**上的任意页面，不只是本项目的 dev server。也就是说，用户本机随便跑起来的一个
// 网页（或它上面的一个 XSS）都能拿到这条桥，把 host 改到攻击者的服务器上——此后每一批
// 采集数据都会规规矩矩地 POST 过去，界面上一切正常。
//
// 端口既然在 manifest 层拦不住，就在这里拦：**host 只允许是「这个页面自己的源」或生产地址**。
// 这样 dev（localhost:3000 配 localhost:3000）和线上都照常工作，而任何页面都无法把插件
// 指向一个第三方域名。
(function () {
  // 与 sw.js 的 DEFAULT_HOST 同一个值。写死在这里是有意的：它是白名单的锚，
  // 一旦可被页面改写，这条防线就等于不存在。
  const PROD_HOST = 'https://beacon.iyunci.cn';

  /** 页面递来的 host 能不能用作回传目的地 */
  function hostAllowed(raw) {
    let u;
    try {
      u = new URL(String(raw));
    } catch {
      return false; // 连合法 URL 都不是
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    const norm = u.origin;
    return norm === location.origin || norm === PROD_HOST;
  }

  const announce = () => window.postMessage({ __beacon: 'ext-present' }, '*');
  announce(); // 页面加载即宣告插件在场，app 据此启用按钮

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || typeof e.data !== 'object') return;
    const d = e.data;
    if (d.__beacon === 'ping') { announce(); return; }
    if (d.__beacon === 'config-token' && d.host && d.token) {
      // 拒绝要说出来。静默失败的话，页面上那颗按钮会一直转到 5 秒超时报「失败」，
      // 而真正的原因（host 不在白名单）没有任何地方看得到。
      // token 只做「不是垃圾」的最低限度校验，**不赌格式**：现行令牌是 bcn_+48 位 hex
      // （lib/ingest/token.ts:20），但库里还留着一枚更早的工作区级令牌，生成方式已无从考证。
      // 猜窄了就是让老用户配不上而且看不出原因。真正的防线是上面那条 host 白名单。
      if (!hostAllowed(d.host) || typeof d.token !== 'string' || !/^\S{8,300}$/.test(d.token)) {
        window.postMessage({ __beacon: 'config-token-rejected', reason: 'host-or-token-not-allowed' }, '*');
        return;
      }
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
