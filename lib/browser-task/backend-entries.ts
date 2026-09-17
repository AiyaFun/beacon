// 创作者后台的入口地址（2026-09-16）——服务端这一份，给桌面客户端 / 本机浏览器那条路用。
//
// 【为什么服务端要有一份】插件自己知道后台在哪（extension/sw.js 的 SELF_AUTO_CORE_ENTRIES +
// sw-self-backends.js 里的公众号可选入口），桌面客户端是个哑执行器：要开哪一页由服务端随任务给
// （executorTarget），它自己一概不知道。所以这张表必须与插件那张**逐字相同**——
// tests/browser-task/backend-entries.test.ts 直接读 sw.js 源码比对，漂了当场变红。
//
// 入口都是裸地址：后台会按登录态 302，重定向会丢掉我们自己拼的查询参数。
// 站内走哪几页不在这里：由注入的 self-backend.js 按 autoRoutes 算（页面导航里真实存在的
// 「作品数据/内容管理」链接 + 写死的候选），三条路一份。
import type { SELF_BACKEND_PLATFORMS } from './kinds';

export type BackendPlatform = (typeof SELF_BACKEND_PLATFORMS)[number];

export type BackendEntry = { origin: string; url: string; label: string };

export const SELF_BACKEND_ENTRY: Record<BackendPlatform, BackendEntry> = {
  shipinhao: { origin: 'https://channels.weixin.qq.com', url: 'https://channels.weixin.qq.com/platform', label: '视频号助手' },
  douyin: { origin: 'https://creator.douyin.com', url: 'https://creator.douyin.com/creator-micro/home', label: '抖音创作者中心' },
  xiaohongshu: { origin: 'https://creator.xiaohongshu.com', url: 'https://creator.xiaohongshu.com/new/home', label: '小红书创作服务平台' },
  bilibili: { origin: 'https://member.bilibili.com', url: 'https://member.bilibili.com/platform/home', label: 'B站创作中心' },
  // 公众号：插件里是可选模块（要单独授权），采集浏览器那条路只要服务端带着 self-backend-wechat.js 就能走
  wechat: { origin: 'https://mp.weixin.qq.com', url: 'https://mp.weixin.qq.com/cgi-bin/home', label: '公众号后台' },
};

export function backendEntryFor(platform: string): BackendEntry | null {
  return (SELF_BACKEND_ENTRY as Record<string, BackendEntry>)[platform] ?? null;
}
