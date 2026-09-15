// 可自动回填的创作者后台 · 注册表（**可选模块**）
//
// 由 sw.js 用 importScripts 加载；**这个文件不在开源发行版里**
//（scripts/publish-github.sh 的剥离清单）。缺了它，sw.js 的 SELF_AUTO_ENTRY 保持为空，
// 「每天自动回填」整条通道自然不存在——不是被开关关掉，是没有目标可去。
//
// ⚠️ 这里只有**你自己的后台、你自己的作品数据**。2026-09-03 一并删掉的那条
// 「拿你的登录态去搜**别人**的公众号」（searchbiz/appmsgpublish 查竞对）**不在这里，
// 也不会回来**：那条的后果落在用户自己的号上，而收益只是一份别人的文章列表。
// 往这张表里加任何东西之前先回答一遍：读的是不是**他自己的**数据。
//
// 每一项的字段：
//   origin  —— 按需授权用的源（optional_host_permissions + 用户在设置页点一次「授权」）
//   url     —— 入口页。只给裸地址：后台会用会话 Cookie 302 到带 token 的地址，
//              重定向会把我们加的查询参数丢掉，所以别在这里拼参数
//   inject  —— 注入清单，**顺序有意义**：可选后台模块要排在 self-backend.js 之前，
//              它得先把配置放进 __beaconBackendExtras
//   label   —— 设置页上显示给用户看的名字
globalThis.__beaconSelfAutoEntries = globalThis.__beaconSelfAutoEntries || {};
Object.assign(globalThis.__beaconSelfAutoEntries, {
  wechat: {
    origin: 'https://mp.weixin.qq.com',
    url: 'https://mp.weixin.qq.com/cgi-bin/home',
    label: '微信公众号后台',
    inject: ['content/common.js', 'content/self-backend-wechat.js', 'content/self-backend.js'],
  },
});
