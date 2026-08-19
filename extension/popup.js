// 烽火台 AI 采集助手 · Popup 脚本 (v2 重构版)
//
// X 上的用户主页 / 推文详情页。保留路径（/home /explore /i/… ）排掉，句柄按 X 的规则限 1-15 位。
// 与 sidepanel.js 的同名常量**必须一字不差**（tests/ingest/x-self.test.ts 锁了这条）。
const X_SELF_PAGE =
  /^https:\/\/(?:x|twitter)\.com\/(?!(?:home|explore|notifications|messages|settings|compose|search|hashtag|about|tos|privacy|login|signup|i|intent)(?:[/?#]|$))[A-Za-z0-9_]{1,15}(?:[/?#]|$)/;

// TikTok 的主页与作品页都以 /@<unique_id> 开头，功能页（/foryou /explore /live /tag/…）一律不带 @。
// 靠这个形态分辨，不用保留字名单——名单每漏一个新功能路径就会建出一个假账号。
// 用户名字符集按 TikTok 规则：字母/数字/下划线/点，≤24 位。与 sidepanel.js / content/sidebar.js **同一份口径**。
const TT_SELF_VIDEO = /^https:\/\/www\.tiktok\.com\/@[\w.]{1,24}\/(?:video|photo)\/\d+/;
const TT_SELF_PROFILE = /^https:\/\/www\.tiktok\.com\/@[\w.]{1,24}\/?(?:[?#]|$)/;

const SUPPORTED = [
  /^https:\/\/(?:space|www)\.bilibili\.com\//,
  /^https:\/\/www\.douyin\.com\//,
  /^https:\/\/www\.xiaohongshu\.com\//,
  /^https:\/\/(?:x|twitter)\.com\//,
  /^https:\/\/www\.youtube\.com\//,
  /^https:\/\/www\.tiktok\.com\//,
];
const SELF_SUPPORTED = [
  // 公开作品页（自己的作品，公开可见指标）
  /^https:\/\/www\.bilibili\.com\/video\//,
  /^https:\/\/www\.douyin\.com\/video\//,
  /^https:\/\/www\.xiaohongshu\.com\/(?:explore|discovery\/item)\//,
  // 自己的小红书主页。与 X 同理：小红书虽然有创作者后台（完播率等只有那儿有），
  // 但用户站在自己主页上时同样期望能一键回填——此前这里只给得出「加为竞对」。
  /^https:\/\/www\.xiaohongshu\.com\/user\/profile\/[0-9a-zA-Z]+/,
  // 其余平台「自己的主页」。与小红书/X 同一个道理：我的主页和竞对主页是同一种页面，
  // 页面本身分不出是谁的——靠 isSelf 阳性信号放行，认不出就要求再点一次确认。
  /^https:\/\/space\.bilibili\.com\/\d+/,
  /^https:\/\/www\.douyin\.com\/user\/[\w-]+/,
  /^https:\/\/www\.youtube\.com\/(?:@[^/?#]+|channel\/[\w-]+|c\/[^/?#]+|user\/[^/?#]+)/,
  // TikTok：与 X 同一个道理——播放/点赞/评论/分享对所有人公开，你自己那条的数字
  // 就在你自己的主页上，没有「创作者后台」这种独立域名可认（见 content/tiktok.js 顶部）。
  TT_SELF_PROFILE,
  TT_SELF_VIDEO, // 单条作品页，与 B站/抖音的 video 页同档
  // 创作者后台（本人登录态下的自有数据，含公开页拿不到的完播率/完读率）。
  // 只认后台路径，不认任何他人主页/作品页；公众号只认 /cgi-bin 后台，不认 /s 文章正文页。
  /^https:\/\/channels\.weixin\.qq\.com\/platform\//,
  /^https:\/\/mp\.weixin\.qq\.com\/cgi-bin\//,
  /^https:\/\/creator\.douyin\.com\//,
  /^https:\/\/creator\.xiaohongshu\.com\//,
  /^https:\/\/member\.bilibili\.com\//,
  // X 没有「创作者后台」这种独立域名可认——浏览量在 X 上对所有人公开，
  // 你自己那条推的数字就在你自己的主页上，和竞对那条推在同一个 DOM 位置（见 content/x.js 顶部）。
  // 所以自有通道认的是「非保留路径的用户主页 / 推文详情页」，与 B站/抖音/小红书的公开作品页同一个道理：
  // 页面本身分不出是谁的，靠用户点哪个按钮来分（点错的防线见下方 X_SELF）。
  // 保留路径（/home /explore /i/… ）必须排掉，否则刷首页时也会冒出「这是我的作品」。
  X_SELF_PAGE,
];
// 创作者后台（非公开页面）。与 sidepanel.js 的同名常量同一份口径。
// 用途：① 只有这些页面有 🔍 自检（self-backend.js）；② 它们绝不可以走竞对通道。
const SELF_ONLY_BACKEND = /^https:\/\/(?:channels\.weixin\.qq\.com\/platform|mp\.weixin\.qq\.com\/cgi-bin|creator\.douyin\.com|creator\.xiaohongshu\.com|member\.bilibili\.com)\//;
const PLATFORM_NAME = { bilibili: 'B站', douyin: '抖音', xiaohongshu: '小红书', youtube: 'YouTube', x: 'X', wechat: '公众号', shipinhao: '视频号', tiktok: 'TikTok' };

let allCompetitors = [];
let currentHostUrl = 'https://beacon.iyunci.cn';
let pending = false;

function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// DOM Elements
const btn = document.getElementById('collect');
const selfBtn = document.getElementById('collectself');
const result = document.getElementById('result');
const clistEl = document.getElementById('clist');
const listhead = document.getElementById('listhead');
const pageTypeBadge = document.getElementById('pageTypeBadge');
const chatMsgs = document.getElementById('chatMsgs');
const chatInput = document.getElementById('chatInput');

function show(text, ok) {
  result.textContent = text;
  result.className = ok ? 'ok' : 'err';
}

// 自检信息专用：文本 + 一个「复制」按钮。
// 为什么单独做：DOM 校准失败时的自检串里带真实链接样本，很长；让用户截图既难读也容易看错一个字符，
// 而这串正是我们唯一能据以修选择器的线索。给个复制按钮，用户直接粘贴回来，零信息损失。
// 只用 textContent + createElement，不拼 innerHTML（自检串含页面来的 href，绝不能当 HTML 解析）。
function showDiagnose(text) {
  result.className = 'err';
  result.textContent = '';
  const body = document.createElement('div');
  body.textContent = text;
  result.appendChild(body);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = '📋 复制自检信息';
  btn.style.cssText =
    'margin-top:8px;font-size:11px;padding:4px 10px;border-radius:6px;cursor:pointer;' +
    'border:1px solid currentColor;background:transparent;color:inherit;font-family:inherit';
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 剪贴板不可用时退回选中，用户仍可手动 Ctrl+C
      const r = document.createRange();
      r.selectNodeContents(body);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    }
    btn.textContent = '✓ 已复制，粘贴发回即可';
    setTimeout(() => { btn.textContent = '📋 复制自检信息'; }, 2500);
  });
  result.appendChild(btn);
}

// chrome.runtime.sendMessage 会 **reject**，而且是这类界面最常见的卡死原因：
// service worker 的处理函数抛错没回话（消息通道关闭），或插件刚被重新加载。
// 下面的按钮处理都是 async 的，reject 会直接跳过后面的复原逻辑——
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
        ? '插件刚更新过，请关掉这个面板重新打开'
        : `插件后台没有响应：${m}`,
    };
  }
}

function isToday(iso) {
  if (!iso) return false;
  const d = new Date(iso), n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

// 「我的主页」与「竞对主页」是**同一种页面**的平台：X、小红书、B站、抖音、YouTube。
// 页面本身分不出是谁的号，唯一的分辨依据是「用户点了哪个按钮」——所以这两类页面上
// 回填前要多一道确认。点错不是「采得不准」：竞对的几十条内容会被写成**你自己的发布记录**，
// 污染数据看板与基线、喂进学习样本（lib/insight/learn.ts），而且没有一键撤销。
// **单篇作品页**（B站/抖音的 video、小红书的笔记）不在其中：那儿只有一条内容，
// 点错代价小得多，也是既有行为，不加摩擦。
//
// 站点解析器读到「编辑资料」这类只有本人可见的入口时会带 isSelf:true → 直接放行；
// 读不到（含平台改版让选择器失效）就要求在同一个地址上再点一次——多一次点击，换掉一次不可逆的错归属。
const XHS_SELF_PROFILE = /^https:\/\/www\.xiaohongshu\.com\/user\/profile\/[0-9a-zA-Z]+/;
const BILI_SELF_SPACE = /^https:\/\/space\.bilibili\.com\/\d+/;
const DY_SELF_PROFILE = /^https:\/\/www\.douyin\.com\/user\/[\w-]+/;
const YT_SELF_CHANNEL = /^https:\/\/www\.youtube\.com\/(?:@[^/?#]+|channel\/[\w-]+|c\/[^/?#]+|user\/[^/?#]+)/;
// TikTok 只把**主页**算进来（TT_SELF_VIDEO 不在其中）：单条作品页点错只多一条记录，
// 与 B站/抖音的 video 页同档，不加摩擦。
const AMBIGUOUS_PROFILE = [X_SELF_PAGE, XHS_SELF_PROFILE, BILI_SELF_SPACE, DY_SELF_PROFILE, YT_SELF_CHANNEL, TT_SELF_PROFILE];

let selfProfileConfirmedUrl = '';
function confirmSelfProfile(payload, url, say) {
  if (!AMBIGUOUS_PROFILE.some((re) => re.test(url))) return true; // 单篇作品页/创作者后台不受影响
  if (payload?.isSelf === true) return true;
  if (selfProfileConfirmedUrl === url) return true;
  selfProfileConfirmedUrl = url;
  const who = payload?.profile?.name || (payload?.handle ? `@${payload.handle}` : '这个账号');
  say(
    `这一页没读到「编辑资料」这类只有本人才看得到的入口。确认 ${who} 是你自己的号吗？\n`
    + `· 是 → 再点一次「这是我的作品」即可回填\n`
    + `· 不是 → 请改用「加为竞对并采集」，否则它的内容会被记成你自己的作品`,
  );
  return false;
}

// ── Tab 切换 ──
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.content').forEach((c) => c.classList.remove('active'));
    tab.classList.add('active');
    const targetId = tab.getAttribute('data-target');
    document.getElementById(targetId)?.classList.add('active');
  });
});

