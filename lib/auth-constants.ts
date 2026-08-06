// 轻量常量（可安全被 Edge 中间件引入，无 Prisma 依赖）
export const AUTH_COOKIE = 'beacon_session';
// 当前操作的创作者账号（多账号切换；仅存 accountId，服务端校验归属）
export const ACCOUNT_COOKIE = 'beacon_account';
// 登录 cookie 寿命（秒）。与 DB 会话 90 天 TTL 配对；两端都滑动续期：
// middleware 每次访问刷新 cookie，getMemberByToken 在剩余不足一半时延长 DB 会话。
// 日常活跃用户因此永不掉线；连续 90 天未访问才需重新登录。
export const AUTH_COOKIE_MAX_AGE_S = 90 * 24 * 3600;
