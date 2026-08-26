// 允许「服务端派活让我打开并读取」的站点清单 —— 插件端这一份是**真正的防线**。
//
// 【为什么服务端校验不够】插件连的服务端地址是可配置的：zip 版用户自己填、私有化部署
// 各连各的、本机开发连 localhost。只在服务端校验，等于「插件无条件信任服务端」——
// 一个被改过地址、或被攻陷的服务端，就能让用户**已登录的浏览器**去打开任意网址。
// bridge.js 那次 localhost 端口漏洞的教训原文：锚一旦可以被外部改写，防线就不存在。
//
// 【三条比对规则，一条都不能松】
//   ① 一律 `new URL(u).origin` **全等**。绝不做 hostname 的子串或后缀匹配——
//      `endsWith('douyin.com')` 会放行 `www.douyin.com.evil.com`；
//      比 hostname 不比 origin，会被 http:// 与非常规端口冒充。
//   ② 只认 https。http 明文可被中间人改写成任意内容，而这段内容会被送进模型。
//   ③ 标签页**加载完成后按最终 URL 再验一次**。白名单域里到处是跳转口
//      （b23.tv、t.cn、youtube.com/redirect、微博短链）——派单时校验通过的 URL，
//      落地可以是任意站点。不复验等于白名单只挡住了老实人。
//
// ⚠️ 这份清单必须与 lib/browser-task/read-allowlist.ts 保持一致，
//    tests/ingest/read-allowlist-sync.test.ts 会逐条对账。改一边漏一边的后果是：
//    服务端排得出来的活，插件这边永远拒绝执行（用户看到的是「一直失败」）。

const BEACON_READ_ALLOWED_ORIGINS = [
  // 短视频
  'https://www.douyin.com',
  'https://www.bilibili.com',
  'https://www.kuaishou.com',
  'https://www.tiktok.com',
  // 图文 / 社区
  'https://www.xiaohongshu.com',
  'https://www.zhihu.com',
  'https://zhuanlan.zhihu.com',
  'https://weibo.com',
  'https://www.weibo.com',
  // 文章 / 资讯
  'https://mp.weixin.qq.com',
  'https://www.toutiao.com',
  'https://baijiahao.baidu.com',
  // 海外
  'https://x.com',
  'https://twitter.com',
  'https://www.youtube.com',
];

function beaconReadAllowed(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  return BEACON_READ_ALLOWED_ORIGINS.includes(u.origin);
}

globalThis.BEACON_READ_ALLOWED_ORIGINS = BEACON_READ_ALLOWED_ORIGINS;
globalThis.beaconReadAllowed = beaconReadAllowed;
