// 烽火台 网页侧边悬浮 AI 助手 Content Script (向量 SVG 图标与浅色 UI)
(() => {
  if (document.getElementById('beacon-ai-root')) return;

  const svgIcons = {
    home: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>`,
    sparkles: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8z"/><path d="M18 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/></svg>`,
    plus: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>`,
    bulb: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-4 10c1 1 1 2 1 3h6c0-1 0-2 1-3a6 6 0 0 0-4-10z"/></svg>`,
    chat: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11 7.5L4 21l1.5-6A8 8 0 1 1 21 12z"/></svg>`,
    x: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
    send: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>`,
    user: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>`,
    fire: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3c1 3-2 4-2 7a4 4 0 0 0 8 0c0-1-1-2-1-3 2 1 3 3 3 6a8 8 0 1 1-15-1c0-4 5-5 4-9 .5.5 2 .8 3 0z"/></svg>`,
    down: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 21h16"/></svg>`,
    scissors: `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4L8.12 15.88"/><path d="M14.47 14.48L20 20"/><path d="M8.12 8.12L12 12"/></svg>`,
    doc: `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/></svg>`,
    chat2: `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 9h8M8 13h5"/></svg>`,
  };

  // 竖条上的图标尺寸统一放大到 19（截图那种一眼可辨的密度），沿用同一套 currentColor 描边
  const railIcon = (d, w = 19) => d.replace(/width="\d+" height="\d+"/, `width="${w}" height="${w}"`);

  function showToast(message, isOk = true) {
    const existing = document.querySelector('.beacon-toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = `beacon-toast ${isOk ? 'ok' : 'err'}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => toast.classList.add('show'));
    });
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 400);
    }, 3500);
  }

  // chrome.runtime.sendMessage 会 **reject**，而且是这类界面最常见的卡死原因：
  //   · service worker 里的处理函数抛了错、没回话（消息通道关闭）；
  //   · 插件刚被重新加载/更新，而这个页面上跑的还是**旧的**内容脚本，握着一个已失效的 runtime。
  // 下面每个按钮处理都是 async 的，reject 会直接跳过后面的 restore()——
  // 表现就是按钮永远停在「回填中…」，不报错、不复原（真机 2026-07-27 在 X 上撞到）。
  // 统一走它：永远 resolve，失败也带一句用户看得懂的话。
  async function ask(msg) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (e) {
      const m = String(e?.message || e);
      return {
        ok: false,
        error: /context invalidated|Receiving end does not exist|message port closed/i.test(m)
          ? '插件刚更新过，本页跑的还是旧脚本——刷新一下这个页面再试'
          : `插件后台没有响应：${m}`,
      };
    }
  }

  let hostUrl = 'https://beacon.iyunci.cn';
  chrome.runtime.sendMessage({ type: 'beacon-get-config' }, (cfg) => {
    if (cfg?.host) hostUrl = cfg.host;
  });

  // ⚠️ 侧栏注入在 <all_urls> 上，**包括你自己的创作者后台**。
  // self-backend.js 一加载就置 __beaconSelfOnly，common.js 的 beacon-collect 与「访问即采」
  // 都按它分流；侧栏此前是唯一没读这个标记的地方——于是在公众号/视频号/抖音后台点
  // 「一键加为竞对并采集数据」，会把**你自己后台的数据**从竞对通道
  // （/api/ingest/competitor，写工作区共享的竞对库）传上去，还顺手 autoSubscribe 把
  // handle='self' 加成一个竞对。这条通道分流是合规设计的一部分，不是 UI 细节。
  const isSelfBackend = () => globalThis.__beaconSelfOnly === true;

  // 竞对通道只在**这几个公开站点**上开。其余站点（含所有普通网页）走兜底解析的话，
  // 认不出域名会默认 platform='bilibili'、再按路径瞎凑一个 handle——
  // 那会在竞对库里凭空建出一个不存在的 B站 账号。与 popup.js 的 SUPPORTED 同一份口径。
  const COMPETITOR_HOSTS = [
    /^https:\/\/(?:space|www)\.bilibili\.com\//,
    /^https:\/\/www\.douyin\.com\//,
    /^https:\/\/www\.xiaohongshu\.com\//,
    /^https:\/\/(?:x|twitter)\.com\//,
    /^https:\/\/www\.youtube\.com\//,
    /^https:\/\/www\.tiktok\.com\//,
  ];
  const isCompetitorPage = () => COMPETITOR_HOSTS.some((re) => re.test(location.href));

  // 能走**自有通道**的页面。与 popup.js / sidepanel.js 的 SELF_SUPPORTED 同一份口径。
  // 创作者后台不在这张表里——那儿由 __beaconSelfOnly 认出来，采集按钮本身就变成「这是我的作品」。
  // 这张表管的是另一半：**公开作品页**（自己的作品，指标公开可见），此前侧栏在这些页面上
  // 只给得出「加为竞对」，于是「我自己的作品」在侧栏这个入口上根本回填不了。
  // X 的用户主页/推文页也在其中——X 没有创作者后台这种独立域名，自有数据就在自己主页上（见 content/x.js）。
  const X_SELF_PAGE =
    /^https:\/\/(?:x|twitter)\.com\/(?!(?:home|explore|notifications|messages|settings|compose|search|hashtag|about|tos|privacy|login|signup|i|intent)(?:[/?#]|$))[A-Za-z0-9_]{1,15}(?:[/?#]|$)/;
  const XHS_SELF_PROFILE = /^https:\/\/www\.xiaohongshu\.com\/user\/profile\/[0-9a-zA-Z]+/;
  const BILI_SELF_SPACE = /^https:\/\/space\.bilibili\.com\/\d+/;
  const DY_SELF_PROFILE = /^https:\/\/www\.douyin\.com\/user\/[\w-]+/;
  const YT_SELF_CHANNEL = /^https:\/\/www\.youtube\.com\/(?:@[^/?#]+|channel\/[\w-]+|c\/[^/?#]+|user\/[^/?#]+)/;
  // TikTok 与 X 同理：没有创作者后台这种独立域名，自有数据就在自己主页上（见 content/tiktok.js）。
  // 只认 /@<unique_id>，功能页不带 @ 自然被排掉。与 popup.js / sidepanel.js 同一份口径。
  const TT_SELF_VIDEO = /^https:\/\/www\.tiktok\.com\/@[\w.]{1,24}\/(?:video|photo)\/\d+/;
  const TT_SELF_PROFILE = /^https:\/\/www\.tiktok\.com\/@[\w.]{1,24}\/?(?:[?#]|$)/;
  const SELF_PAGES = [
    /^https:\/\/www\.bilibili\.com\/video\//,
    /^https:\/\/www\.douyin\.com\/video\//,
    /^https:\/\/www\.xiaohongshu\.com\/(?:explore|discovery\/item)\//,
    // 自己的小红书主页——与 X 同理，此前这里只给得出「加为竞对」
    XHS_SELF_PROFILE,
    X_SELF_PAGE,
    BILI_SELF_SPACE,
    DY_SELF_PROFILE,
    YT_SELF_CHANNEL,
    TT_SELF_PROFILE,
    TT_SELF_VIDEO,
  ];
  const isSelfPage = () => SELF_PAGES.some((re) => re.test(location.href));

  // 「我的主页」与「竞对主页」是**同一种页面**的平台：X、小红书、B站、抖音、YouTube。
  // 页面本身分不出是谁的号，点错不是「采得不准」——竞对的几十条内容会被写成你自己的发布记录，
  // 污染看板/基线/学习样本，且没有一键撤销。所以这两类页面上回填前多一道确认。
  // 单篇作品页不在其中（只有一条内容，代价小，且是既有行为）。
  // 站点解析器读到「编辑资料」这类只有本人可见的入口时带 isSelf:true → 直接放行；
  // 读不到（含平台改版）就要求再点一次。与 popup.js / sidepanel.js 同一套逻辑。
  const AMBIGUOUS_PROFILE = [X_SELF_PAGE, XHS_SELF_PROFILE, BILI_SELF_SPACE, DY_SELF_PROFILE, YT_SELF_CHANNEL, TT_SELF_PROFILE];
  let selfProfileConfirmedUrl = '';
  function confirmSelfProfile(payload) {
    if (!AMBIGUOUS_PROFILE.some((re) => re.test(location.href))) return true;
    if (payload?.isSelf === true) return true;
    if (selfProfileConfirmedUrl === location.href) return true;
    selfProfileConfirmedUrl = location.href;
    const who = payload?.profile?.name || (payload?.handle ? `@${payload.handle}` : '这个账号');
    showToast(`没读到「编辑资料」这类只有本人可见的入口。确认 ${who} 是你自己的号？是的话再点一次回填`, false);
    return false;
  }

  // 页面地址里可能带着等同于登录态的参数（公众号后台每个地址都有 token=）。
  // 灵感箱要把 url 存到服务器上，存之前一律抹掉——与 self-backend.js beaconSafeRoute 同一套口径。
  const SECRET_PARAM = /token|ticket|secret|sign|key|uin|sid|pass|cookie|auth/i;
  function safeHref(href) {
    try {
      const u = new URL(href);
      for (const k of [...u.searchParams.keys()]) {
        if (SECRET_PARAM.test(k)) u.searchParams.set(k, '***');
      }
      return u.toString();
    } catch {
      return String(href || '');
    }
  }

  // 页面标题、AI 回答里都可能带 < >，而下面的气泡是用 innerHTML 渲染的（要支持 **加粗**）。
  // 不转义的话，一个标题是 <img onerror=...> 的页面就能在侧栏里执行脚本。
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  const root = document.createElement('div');
  root.id = 'beacon-ai-root';

  const logoUrl = chrome.runtime.getURL('logo.png');

  // 1. 悬浮竖条（收起态只剩一个 logo，点它展开图标条；整条可上下拖）
  //
  // 【为什么从「胶囊按钮 + 一整个抽屉」改成这个】旧版每做一件事都要先开整扇抽屉，
  // 而抽屉里三张卡把不相干的事挤在一起（加竞对 / 回填自己作品 / 收灵感同属「页面信息」卡）。
  // 竖条把**动作**摊平成一排图标、按语义分组，常用动作一次点击直达，只有真需要输入的
  //（灵感箱备注、AI 问答）才展开抽屉。
  //
  // 位置存 chrome.storage.local：用户把它拖到不挡内容的位置后，换页面不该跳回去。
  const rail = document.createElement('div');
  rail.id = 'beacon-rail';
  rail.innerHTML = `
    <button id="beacon-rail-logo" title="烽火台（拖动可上下移动）" aria-label="烽火台">
      <img src="${logoUrl}" alt="烽火台">
    </button>
    <div id="beacon-rail-items" role="toolbar" aria-label="烽火台快捷动作"></div>
  `;

  // 分组 = 「在这一页你想干什么」。sep 前后是不同意图，别混。
  // need: 什么页面上才有意义；不满足时**置灰而不是隐藏**——按钮消失会让下面的图标位置跳动，
  // 用户刚建立的肌肉记忆当场作废，而且他不知道为什么少了一个。
  const RAIL_ACTIONS = [
    { id: 'analyze', icon: 'scissors', label: '拆解这条作品', hint: '读封面 + 文案 + 字幕轨，出钩子/爆点/对你的用处', need: 'content' },
    { id: 'clip', icon: 'doc', label: '存进资讯库', hint: '把这一页正文抓下来，出摘要和要点', need: 'content' },
    { id: 'comments', icon: 'chat2', label: '读评论提问', hint: '读当前页已显示的评论，挑出提问句，归并后入库参与选题', need: 'content' },
    { id: 'inspire', icon: 'bulb', label: '收进灵感箱', hint: '记一笔，回头能转成选题' },
    { sep: true },
    { id: 'rival', icon: 'plus', label: '加为竞对并采集', hint: '仅在支持的平台主页/作品页可用', need: 'competitor' },
    { id: 'self', icon: 'down', label: '这是我的作品', hint: '回填到数据看板；仅在你自己的作品页可用', need: 'self' },
    { sep: true },
    { id: 'ai', icon: 'chat', label: 'AI 运营助手', hint: '针对这一页提问、要选题' },
    { id: 'home', icon: 'home', label: '打开烽火台', hint: '回到工作台' },
  ];

  const itemsBox = rail.querySelector('#beacon-rail-items');
  for (const a of RAIL_ACTIONS) {
    if (a.sep) {
      const hr = document.createElement('div');
      hr.className = 'beacon-rail-sep';
      itemsBox.appendChild(hr);
      continue;
    }
    const b = document.createElement('button');
    b.className = 'beacon-rail-btn';
    b.dataset.act = a.id;
    if (a.need) b.dataset.need = a.need;
    b.innerHTML = `${railIcon(svgIcons[a.icon])}<span class="beacon-rail-tip"><b>${esc(a.label)}</b>${a.hint ? `<i>${esc(a.hint)}</i>` : ''}</span>`;
    itemsBox.appendChild(b);
  }

  // 2. 侧栏抽屉
  const drawer = document.createElement('div');
  drawer.id = 'beacon-ai-drawer';
  drawer.innerHTML = `
    <div id="beacon-ai-header">
      <div class="beacon-hdr-brand">
        <img src="${logoUrl}" class="beacon-hdr-logo" alt="烽火台">
        <div>
          <div class="beacon-hdr-title">烽火台 AI 助手</div>
          <div class="beacon-hdr-sub">跨平台内容作战室</div>
        </div>
      </div>
      <div class="beacon-hdr-actions">
        <button id="beacon-home-btn" class="beacon-btn-home">${svgIcons.home} <span>主页</span></button>
        <button id="beacon-close-btn" class="beacon-btn-close">${svgIcons.x}</button>
      </div>
    </div>
    <div id="beacon-ai-body">
      <!-- 板块分两层，不再把不相干的事挤一张卡：
           ① 这一页是什么（只读情报）；② 收集类动作（灵感箱要填备注，所以留在抽屉里）。
           「加为竞对」「回填我的作品」这两条数据类动作已经上到竖条上一键直达，
           这里保留按钮只是为了在抽屉里也够得到（同一个 DOM，逻辑只有一份）。 -->
      <div class="beacon-card">
        <div class="beacon-card-title">
          <span>这一页是什么</span>
          <span id="beacon-page-platform" class="beacon-badge-platform">社交网页</span>
        </div>
        <div id="beacon-page-title" style="font-size:13px; font-weight:600; color:#1a1d21; word-break:break-all; line-height:1.4">检测中…</div>
        <div id="beacon-page-meta" style="font-size:11.5px; color:#5b6370; margin-top:4px">等待数据采集</div>
        <button id="beacon-collect-btn" class="beacon-btn-action">${svgIcons.plus} <span>一键加为竞对并采集数据</span></button>
        <!-- 自有作品回填：走 /api/ingest/self，与上面那条竞对通道完全无关。
             默认隐藏，只在「你自己的公开作品页 / X 自己的主页」上露出来（创作者后台上是上面那颗
             按钮自己变成这个文案，见 COLLECT_LABEL）。此前侧栏在这些页面上只给得出「加为竞对」，
             于是自己的作品在这个入口上根本回填不了。 -->
        <button id="beacon-self-btn" class="beacon-btn-action beacon-btn-self" style="display:none">${svgIcons.down} <span>这是我的作品 · 回填数据看板</span></button>
        <!-- 回填到哪个账号：不选就由后端按平台猜（一个工作区两个抖音号时必然错一半，
             而挂错账号在数据看板上是**彻底看不见**，还会污染另一个号的基线）。 -->
        <div id="beacon-account-row" style="display:none; margin-top:6px; align-items:center; gap:6px">
          <span style="font-size:11px; color:#5b6370; white-space:nowrap">回填到</span>
          <select id="beacon-account-sel" style="flex:1; min-width:0; padding:5px 7px; border:1px solid #e3e6ea; border-radius:7px; font-size:11.5px; background:#fff; color:#1a1d21">
            <option value="">（按平台自动匹配）</option>
          </select>
        </div>
        <button id="beacon-inspire-btn" class="beacon-btn-action beacon-btn-inspire">${svgIcons.bulb} <span>收进灵感箱</span></button>
        <input type="text" id="beacon-inspire-note" placeholder="为什么想记它？（选填，这句最有用）" style="width:100%; margin-top:6px; padding:7px 9px; border:1px solid #e3e6ea; border-radius:7px; font-size:12px; box-sizing:border-box" />
      </div>

      <!-- ⚠️ 这里原本还有一颗「爆款要点拆解」，已删。
           它只是把页面文字丢给模型聊两句、不落库、也读不到封面和字幕轨——
           而竖条上的「拆解这条作品」走 /api/ingest/analyze，读封面 + 文案 + 平台字幕轨，
           产出结构化报告并入资讯库。两个名字几乎一样、能力差一大截，摆在一起只会让用户
           点到弱的那个然后以为这功能就这样。留强的那个，弱的删掉。 -->
      <div class="beacon-card" style="flex:1; display:flex; flex-direction:column">
        <div class="beacon-card-title">
          <span>AI 运营问答</span>
          <button id="beacon-ai-ideas" class="beacon-chip-btn">${svgIcons.bulb} <span>衍生 3 个选题</span></button>
        </div>
        <div id="beacon-chat-msgs" class="beacon-chat-messages">
          <div class="beacon-bubble assistant">
            <div class="beacon-avatar assistant">${svgIcons.sparkles}</div>
            <div class="beacon-bubble-card assistant">
              您好！我是烽火台 AI 运营助手。我已就绪，可随时为您拆解当前浏览的视频/文章爆款要素与选题方向。
            </div>
          </div>
        </div>
        <div class="beacon-chat-input-row">
          <input type="text" id="beacon-chat-input" class="beacon-chat-input" placeholder="针对当前页面提问 / 优化文案…" />
          <button id="beacon-chat-send" class="beacon-chat-send">${svgIcons.send} <span>发送</span></button>
        </div>
      </div>
    </div>
  `;

  root.appendChild(rail);
  root.appendChild(drawer);
  if (!document.body) return; // 非 HTML 文档（XML/纯文本）没有 body，注入会抛
  document.body.appendChild(root);

  // 自有创作者后台上，采集按钮改成「回填我的数据看板」——它走的是另一条通道
  // （/api/ingest/self），与竞对库完全无关。文案与 popup 的「📥 这是我的作品」保持一致，
  // 免得同一个动作在两个入口上叫两个名字。
  const collectBtn = document.getElementById('beacon-collect-btn');
  const COLLECT_LABEL = isSelfBackend()
    ? `${svgIcons.plus} <span>这是我的作品 · 回填数据看板</span>`
    : `${svgIcons.plus} <span>一键加为竞对并采集数据</span>`;
  collectBtn.innerHTML = COLLECT_LABEL;

  // ── 自有作品回填（只在自己的公开作品页 / X 自己的主页上露出来）──
  const selfBtn = document.getElementById('beacon-self-btn');
  const accountRow = document.getElementById('beacon-account-row');
  const accountSel = document.getElementById('beacon-account-sel');
  const SELF_LABEL = `${svgIcons.down} <span>这是我的作品 · 回填数据看板</span>`;
  // 创作者后台上是采集按钮自己变成「这是我的作品」（COLLECT_LABEL），不再多给一颗同义按钮
  const canSelfIngest = isSelfBackend() || isSelfPage();
  if (isSelfPage() && !isSelfBackend()) selfBtn.style.display = '';
  if (canSelfIngest) accountRow.style.display = 'flex';

  // 账号清单从 sw.js 拿（带缓存），选择存 chrome.storage.sync，回填时由 sw.js 统一挂上 accountId。
  // 这里只管显示与保存——「绑的账号在不在这个工作区、平台对不对得上」由服务端校验并给出人话错误。
  if (canSelfIngest) {
    chrome.runtime.sendMessage({ type: 'beacon-get-accounts' }, (r) => {
      if (!r?.ok || !Array.isArray(r.accounts) || r.accounts.length === 0) return;
      const PLATFORM_NAME = { bilibili: 'B站', douyin: '抖音', xiaohongshu: '小红书', youtube: 'YouTube', x: 'X', wechat: '公众号', shipinhao: '视频号', tiktok: 'TikTok', multi: '多平台' };
      for (const a of r.accounts) {
        const opt = document.createElement('option');
        opt.value = a.id;
        // textContent 而不是 innerHTML：账号名是用户自己填的，可能带 < >
        opt.textContent = `${PLATFORM_NAME[a.platform] || a.platform} · ${a.name}${a.status !== 'active' ? '（已停用）' : ''}`;
        accountSel.appendChild(opt);
      }
      if (r.selfAccountId) accountSel.value = r.selfAccountId;
    });
    accountSel.addEventListener('change', () => {
      chrome.runtime.sendMessage({ type: 'beacon-set-account', accountId: accountSel.value }, () => {
        showToast(accountSel.value ? '✓ 已绑定，之后的回填都记到这个账号名下' : '✓ 已改回「按平台自动匹配」', true);
      });
    });
  }

  // 「工作区里还没有这个平台的账号」不需要用户操心：sw.js 的 ingestSelf 会用页面上的昵称
  // 就地建号、绑定，然后把这一趟的数据写进去——一次点击走完，界面这边只负责说结果。
  selfBtn.addEventListener('click', async () => {
    selfBtn.disabled = true;
    selfBtn.innerHTML = `<span>回填中…</span>`;
    // ⚠️ try/finally 而不是在每个 return 前手写 restore()：漏掉任何一条路径，
    // 按钮就永远停在「回填中…」——不报错、不复原，用户只能刷新页面（真机 2026-07-27 在 X 上撞到）。
    try {
      let payload = null;
      try { payload = globalThis.__beaconParse?.(); } catch { payload = null; }
      // 公开作品页上**绝不兜底解析**：兜底认不出域名会默认 platform='bilibili'，
      // 回填出去就是把 X 的推文写进 B站 账号名下（与 common.js 那段守卫同一条理由）。
      if (!payload || !payload.posts || payload.posts.length === 0) {
        showToast('没读到这一页的作品数据——等页面完全加载出来再点一次', false);
        return;
      }
      if (!confirmSelfProfile(payload)) return;

      const res = await ask({ type: 'beacon-ingest-self', payload });
      // summary/summaryOk 由 sw.js 统一措辞：请求成功但一条都没入库时 summaryOk=false，
      // 那是失败，不能报成勾。没有账号时 summary 里会带上「已新建账号「…」」。
      if (res?.ok) showToast(res.summary || '✓ 已回填到数据看板', res.summaryOk !== false);
      else showToast('回填未完成: ' + (res?.error || '请求异常'), false);
    } catch (e) {
      showToast('回填出错：' + (e?.message || e), false);
    } finally {
      selfBtn.disabled = false;
      selfBtn.innerHTML = SELF_LABEL;
    }
  });

  // ── 设置中控制显隐 ──
  const applyVisibility = (show) => {
    root.style.display = show !== false ? 'block' : 'none';
  };

  chrome.storage.sync.get('showInPageAi', (res) => {
    applyVisibility(res?.showInPageAi);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.showInPageAi) {
      applyVisibility(changes.showInPageAi.newValue);
    }
  });

  // ── 交互逻辑 ──
  const toggleDrawer = (open) => {
    if (open !== undefined) drawer.classList.toggle('open', open);
    else drawer.classList.toggle('open');
    const isOpen = drawer.classList.contains('open');
    // 让竖条避开抽屉（CSS 里那条 .drawer-open 规则）——抽屉 380px 宽，不让开就把它整个盖住了
    root.classList.toggle('drawer-open', isOpen);
    if (isOpen) updatePageInfo();
  };

  // ── 竖条：拖动 + 展开/收起 ────────────────────────────────
  //
  // 【拖动与点击必须分得开】按下就当拖动的话，用户永远点不开它；
  // 所以只有位移超过阈值才算拖，否则松手当点击。4px 是触摸板上的手抖幅度。
  const DRAG_THRESHOLD = 4;
  const railLogo = rail.querySelector('#beacon-rail-logo');

  const clampTop = (t) => Math.max(8, Math.min(t, window.innerHeight - rail.offsetHeight - 8));
  // 走自定义属性而不是 style.top —— 理由见 sidebar.css 里 #beacon-rail 上方那段注释
  const setRailTop = (t) => rail.style.setProperty('--beacon-rail-top', t + 'px');
  const readRailTop = () => parseFloat(rail.style.getPropertyValue('--beacon-rail-top')) || 0;

  // ⚠️ 位置记忆是**锦上添花**，绝不能因为它取不到就把整个竖条带崩——
  // 那样丢的是全部按钮，而换来的只是「记不住位置」。这条 try 是故意的，不是偷懒。
  try {
    chrome.storage?.local?.get?.('railTop', (r) => {
      const t = Number(r?.railTop);
      if (Number.isFinite(t)) setRailTop(clampTop(t));
    });
  } catch { /* 位置记不住而已，其余照常 */ }
  // 窗口变矮时把它拉回视口内，否则会被顶到屏幕外再也点不到
  window.addEventListener('resize', () => {
    const cur = readRailTop();
    if (cur) setRailTop(clampTop(cur));
  });

  let dragging = false;
  let moved = false;
  let startY = 0;
  let startTop = 0;

  railLogo.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    moved = false;
    startY = e.clientY;
    startTop = rail.getBoundingClientRect().top;
    railLogo.setPointerCapture(e.pointerId);
    rail.classList.add('dragging');
  });
  railLogo.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    if (!moved && Math.abs(dy) < DRAG_THRESHOLD) return;
    moved = true;
    setRailTop(clampTop(startTop + dy));
  });
  railLogo.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = false;
    rail.classList.remove('dragging');
    try { railLogo.releasePointerCapture(e.pointerId); } catch { /* 已释放 */ }
    if (moved) {
      try { chrome.storage?.local?.set?.({ railTop: readRailTop() }); } catch { /* 同上 */ }
      return; // 拖完不触发展开，否则每次挪位置都会弹出图标条
    }
    rail.classList.toggle('open');
    if (rail.classList.contains('open')) refreshRailState();
  });

  // ── 竖条动作 ────────────────────────────────
  // 能复用抽屉里既有按钮的就复用（点它一下），逻辑只有一份，不会两处漂移。
  const railBusy = (btn, on) => btn.classList.toggle('busy', on);

  itemsBox.addEventListener('click', async (e) => {
    const btn = e.target.closest('.beacon-rail-btn');
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;

    if (act === 'home') return void window.open(hostUrl, '_blank');

    if (act === 'ai') {
      // AI 优先走 Chrome 侧边栏（空间大、不遮页面），拿不到再退回页内抽屉
      try {
        const res = await ask({ type: 'open-sidepanel' });
        if (res?.ok) return;
      } catch { /* 退回抽屉 */ }
      return void toggleDrawer(true);
    }

    // 灵感箱要填「为什么记它」那句话——那句比标题有用得多，不能省掉直接提交
    if (act === 'inspire') {
      toggleDrawer(true);
      setTimeout(() => document.getElementById('beacon-inspire-note')?.focus(), 220);
      return;
    }

    if (act === 'rival') return void collectBtn.click();
    if (act === 'self') return void selfBtn.click();

    if (act === 'comments') {
      railBusy(btn, true);
      showToast('正在读取评论区…', true);
      const res = await ask({ type: 'beacon-collect-comments' });
      railBusy(btn, false);
      if (res?.ok) {
        const n = (res.created || 0) + (res.updated || 0);
        showToast(n > 0 ? `从 ${res.read || '?'} 条评论中挖出 ${n} 个提问，已入库` : `读到 ${res.read || 0} 条评论，没有发现提问`, true);
      } else {
        showToast(res?.error || '评论结构没认出来，可能平台改版了', false);
      }
      return;
    }

    if (act === 'analyze' || act === 'clip') {
      railBusy(btn, true);
      showToast(act === 'analyze' ? '正在拆解这条作品…' : '正在读取正文…', true);
      const res = await ask({ type: act === 'analyze' ? 'beacon-analyze-work' : 'beacon-clip-article' });
      railBusy(btn, false);
      if (res?.ok) {
        // 拆解回执要把「这次看的是什么」一起说出来——用户必须知道它没看视频画面
        showToast(act === 'analyze' ? `已存进资讯库：${res.summary || res.title || ''}${res.basis ? `（依据：${res.basis}）` : ''}` : `已存进资讯库（正文 ${res.chars || 0} 字）`, true);
      } else {
        showToast(res?.error || '操作失败', false);
      }
    }
  });

  /** 按当前页面刷新竖条上各按钮可不可用（不可用是置灰 + 说明，不是消失）。 */
  function refreshRailState() {
    const info = getPageInfo();
    const can = {
      content: true, // 任意网页都能读正文/封面
      competitor: !!(info.platform && info.platform !== '社交网页') || isCompetitorPage(),
      self: isSelfPage() || isSelfBackend(),
    };
    for (const btn of itemsBox.querySelectorAll('.beacon-rail-btn')) {
      const need = btn.dataset.need;
      if (!need) continue;
      const ok = can[need] !== false;
      btn.disabled = !ok;
      btn.classList.toggle('off', !ok);
    }
  }

  document.getElementById('beacon-close-btn').addEventListener('click', () => toggleDrawer(false));

  document.getElementById('beacon-home-btn').addEventListener('click', () => {
    window.open(hostUrl, '_blank');
  });

  function getPageInfo() {
    let payload = null;
    try {
      if (typeof globalThis.__beaconParse === 'function') {
        payload = globalThis.__beaconParse();
      }
    } catch { /* ignore */ }

    // 兜底解析器是给竞对公开页写的：认不出域名一律当 bilibili。自有后台上绝不能用它
    // （与 common.js 的 beacon-collect 守卫同一条理由），宁可这一栏显示得少一点。
    if (!isSelfBackend() && (!payload || !payload.handle || !payload.posts || payload.posts.length === 0)) {
      try {
        if (typeof globalThis.beaconFallbackParse === 'function') {
          payload = globalThis.beaconFallbackParse();
        }
      } catch { /* ignore */ }
    }

    const title = payload?.posts?.[0]?.title || document.title || '当前网页';
    const author = payload?.profile?.name || payload?.handle || '';
    const platform = payload?.platform || '社交网页';
    const metrics = payload?.posts?.[0]?.metrics || {};

    return { payload, title, author, platform, metrics };
  }

  function updatePageInfo() {
    const info = getPageInfo();
    document.getElementById('beacon-page-platform').textContent = info.platform;
    document.getElementById('beacon-page-title').textContent = (info.author ? `【${info.author}】` : '') + info.title;

    // 只展示标量指标：sources 是个对象（{推荐:0.62,…}），直接拼进模板会变成 [object Object]
    const shown = Object.keys(info.metrics).filter((k) => typeof info.metrics[k] === 'number');
    const meta = document.getElementById('beacon-page-meta');
    if (shown.length > 0) {
      meta.textContent = shown.map((k) => `${k}: ${info.metrics[k]}`).join(' · ');
    } else {
      meta.textContent = isSelfBackend()
        ? '这是你自己的后台，可一键回填数据看板'
        : isSelfPage()
          ? '页面已识别 · 是竞对就采回档案，是你自己的作品就回填数据看板'
          : '页面已识别，可一键采回竞对档案';
    }
  }

  // 收进灵感箱：与「加为竞对」是两件不同的事——竞对是持续监控一个账号，
  // 灵感是给这一条内容记一笔。所以它不需要 handle、不需要指标、也不写任何全局共享表，
  // 只往自己工作区的收集箱加一行（标题 + 链接 + 备注，不存正文，见 lib/ingest/inspiration.ts）。
  document.getElementById('beacon-inspire-btn').addEventListener('click', async () => {
    const btn = document.getElementById('beacon-inspire-btn');
    const noteEl = document.getElementById('beacon-inspire-note');
    const href = location.href;
    if (href.includes('localhost') || href.includes('beacon.iyunci.cn') || href.includes('127.0.0.1')) {
      showToast('这是烽火台自己的页面，换个内容页再收藏', false);
      return;
    }
    btn.disabled = true;
    btn.innerHTML = `<span>保存中…</span>`;

    const info = getPageInfo();
    // platform 只在识别出已知平台时才带：后端对未知平台会整条打回，
    // 而「在一个不认识的站点上刷到好东西」恰恰是收集箱最该支持的场景。
    const known = ['bilibili', 'douyin', 'xiaohongshu', 'youtube', 'x', 'wechat', 'shipinhao', 'tiktok'];
    const payload = {
      title: (info.title || document.title || '未命名').slice(0, 200),
      note: (noteEl?.value || '').trim().slice(0, 300) || undefined,
      // 抹掉 token/sid 这类等同于登录态的参数：这条 url 会被存到服务器上，
      // 而创作者后台的每个地址都带着 token=。
      url: safeHref(href).slice(0, 500),
      platform: known.includes(info.platform) ? info.platform : undefined,
      author: (info.author || '').slice(0, 100) || undefined,
      source: 'plugin',
    };

    const res = await ask({ type: 'beacon-save-inspiration', payload });
    if (res?.ok) {
      if (noteEl) noteEl.value = '';
      showToast(res.duplicate ? '✓ 这条已经在收集箱里了，备注已更新' : `✓ 已收进灵感箱（待用 ${res.total} 条）`, true);
    } else {
      showToast(res?.error || '保存失败，请稍后重试', false);
    }
    btn.disabled = false;
    btn.innerHTML = `${svgIcons.bulb} <span>收进灵感箱</span>`;
  });

  // 采集本页。**先分流再采**：自有后台走 /api/ingest/self，公开竞对页走 /api/ingest/competitor，
  // 两条通道的数据落在完全不同的地方，走错一条不是「数据不准」而是把自己的后台数据
  // 写进了竞对库。其余站点两条都不走——没有第三种正确答案。
  collectBtn.addEventListener('click', async () => {
    const btn = collectBtn;
    const restore = () => { btn.disabled = false; btn.innerHTML = COLLECT_LABEL; };
    btn.disabled = true;
    btn.innerHTML = `<span>采集中…</span>`;

    const href = location.href;
    if (href.includes('localhost') || href.includes('beacon.iyunci.cn') || href.includes('127.0.0.1')) {
      showToast('当前页面是「烽火台控制台」，请在竞对页面使用', false);
      restore();
      return;
    }

    // ── 自有创作者后台：回填自己的数据看板 ──
    if (isSelfBackend()) {
      let payload = null;
      try { payload = globalThis.__beaconParse?.(); } catch { payload = null; }
      const gotPosts = payload && payload.posts && payload.posts.length > 0;
      const gotAccount = payload && (payload.dailyStats || payload.audience);
      if (!gotPosts && !gotAccount) {
        // 后台页解析不出来时**绝不兜底**（兜底会把公众号数据报成 B站，见 common.js 那段守卫）。
        // 直接把自检结论说出来：断在哪一步，用户自己就能判断是没加载完还是站错了页。
        let reason = '没读到数据——请确认已打开「数据中心 · 作品数据」页并等内容加载完';
        try {
          const d = globalThis.__beaconSelfDiagnose?.();
          if (d && !d.ok && d.reason) reason = String(d.reason).split('\n')[0];
        } catch { /* 自检失败不影响主提示 */ }
        showToast(reason, false);
        restore();
        return;
      }
      const res = await ask({ type: 'beacon-ingest-self', payload });
      // summary/summaryOk 由 sw.js 统一措辞：请求成功但一条都没入库时 summaryOk=false，
      // 那是失败，不能报成勾（否则用户看到 ✓ 却在数据看板上什么都找不到）。
      if (res?.ok) showToast(res.summary || '✓ 已回填到数据看板', res.summaryOk !== false);
      else showToast('回填未完成: ' + (res?.error || '请求异常'), false);
      restore();
      return;
    }

    // ── 公开竞对页 ──
    if (!isCompetitorPage()) {
      // 认不出平台时兜底解析会默认 platform='bilibili' 并按路径瞎凑 handle，
      // 在竞对库里建出一个不存在的账号。这种页面用灵感箱记一笔就够了。
      showToast('这个站点不在竞对采集范围内（B站/抖音/小红书/YouTube/X），可以用下面的「收进灵感箱」', false);
      restore();
      return;
    }

    const info = getPageInfo();
    if (!info.payload || !info.payload.handle) {
      showToast('没能从这一页解析出账号信息，等页面加载完再试一次', false);
      restore();
      return;
    }

    // 翻页采集：首屏通常只渲染 18–20 张卡片，剩下的要往下滚才加载（见 common.js beaconCollectDeep）。
    // 侧栏跑在页面里，直接调就行，不用绕消息通道。用户是**主动点的采集**，滚页面是他要的行为；
    // 采完滚动位置会还回去。翻不出更多就沿用首屏那份，绝不因为翻页失败而整趟白跑。
    let payloadSrc = info.payload;
    if (typeof globalThis.__beaconCollectDeep === 'function' && typeof globalThis.__beaconParse === 'function') {
      btn.innerHTML = '<span>采集中…（正在翻页加载更多作品）</span>';
      try {
        const deeper = await globalThis.__beaconCollectDeep(globalThis.__beaconParse);
        if (deeper && deeper.handle && (deeper.posts?.length || 0) > (payloadSrc.posts?.length || 0)) payloadSrc = deeper;
      } catch { /* 翻页失败就用首屏那份 */ }
    }

    const payload = { ...payloadSrc, autoSubscribe: true };
    const res = await ask({ type: 'beacon-ingest', payload });
    if (res?.ok) {
      if (res.newlySubscribed) {
        showToast('✓ 已自动将「' + res.competitor + '」添加至竞对库，回传 ' + res.posts + ' 条数据', true);
      } else {
        showToast('✓ 已回传「' + res.competitor + '」的 ' + res.posts + ' 条公开数据', true);
      }
    } else {
      showToast('采集未完成: ' + (res?.error || '请求异常'), false);
    }
    restore();
  });

  // 聊天与 AI 指令
  const chatMsgs = document.getElementById('beacon-chat-msgs');
  const appendChatBubble = (role, text) => {
    const div = document.createElement('div');
    div.className = `beacon-bubble ${role}`;
    
    const avatar = document.createElement('div');
    avatar.className = `beacon-avatar ${role}`;
    avatar.innerHTML = role === 'user' ? svgIcons.user : svgIcons.sparkles;

    const card = document.createElement('div');
    card.className = `beacon-bubble-card ${role}`;

    // 先转义再套格式：这段文本里混着**页面来的**内容（标题会被带进 AI 回答），
    // 不转义的话一个 <img onerror=…> 的页面标题就能在侧栏里执行脚本。
    const formatted = esc(text)
      .replace(/^### (.*$)/gim, '<strong style="color:#e8552d">$1</strong>')
      .replace(/^#### (.*$)/gim, '<strong style="color:#2563eb">$1</strong>')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');
    card.innerHTML = formatted;

    div.appendChild(avatar);
    div.appendChild(card);
    chatMsgs.appendChild(div);
    chatMsgs.scrollTop = chatMsgs.scrollHeight;
  };

  const sendAiReq = async (q, action) => {
    appendChatBubble('user', q || (action === 'analyze' ? '爆款要点拆解' : '衍生3个选题'));
    appendChatBubble('assistant', '烽火台 AI 思考中…');

    const info = getPageInfo();
    const resp = await ask({
      type: 'beacon-ai-chat',
      payload: {
        question: q,
        action,
        context: {
          title: info.title,
          author: info.author,
          platform: info.platform,
          metrics: info.metrics,
          url: safeHref(location.href), // 后台页地址带 token，别把它发去服务端
          // 页面正文：只在用户点了「拆解 / 衍生 / 发送」时才取才发（见 common.js beaconPageText）。
          // 没有它，「爆款要点拆解」拆的其实只是一个标题。
          snippet: typeof globalThis.beaconPageText === 'function' ? globalThis.beaconPageText() : undefined,
        },
      },
    });

    chatMsgs.removeChild(chatMsgs.lastChild);

    if (resp?.ok) {
      appendChatBubble('assistant', resp.answer);
    } else {
      appendChatBubble('assistant', `⚠️ 响应未成功: ${resp?.error || '请检查采集令牌与连接'}`);
    }
  };

  document.getElementById('beacon-ai-ideas').addEventListener('click', () => sendAiReq(null, 'ideas'));
  document.getElementById('beacon-chat-send').addEventListener('click', () => {
    const input = document.getElementById('beacon-chat-input');
    const txt = input.value.trim();
    if (txt) {
      input.value = '';
      sendAiReq(txt, 'chat');
    }
  });
  document.getElementById('beacon-chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const input = document.getElementById('beacon-chat-input');
      const txt = input.value.trim();
      if (txt) {
        input.value = '';
        sendAiReq(txt, 'chat');
      }
    }
  });

  // 广播监听
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'beacon-toggle-sidebar') {
      toggleDrawer(true);
    }
  });
})();
