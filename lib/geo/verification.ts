import type { Metadata } from 'next';

// 站长平台的**站点归属验证**（2026-09-17）。
//
// ── 为什么这是「快速收录」的第一步，而不是可选项 ──
// 百度资源平台、Bing Webmaster、Google Search Console、头条/搜狗/360/神马，
// 每一家在让你**提交链接、看抓取诊断、主动推送**之前，都要先证明这个站是你的。
// 验证方式有三种：HTML 文件、DNS TXT、**meta 标签**。前两种要么要往服务器上丢文件、
// 要么要动 DNS；meta 标签这种是唯一能跟着代码走、部署即生效的。
//
// 没有这一步，下面这些全都做不了：
//   · 手动提交 URL / 主动推送 API（百度普通收录要 token，token 在验证后的站点里拿）
//   · 「为什么我的页没被收录」的抓取诊断
//   · sitemap 递交状态（递交了但读不到，只有站长后台会告诉你）
//
// ── 为什么读 env 而不是写死 ──
// 验证码是**每个站点、每个账号**一串，写死等于把作者的账号绑进代码。
// 私有化部署的客户拿到这份代码时，用的是他们自己的域名和站长账号。
//
// ⚠️ **没填就一个标签都不输出**。空的 `<meta name="baidu-site-verification" content="">`
//    比没有更糟：站长平台会判定「标签存在但内容为空」→ 验证失败，而你会以为是自己填错了码。

/**
 * 各家站长平台的 meta 名字。
 *
 * 【这些名字不能猜】每一家都不一样，且都是各自后台复制出来的原样字符串：
 *   百度   baidu-site-verification
 *   Bing   msvalidate.01          ← 不是 bing-site-verification
 *   头条   bytedance-verification-code
 *   搜狗   sogou_site_verification ← 下划线，不是连字符
 *   360    360-site-verification
 *   神马   shenma-site-verification（夸克搜索用的也是神马这套）
 * Google 与 Yandex 由 Next 的 metadata.verification 原生支持，不走 other。
 */
const OTHER_ENGINES: readonly { env: string; meta: string; label: string }[] = [
  { env: 'BEACON_VERIFY_BAIDU', meta: 'baidu-site-verification', label: '百度资源平台' },
  { env: 'BEACON_VERIFY_BING', meta: 'msvalidate.01', label: 'Bing Webmaster' },
  { env: 'BEACON_VERIFY_BYTEDANCE', meta: 'bytedance-verification-code', label: '头条/抖音搜索' },
  { env: 'BEACON_VERIFY_SOGOU', meta: 'sogou_site_verification', label: '搜狗站长' },
  { env: 'BEACON_VERIFY_360', meta: '360-site-verification', label: '360 站长' },
  { env: 'BEACON_VERIFY_SHENMA', meta: 'shenma-site-verification', label: '神马/夸克' },
] as const;

/**
 * 生成 metadata.verification。**一个都没配就返回 undefined**（不输出任何标签）。
 */
export function siteVerification(): Metadata['verification'] | undefined {
  const google = process.env.BEACON_VERIFY_GOOGLE?.trim();
  const yandex = process.env.BEACON_VERIFY_YANDEX?.trim();

  const other: Record<string, string> = {};
  for (const e of OTHER_ENGINES) {
    const v = process.env[e.env]?.trim();
    if (v) other[e.meta] = v;
  }

  const hasOther = Object.keys(other).length > 0;
  if (!google && !yandex && !hasOther) return undefined;

  return {
    ...(google ? { google } : {}),
    ...(yandex ? { yandex } : {}),
    ...(hasOther ? { other } : {}),
  };
}

/**
 * 哪几家已经配了、哪几家还没配。
 * 给运维体检用——「验证码填了没」这种事，不问就没人知道答案。
 */
export function verificationStatus(): { label: string; env: string; configured: boolean }[] {
  return [
    { label: 'Google Search Console', env: 'BEACON_VERIFY_GOOGLE', configured: !!process.env.BEACON_VERIFY_GOOGLE?.trim() },
    { label: 'Yandex', env: 'BEACON_VERIFY_YANDEX', configured: !!process.env.BEACON_VERIFY_YANDEX?.trim() },
    ...OTHER_ENGINES.map((e) => ({ label: e.label, env: e.env, configured: !!process.env[e.env]?.trim() })),
  ];
}
