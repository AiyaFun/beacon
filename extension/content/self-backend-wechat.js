// 公众号后台 · 自有数据回填（**可选模块**）
//
// 【为什么单独一个文件】2026-09-03 我们删掉了公众号采集的两条通道；一条永久不回来
//（拿你自己的登录态去搜**别人**的号，风险落在你自己的公众号账号上），另一条
//「读**你自己**后台里**你自己**作品的数字」按用户要求恢复——它与视频号/抖音/小红书/B站
// 四个创作者后台是同一类事：自己的号、自己的数据、只读已经渲染出来的页面。
//
// 但它与那四个有两点不同，所以单独成文件而不是塞回 self-backend.js：
//   ① **不在 manifest 里声明**。mp.weixin.qq.com 走「按需单站点授权」
//      （optional_host_permissions + 用户在设置页点一次授权），没授权就一行都不注入；
//   ② **开源发行版不含本文件**（scripts/publish-github.sh 的剥离清单）。官方发行版才有。
//
// 本文件只提供「这个站点长什么样」的一份配置，注册进 self-backend.js 的后台表；
// 打开页面、翻页、解析、回传那套编排全在 self-backend.js 与 sw.js 里，与其它后台共用。
//
// 加载顺序由 sw.js 的注入清单保证：common.js → 本文件 → self-backend.js。
// 本文件里的函数体在**被调用时**才去拿 self-backend.js 的工具（__beaconBackendUtils），
// 所以它先加载也没关系。

const BEACON_WX = {
  urlOf: (href) => (globalThis.__beaconBackendUtils?.urlOf ?? (() => null))(href),
  queryAll: (sel) => (globalThis.__beaconBackendUtils?.queryAll ?? (() => []))(sel),
};

const WX_TOKEN_RE = /^[A-Za-z0-9_-]{10,64}$/;

// ── 公众号后台的 token：三类可达来源，按可靠性递降 ──────────────────────
//
// ⚠️ 真机 2026-07-29：**插件自己开的 `/cgi-bin/home`，地址里不一定带 token**
// ——只有用户手动点进来的页面才一定带。于是「每日自动回填」曾在一个明明采得到数的页面上，
// 把「地址栏没有 token」当成「登录态已过期」→ 执行端 abort → SW 立刻关掉标签页
//（用户看到的就是「打开公众号后秒退、什么都没采到」），通知还反过来说是用户没登录。
// 判据从此是「页面上三类来源都没有」，不是「地址栏没有」。
//
// 合规：token 只用于同域内的一次跳转，不存储、不上传、不进日志（自检里一律抹成 ***）。
const WX_BACKEND_TOKEN_RE = /[?&;]token=(\d{6,12})\b/;