// ── Host 配置 ──
async function getHost() {
  const { host } = await ask({ type: 'beacon-get-config' });
  if (host) currentHostUrl = host;
  return currentHostUrl;
}

const openHome = async (path = '') => {
  const host = await getHost();
  const target = `${host.replace(/\/$/, '')}${path}`;
  chrome.tabs.create({ url: target });
};

// ── 底部导航栏 ──
document.getElementById('jumpHome').addEventListener('click', () => openHome('/'));
document.getElementById('navHome').addEventListener('click', () => openHome('/'));
document.getElementById('navSettings').addEventListener('click', () => chrome.runtime.openOptionsPage());

document.getElementById('navSidePanel').addEventListener('click', async () => {
  try {
    const currentWindow = await chrome.windows.getCurrent();
    if (chrome.sidePanel && typeof chrome.sidePanel.open === 'function') {
      await chrome.sidePanel.open({ windowId: currentWindow.id });
      window.close();
    } else {
      show('当前 Chrome 版本未开启 SidePanel 支持', false);
    }
  } catch (e) {
    show('无法打开侧边栏: ' + (e?.message || e), false);
  }
});

document.getElementById('navInPageAi').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'beacon-toggle-sidebar' });
      window.close();
    } catch {
      show('未能连上页面脚本，请刷新该网页后重试', false);
    }
  }
});

