// 轻量常量（可安全被 Edge 中间件引入，无 Prisma 依赖）
export const AUTH_COOKIE = 'beacon_session';
// 当前操作的创作者账号（多账号切换；仅存 accountId，服务端校验归属）
export const ACCOUNT_COOKIE = 'beacon_account';
// 登录 cookie 寿命（秒）。与 DB 会话 90 天 TTL 配对；两端都滑动续期：
// middleware 每次访问刷新 cookie，getMemberByToken 在剩余不足一半时延长 DB 会话。
// 日常活跃用户因此永不掉线；连续 90 天未访问才需重新登录。
export const AUTH_COOKIE_MAX_AGE_S = 90 * 24 * 3600;

/**
 * 中间件把**规范化后的请求路径**写进这个请求头，交给服务端布局读（2026-09-05）。
 *
 * 【为什么需要它】(app)/layout 是受保护页的唯一登录闸，但 `/`、`/desktop`、`/extension`
 * 三页要对陌生人开放只读版（公开首页 / 下载页不该先要手机号）。服务端布局拿不到 pathname，
 * 只能由中间件带进来。中间件用 `set` 覆盖（不是 append），客户端自己伪造这个头没有意义：
 * 未登录访问非公开路径在中间件那一步就已经 307 到 /login，根本到不了布局。
 */
export const PATHNAME_HEADER = 'x-beacon-pathname';

/**
 * (app) 组里**允许未登录只读浏览**的那几页。
 * 页面自己要用 getSessionOrNull 并渲染游客分支——布局只负责「不跳登录」。
 * 同一份清单也是 middleware PUBLIC_PATHS 的一部分（那边逐条写死，tests/launch 守着一致）。
 */
export const GUEST_READABLE_APP_PATHS: readonly string[] = ['/', '/desktop', '/extension'];

/**
 * 登录 cookie 要不要带 Secure。
 *
 * SaaS 上 = 生产即 true（与改造前逐字等价：生产必然是 https）。
 *
 * 【为什么企业版不能照抄】
 * appliance 整机默认跑在 `http://localhost:<端口>`，而 NODE_ENV 是 production ——
 * 照抄就会给一个明文 http 页面下发 Secure cookie。Chrome 和 Firefox 把 localhost 当可信源，
 * 照收不误；**Safari 会直接丢掉它**。表现是：装机第一步登进去，刷新一下又回到登录页，
 * 全程没有任何报错。所以口径改成「以站点 URL 的协议为准」，而那个值由安装脚本写死。
 */
export function authCookieSecure(): boolean {
  const url = (process.env.BEACON_SITE_URL || process.env.BEACON_PUBLIC_URL || '').trim();
  if (url) return url.startsWith('https://');
  return process.env.NODE_ENV === 'production';
}
