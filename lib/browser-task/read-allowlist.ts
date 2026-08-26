// ── 「让插件去读一个网页」的域名白名单 ──────────────────────────────────────
//
// 【这份清单为什么存在】open_and_read 是唯一一个由**服务端指定 URL**、让用户已登录的
// 浏览器去打开的动作。没有白名单，它就是「把一个可远程驱动的浏览器交给模型」——
// 那不是功能，是漏洞（lib/browser-task/kinds.ts 文件头那条铁律）。
//
// 【三条硬规则，缺一条这道防线就等于没有】
//   ① **插件端必须有一份一模一样的、硬编码的清单**（extension/content/read-allowlist.js）。
//      只在服务端校验等于「插件无条件信任服务端」——而插件的服务端地址是可配的
//      （zip 版、私有化、本机开发），一个被改过地址或被攻陷的服务端就能下发任意 URL。
//      bridge.js 那次 localhost 端口漏洞的教训原文：锚一旦可以被外部改写，防线就不存在。
//   ② **比对一律 origin 全等**，绝不做 hostname 的子串/后缀匹配。
//      `endsWith('douyin.com')` 会放行 `www.douyin.com.evil.com`；
//      比 hostname 而不比 origin 会被 `http://` 与非常规端口冒充。
//   ③ **页面加载完成后要用最终 URL 再验一次**。白名单域里到处是跳转口
//      （b23.tv、t.cn、youtube.com/redirect、微博短链），派单时校验通过的 URL
//      落地可以是任意站点。服务端的 safeFetch 早就在做逐跳复验，插件这侧不能没有。
//
// 【为什么只放平台域】用户让 AI「看看这条链接讲什么」，指的几乎总是某个内容平台的页面。
// 放开任意域名的收益很小，而攻击面是整个互联网——包括用户公司的内网系统
//（他的浏览器对那些是有登录态的）。真要读别的站，服务端的 clip_url 就能抓，
// 走的是带 SSRF 护栏的 safeFetch，不需要动用用户的浏览器。

/**
 * 允许插件代为打开并读取的站点，**按 origin 全等比对**。
 *
 * 每一条都要能回答：用户为什么会想让 AI 读这里的页面？
 * 答不上来的不加——这份清单越短，那台浏览器的暴露面越小。
 */
export const BROWSER_READ_ALLOWED_ORIGINS: readonly string[] = [
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

/**
 * 这个 URL 允许让插件去读吗。
 *
 * 只认 origin 全等。任何「差不多就行」的匹配（子串、后缀、忽略协议）都会被
 * `www.douyin.com.evil.com` 这类域名骗过——那台浏览器带着用户的全部登录态。
 */
export function isReadAllowed(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  // 只走 https：http 明文可被中间人改写成任意内容，而这段内容会进模型上下文
  if (u.protocol !== 'https:') return false;
  return BROWSER_READ_ALLOWED_ORIGINS.includes(u.origin);
}

/** 给用户看的清单（设置页与拒绝文案用），去掉协议头更好读。 */
export function readAllowlistLabels(): string[] {
  return BROWSER_READ_ALLOWED_ORIGINS.map((o) => o.replace(/^https:\/\//, ''));
}