// ── 竞对列表 ──
function renderList(competitors) {
  allCompetitors = competitors || [];
  filterAndRenderList();
}

function filterAndRenderList() {
  const q = (document.getElementById('searchComp')?.value || '').toLowerCase().trim();
  // 可采性**只看 collectable**，别再掺 url：公众号没有公开主页（url 恒为 null）却是可采的
  //（走用户自己后台那条路）。按 url 过滤会让它从列表里消失，而下面的「待刷新 N」又把它算进去
  // ——「说有 3 个待刷新，列表里只有 2 个」正是那种最难查的对不上。
  // 早先的补丁是 `c.url || c.platform === 'wechat'`，那只是把这一个平台写死进条件里；
  // 下一个「可采但没有公开主页」的平台（视频号）进来时会原样再消失一次。
  // 现在两处用同一个判据，采不采得动交给按钮去表达（没有入口就置灰说明，不是把整行藏起来）。
  const list = allCompetitors.filter(
    (c) => c.collectable && (!q || c.name.toLowerCase().includes(q) || c.handle.toLowerCase().includes(q)),
  );

  clistEl.innerHTML = '';
  if (list.length === 0) {
    clistEl.innerHTML = '<div style="color:var(--text-3); font-size:12px; padding:12px; text-align:center">暂无匹配的订阅竞对</div>';
    return;
  }
  const staleN = allCompetitors.filter((c) => c.collectable && !isToday(c.lastCrawledAt)).length;
  const headText = document.querySelector('#listhead span');
  if (headText) {
    headText.textContent = staleN > 0 ? `竞对清单 · 待刷新 ${staleN}/${allCompetitors.length}` : `竞对清单 · 今日全刷新 ✓`;
  }

  for (const c of list) {
    const done = isToday(c.lastCrawledAt);
    const row = document.createElement('div');
    row.className = 'citem';
    const meta = document.createElement('div');
    meta.className = 'cmeta';
    meta.innerHTML =
      `<div class="cname" title="${escHtml(c.name)}">${escHtml(c.name)}</div>` +
      `<div class="csub"><span class="dot ${done ? 'fresh' : 'stale'}"></span>${done ? '今日已刷新' : '待刷新'} · <span class="badge">${PLATFORM_NAME[c.platform] || escHtml(c.platform)}</span></div>`;
    const go = document.createElement('button');
    go.className = 'go';
    // 后台通道（公众号）/ 打开主页 / 两样都没有。第三种**置灰并说明**，不隐藏——
    // 藏起来用户会以为这个号没订阅上，置灰他至少知道「订阅了，但这个平台还采不动」。
    const isWechat = c.platform === 'wechat';
    const canOpen = !!c.url;
    go.textContent = isWechat ? '后台采集' : canOpen ? (done ? '再采' : '打开采集') : '暂无入口';
    if (!isWechat && !canOpen) {
      go.disabled = true;
      go.title = '这个平台还没有可直接打开的采集入口，也没有后台通道——先在网页端看它的说明';
    }
    go.addEventListener('click', async () => {
      if (!isWechat) { if (canOpen) chrome.tabs.create({ url: c.url }); return; }
      // 公众号：后台开自己的公众号后台采，全程不跳走当前页面。结果与被节流拦下的理由
      // 都要说出来——静默失败会让用户以为坏了然后猛点。
      go.disabled = true;
      go.textContent = '采集中…';
      const r = await ask({ type: 'wechat-collect-one', name: c.handle });
      go.disabled = false;
      go.textContent = '后台采集';
      const sub = row.querySelector('.csub');
      if (sub) {
        sub.textContent = r?.ok
          ? `已采 ${r.posts} 篇${r.partial ? `（${r.partial}）` : ''}`
          : r?.error || '采集失败';
        sub.style.color = r?.ok ? 'var(--green)' : 'var(--red)';
      }
      if (r?.ok) loadList(true);
    });
    row.appendChild(meta);
    row.appendChild(go);
    clistEl.appendChild(row);
  }
}

document.getElementById('searchComp')?.addEventListener('input', filterAndRenderList);

async function loadList(force) {
  clistEl.innerHTML = '<div style="color:var(--text-3); font-size:12px; text-align:center; padding:10px">加载中…</div>';
  const r = await ask({ type: 'beacon-get-competitors', force: !!force });
  if (!r?.ok) {
    clistEl.innerHTML = `<div style="color:var(--red); font-size:12px; text-align:center; padding:10px">${r?.error === 'no-token' ? '未配置有效采集令牌' : r?.error || '加载失败'}</div>`;
    return;
  }
  renderList(r.competitors);
}

