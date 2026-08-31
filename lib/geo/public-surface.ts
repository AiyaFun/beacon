// 这个站**对外公开**的那一小块（2026-08-29）。
//
// 【为什么要收成一处】同一批路径现在有三个消费者：
//   robots.txt   —— 允许抓哪些前缀
//   sitemap.xml  —— 列出哪些页
//   llms.txt     —— 说明哪几页值得读、各是什么
// 各写一份的必然结果是漂移：robots 说能读的页，llms.txt 里没有；
// 或者新加了一个公开页，只在其中一处补上。而这类漂移**不会报错**——
// 三个文件各自都是合法的，只是互相矛盾。
//
// ⚠️ 只写**公开页**。业务页要登录，列进来既没用（模型打不开），
// 又等于对外公布内部路由结构。

/**
 * robots.txt 的放行前缀。
 *
 * ⚠️ `/legal` 必须在里面，别再收回去：Chrome 应用商店提交时要填隐私权政策网址，
 * 它的检查器**遵守 robots.txt**——页面返回 200 也没用，被 Disallow 挡住就报
 * 「无法访问隐私权政策链接」，提交直接卡住（2026-07-27 真机撞到）。
 */
export const PUBLIC_ALLOW: readonly string[] = [
  '/login', '/hotlists', '/legal', '/legal/', '/downloads',
  // ⚠️ 这两个是**给爬虫看的文件本身，必须自己放行自己**（2026-08-30 补）。
  // 少了它们，`Disallow: /` 会一并把它们封掉，于是同一份 robots.txt 底部的
  // `Sitemap: …/sitemap.xml` 指向一个它自己禁止抓取的 URL——自相矛盾的输出，
  // Search Console 直接报「已提交的站点地图无法读取（被 robots.txt 屏蔽）」。
  //
  // 【别把它说得比实际严重】/robots.txt 按协议永远够得着（爬虫必须先取它才知道规则），
  // /hotlists 本来就在上面这行里，而爬虫来访计数是按**爬虫名**聚合、不按 path 分，
  // 所以产品里没有哪个数字会因此变错。真正的代价只有一处：sitemap 递交不了。
  '/sitemap.xml', '/llms.txt',
] as const;

/**
 * llms.txt 列出的页面。**每条都要写一句「这一页有什么」**——
 * llms.txt 的全部价值就在那句话上；只给链接的话，它和 sitemap.xml 没有区别。
 */
export const PUBLIC_PAGES: readonly { path: string; title: string; desc: string }[] = [
  {
    path: '/hotlists',
    title: '全网热榜',
    desc: '九个平台的实时热榜聚合（抖音、B站、小红书、微博、知乎等），每 30 分钟更新一次，免登录可看。',
  },
  { path: '/login', title: '登录', desc: '登录入口。' },
  {
    path: '/legal/privacy',
    title: '隐私政策',
    desc: '逐条说明采集了什么、留存多久、如何删除，含浏览器插件的逐项行为披露。',
  },
  { path: '/legal/terms', title: '服务条款', desc: '服务条款。' },
  {
    path: '/legal/data-request',
    title: '数据移除申请',
    desc: '被监控账号的作者、以及留下过评论的读者，都可以在这里要求删除自己的数据。',
  },
  { path: '/downloads', title: '采集助手下载', desc: '浏览器插件与桌面客户端的安装包。' },
] as const;

/**
 * 这个路径被 robots 放行了吗。
 *
 * 【判据是前缀，且必须落在边界上】`/legal` 应当覆盖 `/legal/privacy`，
 * 但**不该**覆盖一个叫 `/legalese` 的页面——裸 startsWith 会把它也算进去。
 * 与本项目别处的域名分段比对是同一条纪律：前缀匹配要比到分隔符。
 */
export function allowedByRobots(path: string): boolean {
  return PUBLIC_ALLOW.some((a) => {
    const prefix = a.replace(/\/$/, '');
    return path === prefix || path.startsWith(`${prefix}/`);
  });
}
