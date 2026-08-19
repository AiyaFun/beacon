// 站点根地址的单一真相源。
//
// 机器人回的登录链接、邮件里的跳转、og:image 都要用它。散着写 `process.env.X || 'http://localhost:3000'`
// 的后果历史上出现过：og:image 指向 localhost（metadataBase 缺席那次）。
// 取值顺序与 app/layout.tsx 一致，不要在别处再造一套。
export function siteUrl(): string {
  return (process.env.BEACON_SITE_URL || process.env.BEACON_PUBLIC_URL || 'http://localhost:3000').replace(/\/+$/, '');
}