document.getElementById('refresh').addEventListener('click', () => loadList(true));

// ── 批量采集 ──
const batchBtn = document.getElementById('batch');
const batchMsg = document.getElementById('batchmsg');
batchBtn.addEventListener('click', () => {
  batchBtn.disabled = true;
  batchMsg.textContent = '准备批量采集…';
  chrome.runtime.sendMessage({ type: 'batch-collect' });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'batch-progress') {
    if (msg.busy) { batchMsg.textContent = '已有采集任务在进行中…'; return; }
    batchBtn.disabled = true;
    batchMsg.textContent = msg.current
      ? `采集中 ${msg.done}/${msg.total}: ${msg.current}`
      : `准备采集中 0/${msg.total}…`;
  } else if (msg?.type === 'batch-done') {
    batchBtn.disabled = false;
    // notes = 被节流/每轮上限拦下、或「开了页却没采到」的原因。SidePanel 一直在显示它，
    // 这里此前直接丢掉：用户看到「成功 6/10」，另外 4 个为什么没采，一个字都没有。
    const notes = Array.isArray(msg.notes) ? msg.notes : [];
    batchMsg.textContent = `✓ 同步成功 (${msg.collected}/${msg.total})`
      + (notes.length ? `；${notes.join('；')}` : '');
    loadList(true);
    // 有话要说时不自动清掉——6 秒读不完，清掉就等于没说
    if (!notes.length) setTimeout(() => { batchMsg.textContent = ''; }, 6000);
  } else if (msg?.type === 'batch-self-progress') {
    const el = document.getElementById('selfmsg');
    if (el) {
      el.style.color = 'var(--text-3)'; // 复位：上一轮那条「上次回填」可能是绿色的
      el.textContent = msg.busy
        ? '已有一批采集在跑，等它结束再点'
        : `采集中 ${msg.done}/${msg.total}${msg.current ? ` · ${msg.current}` : ''}`;
    }
  } else if (msg?.type === 'batch-self-done') {
    const el = document.getElementById('selfmsg');
    if (el) el.textContent = `✓ ${msg.total} 个账号采集完成，回填 ${msg.posts} 条作品`
      + (msg.wechat ? '；公众号后台正在后台回填' : '');
    loadSelfList();
    loadAccounts(true);
  }
});

// ── 一键加为竞对并采集 ──
btn.addEventListener('click', async () => {
  btn.disabled = true;
  // 翻页采集会滚页面加载更多作品（最长 30 秒，翻不动就提前收）——说清楚在等什么，
  // 不然用户会以为卡住了（首屏 20 条 vs 翻页后最多 50 条，这几秒是值的）。
  show('解析并添加竞对中…（正在翻页加载更多作品）', true);
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) { show('无法获取当前标签页', false); return; }
    const url = tab.url || '';

    if (url.includes('localhost') || url.includes('beacon.iyunci.cn') || url.includes('127.0.0.1')) {
      show('当前页面是「烽火台控制台」。请在 B站/抖音/小红书/YouTube/X/TikTok 竞对主页或作品页上使用采集。', false);
      return;
    }

    if (url && !SUPPORTED.some((re) => re.test(url))) {
      show('请在支持的公开主页或视频详情页上使用（B站/抖音/小红书/YouTube/X/TikTok）', false);
      return;
    }
    let collected;
    try {
      collected = await chrome.tabs.sendMessage(tab.id, { type: 'beacon-collect', deep: true });
    } catch {
      show('未能连接页面脚本，请刷新该页面后重试', false);
      return;
    }
    if (!collected?.ok) {
      // 后台页解析失败时顺手自检一次，把「断在哪一步」直接告诉用户——
      // 这些后台的 DOM 无法在开发环境校准，用户是唯一能看到真实结构的人
      let hint = '';
      if (SELF_ONLY_BACKEND.test(url)) {
        try {
          const d = await chrome.tabs.sendMessage(tab.id, { type: 'beacon-diagnose' });
          if (d?.ok) hint = `（自检：${d.hint}）`;
          else if (d?.reason) hint = `（自检：${d.reason}）`;
        } catch { /* 自检失败不影响主提示 */ }
      }
      const msg = `${collected?.error ?? '解析失败'}${hint}`;
      // 带自检信息时给复制按钮：这串是修选择器的唯一线索，让用户粘贴回来而不是截图
      if (hint) showDiagnose(msg);
      else show(msg, false);
      return;
    }

    const payload = { ...collected.payload, autoSubscribe: true };
    const r = await ask({ type: 'beacon-ingest', payload });
    if (r?.ok) {
      const hasMetrics = (r.withMetrics ?? r.posts) > 0;
      if (r.newlySubscribed) {
        if (hasMetrics) {
          show(`✓ 已自动添加「${r.competitor}」至竞对库，并回传 ${r.withMetrics ?? r.posts} 条数据！`, true);
        } else if (r.posts > 0) {
          show(`✓ 已自动添加「${r.competitor}」至竞对库，收录 ${r.posts} 条作品但未读到播放/点赞等指标——建议等页面完全加载后重试`, true);
        } else {
          show(`✓ 已自动添加「${r.competitor}」至竞对库，但未读到数据指标——建议等页面完全加载后重试`, true);
        }
      } else {
        if (hasMetrics) {
          show(`✓ 已更新「${r.competitor}」的 ${r.withMetrics ?? r.posts} 条竞对公开数据`, true);
        } else if (r.posts > 0) {
          show(`已收录「${r.competitor}」${r.posts} 条作品但未读到播放/点赞等指标——建议等页面完全加载后重试`, true);
        } else {
          show(`已收录「${r.competitor}」页面信息，但未读到数据指标——建议等页面完全加载后重试`, true);
        }
      }
      loadList(true);
    } else {
      show(r?.error ?? '回传失败', false);
    }
  } finally {
    btn.disabled = false;
  }
});

