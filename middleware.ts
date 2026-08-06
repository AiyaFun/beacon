import { NextRequest, NextResponse } from 'next/server';
import { AUTH_COOKIE, AUTH_COOKIE_MAX_AGE_S } from '@/lib/auth-constants';

// 边缘中间件：仅做 cookie 存在性快速拦截（真正校验在 getSession）。
// 未登录访问受保护页面 → 跳 /login。

// 公开路径：不做登录态拦截。
// ⚠️ /api/pay/notify 是微信支付回调 —— 微信服务器不可能带我们的登录 cookie，
// 拦了它就是 307 跳 /login，微信永远收不到 204，会重发 15 次后判定商户失败（用户付了钱不到账）。
// 放行**不等于**不设防：该路由自己用微信支付公钥验签 + APIv3 解密（app/api/pay/notify/route.ts），
// 未配凭证时直接 503 拒绝，没有任何 Mock 分支。鉴权在路由内部，靠的是密码学而不是 cookie。
// ⚠️ /hotlists 是游客可只读浏览的公开演示页（app/(public)/hotlists）。它只读全局热榜表、
// 不碰任何 llmComplete/写操作；其上的「结合分析/重新采集」只对登录用户渲染，且对应 server action
// 各自 getSession()+requireRole 自守卫。放行它**不等于**放行 (app) 组——(app)/layout 的
// redirect('/login') 仍是受保护页的唯一 choke point，未在此列的路径一律跳登录。
// ⚠️ /api/pay/refund-notify：微信退款结果回调，同 /api/pay/notify —— 微信不带我们的 cookie，
//    路由内部用微信支付公钥验签 + APIv3 解密自守卫，未配凭证 503，无 Mock 分支。
// ⚠️ /api/internal/pay/refund：内部受控退款接口，ops 用 curl 调（无登录 cookie）。
//    路由内部用 BEACON_ADMIN_TOKEN 常量时间比较守卫，未配 token 则 503（通道默认关闭）。
// ⚠️ /api/ingest/competitor：浏览器插件回传竞对公开数据（authorized 通道）——插件的 fetch
//    不带登录 cookie。路由内部用工作区采集令牌（Workspace.ingestToken）自守卫，无令牌 401。
// ⚠️ /api/ingest/self：插件回传**自有作品**表现数据（同上 authorized 通道，同一采集令牌自守卫）。
const PUBLIC_PATHS = [
  '/login',
  '/hotlists',
  '/legal',
  '/robots.txt',
  '/sitemap.xml',
  // PWA 清单：浏览器在**登录页**上就会去取它（决定「添加到主屏幕」是否可用），
  // 而那时用户按定义还没登录。拦了它 = 307 跳 /login = 浏览器拿到一份 HTML 当 manifest，
  // 安装入口整个消失。清单里只有站名/图标/主题色，无任何租户数据。
  '/manifest.webmanifest',
  // 采集助手安装包（浏览器插件 zip）——公开可下载、非敏感，且要能分享/免登直取。
  '/downloads',
  '/api/health',
  '/api/pay/notify',
  '/api/pay/refund-notify',
  '/api/internal/pay/refund',
  '/api/ingest/competitor',
  '/api/ingest/self',
  '/api/ingest/inspiration',
  // 插件「一键拆解这条作品」：与 inspiration 同一枚令牌、同一条权限面（只写本工作区资讯库）
  '/api/ingest/analyze',
  // 插件评论提问入库：同一枚令牌自守卫 + 服务端四道二次校验（剥前缀/PII/判定/敏感词）
  '/api/ingest/questions',
  // 插件版本探询（只回版本号 + 公开下载地址，无鉴权、无租户数据）。
  // 必须放行：插件的 service worker 没有登录 cookie，被 307 到 /login 会拿到一份 HTML，
  // 于是「检查更新」永远失败且看不出原因。
  '/api/ingest/version',
  // ⚠️ /api/bot：飞书等平台机器人事件回调（authorized 通道）——平台服务器的请求不带登录
  //    cookie。路由内部用 inboundKey(app_id) 反查工作区 + Verification Token/签名自守卫，
  //    无效即拒。见 app/api/bot/feishu/events/[key]/route.ts。
  '/api/bot',
  // ⚠️ /api/auth/wechat：微信 OAuth 登录（redirect 发起 + callback 回调）——
  //    用户未登录才需要走这条路；回调来自微信 302，不带我们的 cookie。
  //    redirect 路由自身用 state cookie + CSRF 校验守卫；callback 用 state 比对防伪造。
  '/api/auth/wechat',
  // ⚠️ /api/auth/email/confirm：邮箱绑定确认链接——用户从邮件客户端点进来，
  //    很可能不带我们的 cookie。路由内部用主密钥 HMAC 签名的令牌自守卫（24h 过期），
  //    伪造不了；拦了它则所有确认链接都会先跳登录再丢失 token。
  '/api/auth/email',
];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const token = req.cookies.get(AUTH_COOKIE)?.value;
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'));

  if (!token && !isPublic) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }
  const res = NextResponse.next();
  // cookie 滑动续期：每次访问都把 maxAge 重置回满额，与 DB 会话的滑动续期
  //（getMemberByToken）配对——日常活跃用户永不掉线。这里不查库：cookie 只是载体，
  // 会话真伪与寿命仍由 DB 侧裁决（游客 cookie 也会被续，但其 1 天 DB 会话到期即失效，无害）。
  if (token) {
    res.cookies.set(AUTH_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: AUTH_COOKIE_MAX_AGE_S,
    });
  }
  return res;
}

export const config = {
  // 跳过静态资源与 Next 内部；其余走鉴权
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