function beaconWechatBackendToken(href) {
  // 1) 地址栏（用户手动导航来的页面一定有）
  try {
    const t = new URL(href || location.href, location.origin).searchParams.get('token') || '';
    if (/^\d{6,12}$/.test(t)) return t;
  } catch {
    /* 地址不合法就往下找 */
  }
  // 2) 页面里任意一条带 token= 的地址：左侧菜单/顶栏的 <a>，以及首页「已发表」那个
  //    /cgi-bin/appmsgpublish iframe。读的是 DOM 属性，不碰 iframe 里的内容。
  for (const el of BEACON_WX.queryAll('a[href*="token="], iframe[src*="token="], frame[src*="token="]')) {
    const m = WX_BACKEND_TOKEN_RE.exec(el.getAttribute('href') || el.getAttribute('src') || '');
    if (m) return m[1];
  }
  // 3) 内联 <script> 里的 token（后台把它写在 cgiData 里）。隔离世界读不到页面的 JS 变量，
  //    但读得到 <script> 的**文本**——同一份数据的可达形态。
  for (const s of BEACON_WX.queryAll('script:not([src])')) {
    const m = /\btoken\s*[:=]\s*["']?(\d{6,12})\b/.exec(s.textContent || '');
    if (m) return m[1];
  }
  return '';
}

// 取不到 token 时，「没登录」和「登录了但这一页取不到」是两件事：前者要用户去扫码，
// 后者要用户换一个后台页面再来。指错方向就是让人白折腾——何况这条通道只有一条通知
// 能说话，说错了就没有第二次机会。与 content/wechat-competitor.js 的 noTokenReason() 同口径。
function beaconWechatNoRoutesInfo() {
  // 判据只看页面自己的事实（路由 + 登录组件），不拿「没取到 token」倒推：
  // needLogin 决定 sw.js 会不会把这一页切到前台等用户扫码，判错就是白弹一个页面给他。
  const needLogin = /\/cgi-bin\/(loginpage|bizlogin)/.test(location.pathname)
    || !!document.querySelector('.login__type__container, .login_container, #headimg_qrcode');
  return {
    needLogin,
    reason: needLogin
      ? '公众号后台未登录——已把登录页切到前台，请扫码登录，登录完成后会自动继续回填'
      : '公众号后台这一页取不到 token，本轮自动回填已停止——请先手动打开公众号后台（左侧菜单可见的任意页面），再点一次「采集我的数据」',
  };
}


function beaconGetWechatBiz() {
  try {
    const u = new URL(location.href);
    const b = u.searchParams.get('__biz') || u.searchParams.get('biz');
    if (b) return b;
  } catch {}
  try {
    if (globalThis.cgiData && globalThis.cgiData.biz) return globalThis.cgiData.biz;
    if (globalThis.cgiData && globalThis.cgiData.__biz) return globalThis.cgiData.__biz;
    if (globalThis.wx && globalThis.wx.commonData && globalThis.wx.commonData.biz) return globalThis.wx.commonData.biz;
    if (globalThis.biz) return globalThis.biz;
  } catch {}
  const el = document.querySelector('[data-biz], [data-__biz], a[href*="__biz="]');
  if (el) {
    const b = el.getAttribute('data-biz') || el.getAttribute('data-__biz');
    if (b) return b;
    if (el.getAttribute('href')) {
      const u = BEACON_WX.urlOf(el.getAttribute('href'));
      if (u) {
        const b2 = u.searchParams.get('__biz') || u.searchParams.get('biz');
        if (b2) return b2;
      }
    }
  }
  return null;
}

// 返回 { id, via, anchor } —— 与 beaconRowIdInfo 的其它分支同形。
// ⚠️ anchor 是这里最容易被忽略、代价却最大的一个返回值：公众号分支此前只返回 ID，
// 于是 __beaconParse 拿不到「产出这条 ID 的那个链接」，标题只能退回按类名猜
// （[class*="title"] / [class*="desc"] / td:first-child）——真机上就是这么把
// 「已通知3人失败0人」抓成标题的。文章链接的文字才是标题，这是页面自己给的答案。
function beaconWechatRowId(row, cfg) {
  const nodes = [row, ...row.querySelectorAll('*')];
  // 1. 先检查节点上的完整/相对 URL 属性（href, data-href, data-url, data-link, data-src）
  for (const el of nodes) {
    for (const attr of ['href', 'data-href', 'data-url', 'data-link', 'data-src']) {
      const val = el.getAttribute(attr);
      if (val) {
        const id = cfg.idOf(val);
        // 只有 <a href> 才算「链接的文字就是标题」；data-* 挂在容器上，它的 textContent
        // 是整块内容，拿来当标题就成了另一种噪音。
        if (id) return { id, via: 'wechat', anchor: attr === 'href' && el.tagName === 'A' ? el : undefined };
      }
    }
  }

  // 2. 收集整行中散落的离散 data 属性（如 data-appmsgid, data-sn, data-biz, data-token）
  let mid, sn, biz, token, idx;
  for (const el of nodes) {
    if (!mid) mid = el.getAttribute('data-appmsgid') || el.getAttribute('data-appmsg-id') || el.getAttribute('data-mid') || el.getAttribute('data-id');
    if (!sn) sn = el.getAttribute('data-sn');
    if (!biz) biz = el.getAttribute('data-biz') || el.getAttribute('data-__biz');
    if (!token) token = el.getAttribute('data-token');
    if (!idx) idx = el.getAttribute('data-idx') || el.getAttribute('data-itemidx');
  }

  if (token && WX_TOKEN_RE.test(token)) {
    return { id: `https://mp.weixin.qq.com/s/${token}`, via: 'wechat' };
  }

  if (!biz) biz = beaconGetWechatBiz();
  if (!idx) idx = '1';

  if (biz && mid && sn) {
    return { id: `https://mp.weixin.qq.com/s?__biz=${biz}&mid=${mid}&idx=${idx}&sn=${sn}`, via: 'wechat' };
  }

  return { id: null, via: null };
}

// 注册进后台表。口径特殊：公众号文章没有平台级数字 ID，**URL 本身就是身份**
//（见 lib/publish/parse-url.ts 的 parseWechat）——所以 idOf 必须做与它完全一致的规范化，
// 否则与用户手动登记的发布记录对不上，同一篇文章会变成两条。
globalThis.__beaconBackendExtras = globalThis.__beaconBackendExtras || {};
globalThis.__beaconBackendExtras['mp.weixin.qq.com'] = {
  platform: 'wechat',
  pathPrefix: '/cgi-bin', // 后台在 /cgi-bin 下；文章正文页 /s 不在此列（那是读者视角，无后台数据）
  // /cgi-bin 前缀只说明「在后台域下」，**不说明这一页有作品数据**。首页 /cgi-bin/home、
  // 素材 /cgi-bin/appmsg、设置页都在这个前缀下，它们根本没有作品数据表。
  // 真机实测（2026-07-25）：停在 /cgi-bin/home 时认出 178 行，全是首页挂件
  // （LI.weui-desktop-list__item / SECTION.item），表头是「使用位置 ×10 / 相关文章」——
  // 自检却一路报到「抠不出作品 ID」，把人引去补选择器，方向完全错。
  // 这里列出真正有数据表的页面，认不出就直接说「换页面」，别浪费一轮校准。
  dataPaths: [/analysis/i, /appmsgpublish/i, /masssend/i, /datacenter/i, /statistic/i],
  // 真机 2026-07-25 /cgi-bin/appmsgpublish：通用行选择器一条真数据行都没认出来——
  // weui 的条目类名是 weui-desktop-mass-appmsg 这一族，里面既没有 row 也没有 item。
  // （唯一被捞进来的页面元素是 weui-desktop-mass__status_text_arrow，还是靠「arrow 含 row」。）
  // 这几个 hint 是从那份现场证据里读出来的，不是猜的；万一还不够，
  // beaconStructuralRows 会按结构再兜一次，不依赖任何类名。
  // ⚠️ 不要写 [class*="mass"]：weui 里 weui-desktop-mass__status_text（「已通知3人失败0人」
  // 那块通知状态）也会命中，它同样含链接和数字，于是被当成一条作品行——
  // 真机 2026-07-25 入库的 9 条记录标题全是那句状态文案，就是这么来的。
  // 只认条目本体的类名。
  rowHints: '[class*="appmsg"], [class*="publish"]',
  // 每日自动回填要依次走的页面。公众号后台每个地址都要 token，**从当前页面上原样取**——
  // 不只看地址栏：插件自己开的 /cgi-bin/home 地址里常常没有 token，但页面里有
  //（见上面 beaconWechatBackendToken 那段真机记录）。
  // token 只用于这一次同域跳转，不存储、不上传、不发给任何第三方（自检里也一律抹成 ***）。
  // 顺序有讲究：先发表记录（已验证能采到阅读/在看），再内容分析（完读率与送达人数在那儿）。
  autoRoutes(u) {
    const token = beaconWechatBackendToken(u && u.href);
    // 页面上三类来源都没有 token = 真的走不下去了。是「没登录」还是「这页没有」，
    // 交给 noRoutesReason 去分辨——调用方只负责如实转述，不猜。
    if (!token) return null;
    const q = `&token=${encodeURIComponent(token)}&lang=zh_CN`;
    return [
      `https://mp.weixin.qq.com/cgi-bin/appmsgpublish?sub=list&begin=0&count=10${q}`,
      `https://mp.weixin.qq.com/cgi-bin/appmsganalysis?action=all${q}`,
    ];
  },
  noRoutesInfo: beaconWechatNoRoutesInfo,
  // 真机 2026-07-25：用户连着三轮停在首页的「已发表」面板（t=home/index#tab=sent-panel）。
  // 那个面板确实列着文章，看起来就像「作品数据」，但它没有完读率/送达人数——
  // 光说「切到内容分析」不够，得给一条不依赖菜单长相的路：直接改地址栏。
  // token 必须原样保留（后台每个地址都要它），所以只说「换前半段」，不给完整链接。
  dataPageHint:
    '左侧菜单「数据」→「内容分析」（作品数据），或「数据」→「用户分析」（粉丝/受众）；\n' +
    '找不到菜单就直接改地址栏：把 home?t=home/index 换成 appmsganalysis?action=all，' +
    '后面的 &token=... &lang=... 原样别动',
  linkSelector:
    'a[href*="mp.weixin.qq.com/s"], a[href*="/s/"], a[href*="/s?"], a[href*="__biz"], a[href*="sn="], a[href*="appmsgid"], a[href*="appmsg_id"], [data-href], [data-url], [data-link], [data-src], [data-appmsgid], [data-appmsg-id], [data-mid], [data-sn], [data-id]',
  idOf(href) {
    const u = BEACON_WX.urlOf(href);
    if (!u || u.hostname !== 'mp.weixin.qq.com') return null;
    const segs = u.pathname.split('/').filter(Boolean);
    if (segs[0] === 's' && segs[1] && WX_TOKEN_RE.test(segs[1])) {
      return `https://mp.weixin.qq.com/s/${segs[1]}`;
    }
    const biz = u.searchParams.get('__biz') || u.searchParams.get('biz');
    const mid = u.searchParams.get('mid') || u.searchParams.get('appmsgid') || u.searchParams.get('appmsg_id');
    const idx = u.searchParams.get('idx') || u.searchParams.get('itemidx') || '1';
    const sn = u.searchParams.get('sn');
    // 四件套齐了才是一篇确定的文章，缺任何一个都定位不到，不猜
    if (biz && mid && idx && sn) {
      return `https://mp.weixin.qq.com/s?__biz=${biz}&mid=${mid}&idx=${idx}&sn=${sn}`;
    }
    return null;
  },
  urlOf: (id) => id, // wechat 的 ID 就是规范化后的 URL
  // 抠行 ID 的方式与其它后台不同（见 beaconWechatRowId 上方注释），走这个钩子接管
  rowIdOf: beaconWechatRowId,
};