// ── 回填自有作品 ──
// 「工作区里还没有这个平台的账号」不需要用户操心：sw.js 的 ingestSelf 会用页面上的昵称
// 就地建号、绑定，再把这一趟的数据写进去——一次点击走完。
selfBtn.addEventListener('click', async () => {
  selfBtn.disabled = true;
  show('回填中…', true);
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) { show('无法获取当前标签页', false); return; }
    const url = tab.url || '';
    if (!SELF_SUPPORTED.some((re) => re.test(url))) {
      show('请在你自己的作品页（B站/抖音/小红书/X/YouTube/TikTok），或创作者后台的「数据中心 · 作品数据」页使用（视频号/公众号/抖音/小红书/B站）', false);
      return;
    }
    let collected;
    try {
      collected = await chrome.tabs.sendMessage(tab.id, { type: 'beacon-collect', deep: true });
    } catch {
      show('未能连接页面脚本，请刷新页面后重试', false);
      return;
    }
    if (!collected?.ok) {
      // 后台页解析失败时顺手自检一次，把「断在哪一步」直接告诉用户——
      // 这些后台的 DOM 无法在开发环境校准，用户是唯一能看到真实结构的人
      let hint = '';
      if (SELF_ONLY_BACKEND.test(url)) {
        try {
          const d = await chrome.tabs.sendMessage(tab.id, { type: 'beacon-diagnose' });
          if (d?.ok) hint = `（自检：${d.hint}）`;
          else if (d?.reason) hint = `（自检：${d.reason}）`;
        } catch { /* 自检失败不影响主提示 */ }
      }
      const msg = `${collected?.error ?? '解析失败'}${hint}`;
      // 带自检信息时给复制按钮：这串是修选择器的唯一线索，让用户粘贴回来而不是截图
      if (hint) showDiagnose(msg);
      else show(msg, false);
      return;
    }
    if (!confirmSelfProfile(collected.payload, url, (t) => show(t, false))) return;

    const r = await ask({ type: 'beacon-ingest-self', payload: collected.payload });
    if (!r?.ok) {
      show(r?.error ?? '回填失败', false);
      return;
    }
    // 没有账号时 sw.js 已经就地建号并写入了，下拉框要跟着刷新，否则显示的还是「按平台自动匹配」
    if (r.createdAccount) await loadAccounts(true);
    // summary 由 sw.js 统一措辞（三个入口同一份口径）。summaryOk=false 表示
    // 「请求成功但一条都没入库」——那是失败，不能报成勾。
    if (r.summaryOk) {
      show(r.summary, true);
      return;
    }
    // 一条都没入库时顺手自检：断在哪一步只有现场看得到，别让用户对着一句话干瞪眼
    let hint = '';
    if (SELF_ONLY_BACKEND.test(url)) {
      try {
        const d = await chrome.tabs.sendMessage(tab.id, { type: 'beacon-diagnose' });
        const h = d?.ok ? d.hint : d?.reason;
        if (h) hint = `\n（自检：${h}）`;
      } catch { /* 自检失败不影响主提示 */ }
    }
    if (hint) showDiagnose(r.summary + hint);
    else show(r.summary, false);
  } finally {
    selfBtn.disabled = false;
  }
});

// ── 看看这一页采到了什么 ──
// 「回填成功」不等于「采对了」。自检会把标题/链接/时间/每个指标原样列出来，
// 用户对着后台页一眼就能指出哪一项不对——这是我修选择器/别名的唯一依据。
document.getElementById('diagnoseself')?.addEventListener('click', async () => {
  show('自检中…', true);
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) { show('无法获取当前标签页', false); return; }
    const d = await chrome.tabs.sendMessage(tab.id, { type: 'beacon-diagnose' });
    showDiagnose(d?.ok ? d.hint : (d?.reason ?? '自检没有返回结果'));
  } catch {
    show('未能连接页面脚本，请刷新页面后重试', false);
  }
});

// ── AI 助手聊天 ──
function appendBubble(role, text) {
  const div = document.createElement('div');
  div.className = `bubble ${role}`;
  // 先转义再套格式：这段文本里混着页面标题等外部内容，
  // 不转义的话 <img onerror=…> 这种标题就能在 popup 里执行脚本。
  const formatted = escHtml(String(text == null ? '' : text))
    .replace(/^### (.*$)/gim, '<strong style="color:var(--brand)">$1</strong>')
    .replace(/^#### (.*$)/gim, '<strong style="color:var(--accent)">$1</strong>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
  div.innerHTML = formatted;
  chatMsgs.appendChild(div);
  chatMsgs.scrollTop = chatMsgs.scrollHeight;
  return div;
}

async function getActiveTabContext() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return {};
    let collected = null;
    try {
      // **不带 deep**：这是 AI 助手的上下文抓取，用户每问一句都会走一次。
      // 翻页采集要滚页面 + 等懒加载（最长 30 秒），挂在这儿等于每次提问前先卡半分钟。
      collected = await chrome.tabs.sendMessage(tab.id, { type: 'beacon-collect' });
    } catch { /* ignore */ }
    // 页面正文：popup 是扩展页面，够不到页面 DOM，只能向内容脚本要一次。
    // 取不到（普通网页没注入、或页面还没就绪）就不带——助手少一块上下文，不该整个请求失败。
    let snippet = '';
    try {
      const t = await chrome.tabs.sendMessage(tab.id, { type: 'beacon-page-text' });
      if (t?.ok && t.text) snippet = t.text;
    } catch { /* ignore */ }

    const payload = collected?.payload || {};
    return {
      title: payload.posts?.[0]?.title || tab.title || '',
      author: payload.profile?.name || payload.handle || '',
      platform: payload.platform || '',
      metrics: payload.posts?.[0]?.metrics || {},
      url: tab.url || '',
      snippet,
    };
  } catch {
    return {};
  }
}

// ── 我的账号清单 + 一键采集 ──
// 与竞对清单同一个形态，只是走自有通道（/api/ingest/self）。
// 「能不能一键采」按账号如实标：X 靠 handle 开自己主页；创作者后台要登录态换 token、
// 站内还得跳两次，那是另一套流程（sw.js runSelfAuto），一键采会顺带触发它；
// 公开作品页与 multi 账号没有「一个地址采全部」这回事，只能手动。
function selfCollectHint(a) {
  if (a.platform === 'x') return a.handle ? { ok: true, text: '可一键采集' } : { ok: false, text: '需在账号里补 handle' };
  if (a.platform === 'wechat') return { ok: true, text: '一键采集时后台自动回填' };
  if (a.platform === 'multi') return { ok: false, text: '多平台账号 · 请在具体作品页回填' };
  return { ok: false, text: '需打开创作者后台/作品页手动回填' };
}

async function loadSelfList() {
  const box = document.getElementById('selflist');
  const head = document.getElementById('selfhead');
  if (!box) return;
  const r = await ask({ type: 'beacon-get-accounts' });
  const accounts = r?.ok && Array.isArray(r.accounts) ? r.accounts : [];
  if (accounts.length === 0) {
    box.innerHTML = `<div style="color:var(--text-3); font-size:11.5px; padding:6px">还没有创作账号——在自己的作品页点「这是我的作品」，插件会自动建一个</div>`;
    return;
  }
  const NAME = { ...PLATFORM_NAME, multi: '多平台' };
  const usable = accounts.filter((a) => selfCollectHint(a).ok).length;
  if (head) head.textContent = `我的账号 · ${usable}/${accounts.length} 可一键采集`;
  box.innerHTML = '';
  for (const a of accounts) {
    const hint = selfCollectHint(a);
    const row = document.createElement('div');
    row.className = 'citem';
    row.innerHTML =
      `<div><div style="font-size:12px; font-weight:600">${escHtml(a.name)}</div>` +
      `<div style="font-size:11px; color:var(--text-2); margin-top:2px">` +
      `<span class="dot ${hint.ok ? 'fresh' : 'stale'}"></span>` +
      `${escHtml(NAME[a.platform] || a.platform)} · ${escHtml(hint.text)}</div></div>`;
    box.appendChild(row);
  }
}

document.getElementById('batchself')?.addEventListener('click', () => {
  const msg = document.getElementById('selfmsg');
  if (msg) { msg.style.color = 'var(--text-3)'; msg.textContent = '正在后台逐个打开并采集…'; }
  chrome.runtime.sendMessage({ type: 'batch-collect-self' });
});

// ── 回填到哪个账号 ──
// 不绑定就由后端按平台猜（lib/ingest/own-post.ts resolveTargetAccount）。一个工作区经营
// 两个同平台账号时猜必然错一半，而挂错账号在数据看板上是彻底看不见 + 污染另一个号的基线。
// 绑定关系存 chrome.storage.sync，popup / SidePanel / 页内侧栏 / 设置页共用同一个值。
async function loadAccounts(force = false) {
  const sel = document.getElementById('accountSel');
  if (!sel) return;
  const r = await ask({ type: 'beacon-get-accounts', force });
  if (!r?.ok || !Array.isArray(r.accounts) || r.accounts.length === 0) return;
  // 重建而不是追加：建完号会再调一次，追加的话同一个账号会在下拉框里出现两遍。
  //「（按平台自动匹配）」那一项是模板的一部分，保留。
  sel.length = 1;
  const NAME = { ...PLATFORM_NAME, multi: '多平台' };
  for (const a of r.accounts) {
    const opt = document.createElement('option');
    opt.value = a.id;
    // textContent 而不是 innerHTML：账号名是用户自己填的，可能带 < >
    opt.textContent = `${NAME[a.platform] || a.platform} · ${a.name}${a.status !== 'active' ? '（已停用）' : ''}`;
    sel.appendChild(opt);
  }
  if (r.selfAccountId) sel.value = r.selfAccountId;
}
document.getElementById('accountSel')?.addEventListener('change', async (e) => {
  const v = e.target.value;
  await ask({ type: 'beacon-set-account', accountId: v });
  show(v ? '✓ 已绑定，之后的回填都记到这个账号名下' : '✓ 已改回「按平台自动匹配」', true);
});

// ── 收进灵感箱（第三条通道，任何网页上都可用）──
// 与上面两个采集按钮的关键区别：它不认平台、不写竞对库、也不写发布记录，
// 只往自己工作区的收集箱加一行（标题 + 链接 + 备注，不存正文——存正文是搬运，见 lib/ingest/inspiration.ts）。
// 所以它没有「当前页是否受支持」的前置判断，只挡烽火台自己的页面。
document.getElementById('inspire')?.addEventListener('click', async () => {
  const inspireBtn = document.getElementById('inspire');
  const noteEl = document.getElementById('inspireNote');
  inspireBtn.disabled = true;
  show('保存中…', true);
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url || '';
    if (!url) { show('读不到当前标签页地址', false); return; }
    if (url.includes('localhost') || url.includes('beacon.iyunci.cn') || url.includes('127.0.0.1')) {
      show('这是烽火台自己的页面，换个内容页再收藏', false);
      return;
    }
    // 平台只在**认识**时才带：后端对未知平台整条打回，而「在不认识的站点上刷到好东西」
    // 恰恰是收集箱最该支持的场景。
    const ctx = await getActiveTabContext();
    const KNOWN = ['bilibili', 'douyin', 'xiaohongshu', 'youtube', 'x', 'wechat', 'shipinhao', 'tiktok'];
    const r = await ask({
      type: 'beacon-save-inspiration',
      payload: {
        title: ctx.title || tab.title || '',
        note: (noteEl?.value || '').trim(),
        url, // token 一类等同于登录态的参数由 sw.js 的 inspireSafeUrl 统一抹掉
        platform: KNOWN.includes(ctx.platform) ? ctx.platform : undefined,
        author: ctx.author || undefined,
        source: 'plugin',
      },
    });
    if (r?.ok) {
      if (noteEl) noteEl.value = '';
      show(r.duplicate ? '✓ 这条已经在收集箱里了，备注已更新' : `✓ 已收进灵感箱（待用 ${r.total} 条）`, true);
    } else {
      show(r?.error || '保存失败，请稍后重试', false);
    }
  } finally {
    inspireBtn.disabled = false;
  }
});

// ── 读评论提问 ──
document.getElementById('collectComments')?.addEventListener('click', async () => {
  const ccBtn = document.getElementById('collectComments');
  // 没开就直接送去设置页。发起采集再让后台回一句「未开启」是最没用的反馈：
  // 用户看完还是不知道去哪开。
  if (ccBtn.dataset.locked === '1') {
    show('评论提问采集默认关闭，正在打开设置页…', true);
    try { chrome.runtime.openOptionsPage(); } catch { /* 打不开就只剩上面那句提示 */ }
    return;
  }
  ccBtn.disabled = true;
  show('正在读取评论区提问…', true);
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) { show('无法获取当前标签页', false); return; }
    const r = await ask({ type: 'beacon-collect-comments', tabId: tab.id });
    if (r?.ok) {
      // 与 sidepanel/右键菜单同一份写法：`r.created + r.updated` 在任一字段缺席时是 NaN，
      // 用户看到的是「提取了 NaN 条提问」——一个成功的采集被展示成故障。
      const n = (r.created || 0) + (r.updated || 0);
      const c = r.comments || 0;
      show(`✓ 读了 ${r.read ?? '?'} 条评论：${n} 条提问${r.created ? `（${r.created} 条新增）` : ''}、${c} 条读者原声`, true);
    } else {
      show(r?.error || '评论采集失败', false);
    }
  } finally {
    ccBtn.disabled = false;
  }
});

let chatHistory = [];

async function sendAiMessage(promptText, actionType) {
  if (pending) return;
  const q = promptText || chatInput.value.trim();
  if (!q && !actionType) return;
  if (!promptText) chatInput.value = '';
  pending = true;

  appendBubble('user', q || (actionType === 'analyze' ? '爆款拆解当前页' : actionType === 'ideas' ? '衍生3个选题' : '提炼开头钩子'));
  const thinkingBubble = appendBubble('assistant', '烽火台 AI 正在深度分析中…');

  try {
    const context = await getActiveTabContext();
    const resp = await ask({
      type: 'beacon-ai-chat',
      payload: {
        question: q,
        action: actionType || 'chat',
        context,
        history: chatHistory,
      },
    });

    thinkingBubble.remove();

    if (resp?.ok) {
      if (resp.mocked) {
        appendBubble('assistant', '⚠️ **[示例回复]** 以下内容由本地引擎生成，非真实 AI 分析。绑定有效采集令牌后可解锁深度模型服务。\n\n' + resp.answer);
      } else {
        appendBubble('assistant', resp.answer);
      }
      chatHistory.push({ role: 'user', content: q || actionType });
      chatHistory.push({ role: 'assistant', content: resp.answer });
      if (chatHistory.length > 20) chatHistory = chatHistory.slice(-20);
    } else {
      appendBubble('assistant', `⚠️ 分析未完成: ${resp?.error || '网络或接口响应异常'}`);
    }
  } catch (e) {
    thinkingBubble.remove();
    appendBubble('assistant', `⚠️ 请求失败: ${e?.message || '未知错误'}`);
  } finally {
    pending = false;
  }
}

document.getElementById('chatSend').addEventListener('click', () => sendAiMessage());
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendAiMessage();
});

document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    const action = chip.getAttribute('data-action');
    if (action) sendAiMessage(null, action);
  });
});

// ── 初始化 ──
(async () => {
  await getHost();

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url || '';
    if (url.includes('localhost') || url.includes('beacon.iyunci.cn') || url.includes('127.0.0.1')) {
      pageTypeBadge.textContent = '烽火台控制台';
      pageTypeBadge.style.color = '#e8552d';
    } else if (SELF_SUPPORTED.some((re) => re.test(url))) {
      selfBtn.style.display = '';
      // 账号绑定只在能回填的页面上露出来（别的页面上它是个没有意义的下拉框）
      const row = document.getElementById('accountRow');
      if (row) { row.style.display = 'flex'; loadAccounts(); }
      // 🔍 自检只有创作者后台（self-backend.js）实现，公开作品页上点它永远只回一句
      // 「当前页面不是受支持的创作者后台」——那种按钮不该露出来。
      const dg = document.getElementById('diagnoseself');
      if (dg) dg.style.display = SELF_ONLY_BACKEND.test(url) ? '' : 'none';
      // X 的用户主页同时是「我的主页」和「竞对主页」（同一种页面），两个按钮都在，
      // 徽标就不能只说其中一半，否则用户会以为插件已经替他判过是谁的号了。
      pageTypeBadge.textContent = SUPPORTED.some((re) => re.test(url)) ? '我的作品 / 竞对页' : '作品详情页';
      pageTypeBadge.style.color = '#2563eb';
    } else if (SUPPORTED.some((re) => re.test(url))) {
      pageTypeBadge.textContent = '支持采集页';
      pageTypeBadge.style.color = '#16a34a';
    } else {
      pageTypeBadge.textContent = '普通网页';
    }
  } catch { /* ignore */ }

  // 评论提问按钮：开关没开时**不再整个藏起来**，而是显示成「未开启」并直通设置页。
  // 藏起来的代价是用户根本不知道有这个功能（真机上用户来问「有没有评论一键采集按钮」，
  // 就是被这个藏法坑的）。与侧栏竖条的锁定态同一套口径。
  try {
    const cs = await chrome.storage.sync.get(['commentCollectOwn', 'commentCollectRival']);
    const ccBtn = document.getElementById('collectComments');
    if (ccBtn) {
      ccBtn.style.display = '';
      const on = cs.commentCollectOwn === true || cs.commentCollectRival === true;
      ccBtn.dataset.locked = on ? '' : '1';
      if (!on) {
        ccBtn.title = '出于合规考虑默认关闭，点击去设置里打开';
        const span = ccBtn.querySelector('span');
        if (span) span.textContent = '读评论提问（未开启）';
        ccBtn.style.opacity = '0.68';
      }
    }
  } catch { /* ignore */ }

  loadList(false);
  loadSelfList();

  // ── 有新版就提示 + 一键更新 ──
  // 商店版与 zip 版天然会不同步（商店随审核走），所以这里把「你装的是哪一种、差多少」说清楚，
  // 而不是笼统一句「有新版本」。点更新之后的结果也照后台返回的原话显示——
  // zip 版根本无法自我替换，假装「已更新」就是骗人。
  try {
    const bar = document.getElementById('updateBar');
    const txt = document.getElementById('updateText');
    const btn = document.getElementById('updateBtn');
    const info = await ask({ type: 'beacon-check-update' });
    if (bar && txt && btn && info && info.hasUpdate) {
      const via = info.from === 'normal' ? '商店版' : 'zip 手动安装版';
      txt.textContent = `有新版 v${info.latest}（你现在是 v${info.current}·${via}）`;
      bar.style.display = 'flex';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const old = btn.textContent;
        btn.textContent = '更新中…';
        const r = await ask({ type: 'beacon-apply-update' });
        txt.textContent = r?.message || r?.error || '更新失败';
        btn.textContent = old;
        btn.disabled = false;
        // 开发者模式那条路要人接手，按钮改成「看看怎么装」免得用户反复点
        if (r?.mode === 'unpacked') btn.style.display = 'none';
      });
    }
  } catch { /* 检查更新失败不该影响面板其余功能 */ }

  // 上一轮公众号自动回填的结果。
  // ⚠️ 这条通道跑在后台、采完就关标签页，唯一的输出是一条系统通知——而通知在 macOS 上
  // 没给权限就被静默丢弃。用户点完只看到「公众号标签页开了又关」，面板里一个字都没有。
  // 结果落盘后（sw.js finishSelfAuto），这里在面板打开时把它读出来。
  try {
    const { lastSelfAutoLog } = await chrome.storage.local.get('lastSelfAutoLog');
    const el = document.getElementById('selfmsg');
    if (el && lastSelfAutoLog?.timestamp && !el.textContent.trim()) {
      const t = new Date(lastSelfAutoLog.timestamp).toLocaleString('zh-CN', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      });
      el.textContent = `上次公众号回填（${t}）：${lastSelfAutoLog.summary || '已触发'}`;
      el.style.color = lastSelfAutoLog.ok ? 'var(--green)' : 'var(--text-3)';
    }
  } catch { /* 读不到就当没有，不影响面板其余功能 */ }

  // Render Schedule Badge Pill
  try {
    const s = await chrome.storage.sync.get(['scheduledCollect', 'scheduledCollectHour']);
    const pill = document.getElementById('scheduleBadgePill');
    if (pill) {
      if (s.scheduledCollect !== false) {
        const hour = Number.isInteger(s.scheduledCollectHour) ? s.scheduledCollectHour : 9;
        pill.textContent = `⏰ 每日 ${String(hour).padStart(2, '0')}:00 自动采集`;
        pill.style.color = 'var(--brand)';
      } else {
        pill.textContent = '⏰ 定时采集已暂停';
        pill.style.color = 'var(--text-3)';
      }
    }
  } catch { /* ignore */ }
})();
