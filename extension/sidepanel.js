// 烽火台 Chrome SidePanel 侧边栏脚本
const PLATFORM_NAME = { bilibili: 'B站', douyin: '抖音', xiaohongshu: '小红书', youtube: 'YouTube', x: 'X', wechat: '公众号', shipinhao: '视频号', tiktok: 'TikTok' };

// ⚠️ 两条回传通道的分流白名单，与 popup.js 的 SUPPORTED / SELF_SUPPORTED **同一份口径**。
// SidePanel 是扩展页面而不是内容脚本，读不到页面里的 __beaconSelfOnly，只能按当前标签页的 URL 判。
// 这个分流不是 UI 细节：走错一条，你自己创作者后台的数据就会被写进工作区共享的竞对库。
const SUPPORTED = [
  /^https:\/\/(?:space|www)\.bilibili\.com\//,
  /^https:\/\/www\.douyin\.com\//,
  /^https:\/\/www\.xiaohongshu\.com\//,
  /^https:\/\/(?:x|twitter)\.com\//,
  /^https:\/\/www\.youtube\.com\//,
  /^https:\/\/www\.tiktok\.com\//,
];
// X 上的用户主页 / 推文详情页。保留路径（/home /explore /i/… ）排掉，句柄按 X 的规则限 1-15 位。
// 与 popup.js 的同名常量**必须一字不差**（tests/ingest/x-self.test.ts 锁了这条）。
const X_SELF_PAGE =
  /^https:\/\/(?:x|twitter)\.com\/(?!(?:home|explore|notifications|messages|settings|compose|search|hashtag|about|tos|privacy|login|signup|i|intent)(?:[/?#]|$))[A-Za-z0-9_]{1,15}(?:[/?#]|$)/;
// TikTok 的主页与作品页都以 /@<unique_id> 开头，功能页（/foryou /explore /live /tag/…）一律不带 @。
// 靠这个形态分辨，不用保留字名单——名单每漏一个新功能路径就会建出一个假账号。
// 用户名字符集按 TikTok 规则：字母/数字/下划线/点，≤24 位。与 popup.js / content/sidebar.js **同一份口径**。
const TT_SELF_VIDEO = /^https:\/\/www\.tiktok\.com\/@[\w.]{1,24}\/(?:video|photo)\/\d+/;
const TT_SELF_PROFILE = /^https:\/\/www\.tiktok\.com\/@[\w.]{1,24}\/?(?:[?#]|$)/;

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
  // X 没有「创作者后台」这种独立域名可认——浏览量在 X 上对所有人公开，
  // 你自己那条推的数字就在你自己的主页上，和竞对那条推在同一个 DOM 位置（见 content/x.js 顶部）。
  // 页面本身分不出是谁的，靠用户点哪个按钮来分（点错的防线见下方 X_SELF）。
  X_SELF_PAGE,
  // 创作者后台（本人登录态下的自有数据，含公开页拿不到的完播率/完读率）。
  // 公众号只认 /cgi-bin 后台，不认 /s 文章正文页（那是读者视角，与自有数据无关）。
  /^https:\/\/channels\.weixin\.qq\.com\/platform\//,
  /^https:\/\/mp\.weixin\.qq\.com\/cgi-bin\//,
  /^https:\/\/creator\.douyin\.com\//,
  /^https:\/\/creator\.xiaohongshu\.com\//,
  /^https:\/\/member\.bilibili\.com\//,
];
// 创作者后台是**非公开页面**，它的数据只能走自有通道。这一组是 SELF_SUPPORTED 里
// 「绝不可以出现在竞对通道」的那部分——公开作品页两条都能走，后台页只能走一条。
const SELF_ONLY_BACKEND = /^https:\/\/(?:channels\.weixin\.qq\.com\/platform|mp\.weixin\.qq\.com\/cgi-bin|creator\.douyin\.com|creator\.xiaohongshu\.com|member\.bilibili\.com)\//;

const isSelfPage = (url) => SELF_SUPPORTED.some((re) => re.test(url));
const isCompetitorPage = (url) => SUPPORTED.some((re) => re.test(url)) && !SELF_ONLY_BACKEND.test(url);

let chatHistory = [];
let currentHostUrl = 'https://beacon.iyunci.cn';
let pending = false;

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

function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// DOM Elements
const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const chatSend = document.getElementById('chatSend');
const spClist = document.getElementById('spClist');
const spListHead = document.getElementById('spListHead');

function appendBubble(role, text) {
  const div = document.createElement('div');
  div.className = `chat-bubble ${role}`;
  const formatted = text
    .replace(/^### (.*$)/gim, '<strong style="font-size:13px; color:var(--brand)">$1</strong>')
    .replace(/^#### (.*$)/gim, '<strong style="font-size:12px; color:var(--accent)">$1</strong>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
  div.innerHTML = formatted;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return div;
}

// Tab 切换
document.querySelectorAll('.sp-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.sp-tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.sp-content').forEach((c) => c.classList.remove('active'));
    tab.classList.add('active');
    const target = tab.getAttribute('data-target');
    document.getElementById(target)?.classList.add('active');
  });
});

async function getHost() {
  const { host } = await ask({ type: 'beacon-get-config' });
  if (host) currentHostUrl = host;
  return currentHostUrl;
}
document.getElementById('spJumpHome').addEventListener('click', async () => {
  const host = await getHost();
  chrome.tabs.create({ url: host });
});

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

    // 页面正文：SidePanel 是扩展页面，够不到页面 DOM，只能向内容脚本要一次。
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

async function sendAiMessage(promptText, actionType) {
  if (pending) return;
  const q = promptText || chatInput.value.trim();
  if (!q && !actionType) return;
  if (!promptText) chatInput.value = '';
  pending = true;

  appendBubble('user', q || (actionType === 'analyze' ? '爆款拆解当前页' : '衍生 3 个同赛道选题'));
  const thinkingBubble = appendBubble('assistant', '烽火台 AI 正在深度拆解中…');

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

chatSend.addEventListener('click', () => sendAiMessage());
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendAiMessage();
});

document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    const action = chip.getAttribute('data-action');
    const prompt = chip.getAttribute('data-prompt');
    if (action) sendAiMessage(null, action);
    else if (prompt) sendAiMessage(prompt);
  });
});

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

async function loadCompetitors() {
  const r = await ask({ type: 'beacon-get-competitors', force: false });
  if (!r?.ok) {
    spClist.innerHTML = `<div style="color:var(--text-3); font-size:12px; padding:10px; text-align:center">暂无竞对数据</div>`;
    return;
  }
  const list = r.competitors || [];
  const stale = list.filter(c => !isToday(c.lastCrawledAt)).length;
  if (spListHead) spListHead.textContent = stale > 0 ? `竞对清单 · 待刷新 ${stale}/${list.length}` : '竞对清单 · 全部已刷新';
  spClist.innerHTML = '';
  for (const c of list) {
    const done = isToday(c.lastCrawledAt);
    const row = document.createElement('div');
    row.className = 'citem';
    row.innerHTML =
      `<div>` +
      `<div style="font-size:12px; font-weight:600; color:var(--text)">${escHtml(c.name)}</div>` +
      `<div style="font-size:11px; color:var(--text-2); margin-top:2px"><span class="dot ${done ? 'fresh' : 'stale'}"></span>${done ? '今日已刷新' : '待刷新'} · ${PLATFORM_NAME[c.platform] || escHtml(c.platform)}</div>` +
      `</div>`;
    const btn = document.createElement('button');
    btn.className = 'btn-home';
    btn.style.fontSize = '10px';
    btn.style.padding = '3px 8px';
    btn.textContent = '打开';
    btn.addEventListener('click', () => chrome.tabs.create({ url: c.url }));
    row.appendChild(btn);
    spClist.appendChild(row);
  }

  // Render Schedule Pill in SidePanel
  try {
    const s = await chrome.storage.sync.get(['scheduledCollect', 'scheduledCollectHour']);
    const pill = document.getElementById('spScheduleBadgePill');
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
  const box = document.getElementById('spSelfList');
  const head = document.getElementById('spSelfHead');
  if (!box) return;
  const r = await ask({ type: 'beacon-get-accounts' });
  const accounts = r?.ok && Array.isArray(r.accounts) ? r.accounts : [];
  if (accounts.length === 0) {
    box.innerHTML = `<div style="color:var(--text-3); font-size:12px; padding:8px; text-align:center">还没有创作账号——在自己的作品页点「这是我的作品」，插件会自动建一个</div>`;
    return;
  }
  const usable = accounts.filter((a) => selfCollectHint(a).ok).length;
  if (head) head.textContent = `我的账号 · ${usable}/${accounts.length} 可一键采集`;
  box.innerHTML = '';
  for (const a of accounts) {
    const hint = selfCollectHint(a);
    const row = document.createElement('div');
    row.className = 'citem';
    row.innerHTML =
      `<div>` +
      `<div style="font-size:12px; font-weight:600; color:var(--text)">${escHtml(a.name)}</div>` +
      `<div style="font-size:11px; color:var(--text-2); margin-top:2px">` +
      `<span class="dot ${hint.ok ? 'fresh' : 'stale'}"></span>` +
      `${escHtml(SP_PLATFORM_NAME[a.platform] || a.platform)} · ${escHtml(hint.text)}</div>` +
      `</div>`;
    box.appendChild(row);
  }
}
loadSelfList();

document.getElementById('spBatchSelf')?.addEventListener('click', () => {
  const msg = document.getElementById('spSelfMsg');
  if (msg) msg.textContent = '正在后台逐个打开并采集…';
  chrome.runtime.sendMessage({ type: 'batch-collect-self' });
});

// ⚠️ 两组进度消息要分别接，各写各的状态位。
//
// 此前只接了 `batch-self-*`（我的账号那半边），而竞对的「一键全部采集」发的是
// `batch-progress` / `batch-done`——sw.js 的 reportBatch 一直在 broadcast，只是这里没人听。
// 于是 `spBatchMsg` 这个状态位**从未被引用过**：用户点完按钮没有任何反馈，
// 会以为没触发而反复点，实际后台已经在逐个开标签页了。
//
// 另外原来第一行是 `const msg = getElementById('spSelfMsg'); if (!msg) return;`——
// 拿自有那半边的元素当整个监听器的前置条件，接竞对分支时必须先拆掉这个耦合。
chrome.runtime.onMessage?.addListener((m) => {
  const selfMsg = document.getElementById('spSelfMsg');
  const batchMsg = document.getElementById('spBatchMsg');

  if (m?.type === 'batch-self-progress' && selfMsg) {
    selfMsg.textContent = m.busy
      ? '已有一批采集在跑，等它结束再点'
      : `采集中 ${m.done}/${m.total}${m.current ? ` · ${m.current}` : ''}`;
  } else if (m?.type === 'batch-self-done' && selfMsg) {
    selfMsg.textContent = `✓ ${m.total} 个账号采集完成，回填 ${m.posts} 条作品`
      + (m.wechat ? '；公众号后台正在后台回填，完成后有系统通知' : '');
    loadSelfList();
    loadAccounts(true);
  } else if (m?.type === 'batch-progress' && batchMsg) {
    batchMsg.textContent = m.busy
      ? '已有一批采集在跑，等它结束再点'
      : `采集中 ${m.done}/${m.total}${m.current ? ` · ${m.current}` : ''}`;
  } else if (m?.type === 'batch-done' && batchMsg) {
    // notes 是被节流/上限拦下的原因（公众号那条通道会带）。静默丢掉的话，
    // 用户看到「10 个里成功 6 个」却不知道另外 4 个为什么没采。
    batchMsg.textContent = `✓ ${m.total} 个竞对，成功采集 ${m.collected} 个`
      + (m.notes?.length ? `；${m.notes.join('；')}` : '');
    // batchCollect 结束前已经 getCompetitors(true) 刷过 sw 侧缓存，这里读缓存即是新数据
    loadCompetitors();
  }
});

document.getElementById('spBatch')?.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'batch-collect' });
});

function spSay(text, color) {
  const out = document.getElementById('spResult');
  out.style.display = 'block';
  out.textContent = text;
  out.style.color = color;
}

// 采集前的公共部分：拿当前标签页 + 让内容脚本解析一次。
// 返回 null 表示已经把失败原因写给用户了，调用方直接收工。
async function spCollectFromActiveTab(tabId) {
  const res = await chrome.tabs.sendMessage(tabId, { type: 'beacon-collect', deep: true }).catch(() => ({}));
  if (!res?.ok) {
    spSay('💡 ' + (res?.error || '未能连上页面采集脚本，请刷新目标页面后重试'), 'var(--red)');
    return null;
  }
  return res.payload;
}

// ── 单页加为竞对并采集（竞对通道） ──
document.getElementById('spCollect')?.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const url = tab.url || '';

  if (url.includes('localhost') || url.includes('beacon.iyunci.cn') || url.includes('127.0.0.1')) {
    spSay('💡 当前在「烽火台控制台」。请在 B站/抖音/小红书/YouTube/X/TikTok 竞对主页或作品页上点击采集。', 'var(--accent)');
    return;
  }

  // 🔒 创作者后台绝不能走竞对通道。这不是「采得不准」——那是**你自己的**后台数据，
  // 走竞对通道会写进工作区共享的竞对库，还会把 handle='self' 加成一个竞对。
  // 内容脚本此时照样会返回 payload（common.js 的 __beaconSelfOnly 分支），所以必须在这里挡。
  if (SELF_ONLY_BACKEND.test(url)) {
    spSay('💡 这是你自己的创作者后台。请点上面那个蓝色的「这是我的作品 · 回填数据看板」——后台数据走的是另一条通道，不进竞对库。', 'var(--accent)');
    return;
  }
  if (!isCompetitorPage(url)) {
    // 认不出平台时兜底解析会默认 platform='bilibili' 并按路径瞎凑 handle，
    // 在竞对库里建出一个根本不存在的账号。
    spSay('💡 这个站点不在竞对采集范围内（B站/抖音/小红书/YouTube/X/TikTok）。', 'var(--accent)');
    return;
  }

  const payload = await spCollectFromActiveTab(tab.id);
  if (!payload) return;

  const ingestR = await ask({ type: 'beacon-ingest', payload: { ...payload, autoSubscribe: true } });
  if (ingestR?.ok) {
    if (ingestR.newlySubscribed) {
      spSay(`✓ 已自动添加「${ingestR.competitor}」至竞对库，并回传 ${ingestR.posts} 条数据！`, 'var(--green)');
    } else {
      spSay(`✓ 已更新「${ingestR.competitor}」的 ${ingestR.posts} 条数据`, 'var(--green)');
    }
    loadCompetitors();
  } else {
    spSay('❌ ' + (ingestR?.error || '回传失败'), 'var(--red)');
  }
});

// ── 这是我的作品 · 回填数据看板（自有通道） ──
// 「工作区里还没有这个平台的账号」不需要用户操心：sw.js 的 ingestSelf 会用页面上的昵称
// 就地建号、绑定，再把这一趟的数据写进去——一次点击走完。
// 与 popup 的「📥 这是我的作品」是同一条通道、同一次读取，只是入口在侧边栏。
// 此前 SidePanel 上**根本没有这个按钮**：用户从悬浮胶囊点开的是 SidePanel（Chrome 116+
// chrome.sidePanel.open 成功时页内抽屉不会展开），于是自有数据回填在这个入口上完全够不着。
document.getElementById('spCollectSelf')?.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const url = tab.url || '';

  if (!isSelfPage(url)) {
    spSay('💡 请在你自己的作品页（B站/抖音/小红书/X/YouTube/TikTok），或创作者后台的「数据中心 · 作品数据」页使用。', 'var(--accent)');
    return;
  }

  const payload = await spCollectFromActiveTab(tab.id);
  if (!payload) {
    // 后台页解析失败的原因多半是「站错了页」或「还没渲染完」。自检能说清断在哪一步，
    // 比让用户对着「回填 0 条」干瞪眼强得多（与 popup 的做法一致）。
    if (SELF_ONLY_BACKEND.test(url)) {
      try {
        const d = await chrome.tabs.sendMessage(tab.id, { type: 'beacon-diagnose' });
        const hint = d?.ok ? d.hint : d?.reason;
        if (hint) spSay('💡 ' + String(hint).split('\n').slice(0, 2).join(' '), 'var(--red)');
      } catch { /* 自检失败不影响主提示 */ }
    }
    return;
  }

  if (!confirmSelfProfile(payload, url, (t) => spSay(t, 'var(--accent)'))) return;

  const r = await ask({ type: 'beacon-ingest-self', payload });
  if (!r?.ok) {
    spSay('❌ ' + (r?.error || '回填失败'), 'var(--red)');
    return;
  }
  // 没有账号时 sw.js 已经就地建号并写入了，下拉框要跟着刷新，否则显示的还是「按平台自动匹配」
  if (r.createdAccount) await loadAccounts(true);
  // summary/summaryOk 由 sw.js 统一措辞。请求成功但一条都没入库 → 按失败报，别给假的勾。
  if (r.summaryOk) {
    spSay(r.summary, 'var(--green)');
    return;
  }
  // 自检只有创作者后台实现（self-backend.js）。在 X / 公开作品页上问它，只会拿回一句
  // 「当前页面不是受支持的创作者后台」——那是噪音，会把用户从真正的原因上带偏。
  let hint = '';
  if (SELF_ONLY_BACKEND.test(url)) {
    try {
      const d = await chrome.tabs.sendMessage(tab.id, { type: 'beacon-diagnose' });
      const h = d?.ok ? d.hint : d?.reason;
      if (h) hint = ' ｜ 自检：' + String(h).split('\n').slice(0, 2).join(' ');
    } catch { /* 自检失败不影响主提示 */ }
  }
  spSay('⚠️ ' + r.summary + hint, 'var(--red)');
});

// ── 回填到哪个账号 ──
// 不绑定就由后端按平台猜（lib/ingest/own-post.ts resolveTargetAccount）。一个工作区经营
// 两个同平台账号时猜必然错一半，而挂错账号在数据看板上是彻底看不见 + 污染另一个号的基线。
// 绑定关系存 chrome.storage.sync，popup / SidePanel / 页内侧栏 / 设置页共用同一个值。
const SP_PLATFORM_NAME = { ...PLATFORM_NAME, multi: '多平台' };
async function loadAccounts(force = false) {
  const sel = document.getElementById('spAccountSel');
  if (!sel) return;
  const r = await ask({ type: 'beacon-get-accounts', force });
  if (!r?.ok || !Array.isArray(r.accounts) || r.accounts.length === 0) return;
  // 重建而不是追加：建完号会再调一次，追加的话同一个账号会在下拉框里出现两遍。
  //「（按平台自动匹配）」那一项是模板的一部分，保留。
  sel.length = 1;
  for (const a of r.accounts) {
    const opt = document.createElement('option');
    opt.value = a.id;
    // textContent 而不是 innerHTML：账号名是用户自己填的，可能带 < >
    opt.textContent = `${SP_PLATFORM_NAME[a.platform] || a.platform} · ${a.name}${a.status !== 'active' ? '（已停用）' : ''}`;
    sel.appendChild(opt);
  }
  if (r.selfAccountId) sel.value = r.selfAccountId;
}
document.getElementById('spAccountSel')?.addEventListener('change', async (e) => {
  const v = e.target.value;
  await ask({ type: 'beacon-set-account', accountId: v });
  spSay(v ? '✓ 已绑定，之后的回填都记到这个账号名下' : '✓ 已改回「按平台自动匹配」', 'var(--green)');
});
loadAccounts();

// ── 收进灵感箱（第三条通道，任何网页上都可用）──
// 与上面两个按钮的关键区别：它不认平台、不写竞对库、也不写发布记录，
// 只往自己工作区的收集箱加一行（标题 + 链接 + 备注，不存正文——存正文是搬运，见 lib/ingest/inspiration.ts）。
// 所以它没有「当前页是否受支持」的前置判断，只挡烽火台自己的页面。
document.getElementById('spInspire')?.addEventListener('click', async () => {
  const btn = document.getElementById('spInspire');
  const noteEl = document.getElementById('spInspireNote');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || '';
  if (!url) { spSay('💡 读不到当前标签页地址', 'var(--accent)'); return; }
  if (url.includes('localhost') || url.includes('beacon.iyunci.cn') || url.includes('127.0.0.1')) {
    spSay('💡 这是烽火台自己的页面，换个内容页再收藏', 'var(--accent)');
    return;
  }
  btn.disabled = true;
  spSay('保存中…', 'var(--text-2)');

  // 标题/作者/平台尽量从内容脚本要一次；要不到（普通网页没有站点解析器）就退回标签页标题。
  // 平台只在**认识**时才带：后端对未知平台整条打回，而「在不认识的站点上刷到好东西」
  // 恰恰是收集箱最该支持的场景。
  const ctx = await getActiveTabContext();
  const KNOWN = ['bilibili', 'douyin', 'xiaohongshu', 'youtube', 'x', 'wechat', 'shipinhao', 'tiktok'];
  const r = await ask({
    type: 'beacon-save-inspiration',
    payload: {
      title: ctx.title || tab?.title || '',
      note: (noteEl?.value || '').trim(),
      url, // token 一类等同于登录态的参数由 sw.js 的 inspireSafeUrl 统一抹掉
      platform: KNOWN.includes(ctx.platform) ? ctx.platform : undefined,
      author: ctx.author || undefined,
      source: 'plugin',
    },
  });
  if (r?.ok) {
    if (noteEl) noteEl.value = '';
    spSay(r.duplicate ? '✓ 这条已经在收集箱里了，备注已更新' : `✓ 已收进灵感箱（待用 ${r.total} 条）`, 'var(--green)');
  } else {
    spSay('❌ ' + (r?.error || '保存失败，请稍后重试'), 'var(--red)');
  }
  btn.disabled = false;
});

// ── 读评论提问 ──
document.getElementById('spCollectComments')?.addEventListener('click', async () => {
  const ccBtn = document.getElementById('spCollectComments');
  // 没开就直送设置页（与竖条、popup 同一套口径）——让后台回一句「未开启」帮不到用户。
  if (ccBtn.dataset.locked === '1') {
    spSay('评论提问采集默认关闭，正在打开设置页…', 'var(--text-2)');
    try { chrome.runtime.openOptionsPage(); } catch { /* 打不开就只剩这句提示 */ }
    return;
  }
  ccBtn.disabled = true;
  spSay('正在读取评论区提问…', 'var(--text-2)');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) { spSay('无法获取当前标签页', 'var(--red)'); ccBtn.disabled = false; return; }
  const r = await ask({ type: 'beacon-collect-comments', tabId: tab.id });
  if (r?.ok) {
    const n = (r.created || 0) + (r.updated || 0);
    const c = r.comments || 0;
    spSay(`✓ 读了 ${r.read ?? '?'} 条评论：${n} 条提问${r.created ? `（${r.created} 条新增）` : ''}、${c} 条读者原声`, 'var(--green)');
  } else {
    spSay('❌ ' + (r?.error || '评论采集失败'), 'var(--red)');
  }
  ccBtn.disabled = false;
});

// ── 补齐前 20 条作品详情 ──
//
// 主页给不了的字段（抖音的评论/收藏/转发、B站 的评论数）只有作品详情页才有。
// 这颗按钮把前 20 条作品的详情页逐个打开、解析、回传。
//
// 只在**支持的竞对平台主页**上露出：详情页没有额外字段的平台点了也是白跑一趟。
// ⚠️ 判据必须认到**路径**，不能只认域名。
//
// 此前三条写的是 `path: '/'`，而判定是 `url.includes(p.host) && url.includes(p.path)`
// ——任何 URL 都包含 '/'，等于「域名匹配即显示」。于是这颗按钮在 youtube.com/watch、
// x.com/home、bilibili.com/video/BVxxx 上都会露出，点了只会拿到「这一页没读到作品列表」。
// 它自己的注释和隐私政策都写的是「只在支持的竞对平台**主页**上露出」。
//
// 改成整条 URL 的正则：主页/空间页才算数，作品页与功能页一律不露。
//
// ⚠️ **直接复用本文件上方已有的那五条**，不再抄一份。抄一份的下场这一轮已经见过太多次：
// 两处各自维护、真机校准只改一处、然后静默不一致。这几条正是 AMBIGUOUS_PROFILE 用的同一批
//（「我的主页」与「竞对主页」是同一种页面的那几个平台），语义上也正好就是「主页」。
const DETAIL_HOME_PAGES = [
  DY_SELF_PROFILE,
  BILI_SELF_SPACE,
  XHS_SELF_PROFILE,
  YT_SELF_CHANNEL,
  X_SELF_PAGE,
];
(async () => {
  try {
    const btn = document.getElementById('spCollectDetails');
    if (!btn) return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url || '';
    const fit = DETAIL_HOME_PAGES.some((re) => re.test(url));
    if (!fit) return;
    btn.style.display = '';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const label = btn.querySelector('span');
      const original = label ? label.textContent : '';
      spSay('正在逐条打开作品详情页补齐数据…（一次最多 20 条，中间会有间隔，别关标签页）', 'var(--text-2)');
      try {
        const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
        const r = await ask({ type: 'beacon-collect-details', tabId: t?.id });
        if (r?.ok) {
          // 被截断的条数必须说出来 —— 悄悄少采会让用户以为「全补齐了」
          const more = r.skipped > 0 ? `；还有 ${r.skipped} 条这轮没采（每次最多 20 条），可以再点一次` : '';
          spSay(`✓ 补齐 ${r.done}/${r.total} 条${r.failed ? `（${r.failed} 条没读到）` : ''}${more}`, 'var(--green)');
        } else {
          spSay('❌ ' + (r?.error || '补齐失败'), 'var(--red)');
        }
      } finally {
        btn.disabled = false;
        if (label) label.textContent = original;
      }
    });
  } catch { /* 判定失败就保持隐藏，不影响侧栏其它功能 */ }
})();

// 评论按钮**始终显示**，没开开关时显示成「未开启」并直通设置页。
// 藏起来等于这个功能不存在——用户真机上就是因为找不到才来问「有没有一键采集评论的按钮」。
// ⚠️ 顶层语句抛异常会**整份脚本停在这里**——后面的 loadCompetitors()、页面自检、
//    「这是我的作品」按钮全都不再绑定，表现是「侧栏一片死」而不是「少了一个按钮」。
//    一个可选的显隐开关不配有这种权力，所以整块包起来：读不到就按「未开启」渲染。
try {
  const ccBtn0 = document.getElementById('spCollectComments');
  if (ccBtn0) { ccBtn0.style.display = ''; ccBtn0.dataset.locked = '1'; }
  chrome.storage?.sync?.get(['commentCollectOwn', 'commentCollectRival'])?.then?.((s) => {
    const ccBtn = document.getElementById('spCollectComments');
    if (!ccBtn) return;
    const on = s?.commentCollectOwn === true || s?.commentCollectRival === true;
    ccBtn.dataset.locked = on ? '' : '1';
    ccBtn.title = on ? '' : '出于合规考虑默认关闭，点击去设置里打开';
    ccBtn.style.opacity = on ? '' : '0.68';
    const span = ccBtn.querySelector('span');
    if (span && !on) span.textContent = '读评论提问（未开启）';
  });
} catch { /* 拿不到设置就按「未开启」渲染，按钮照样在 */ }

loadCompetitors();

// ── 看看这一页采到了什么 ──
// 「回填成功」不等于「采对了」：条数对不上、标题抓成状态文案、数字串到别篇上，
// 这三种故障在「✓ 已回填 N 条」里长得一模一样。把采出来的东西原样列出来才看得见。
document.getElementById('spDiagnoseSelf')?.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  spSay('自检中…', 'var(--text-2)');
  try {
    const d = await chrome.tabs.sendMessage(tab.id, { type: 'beacon-diagnose' });
    const text = d?.ok ? d.hint : (d?.reason ?? '自检没有返回结果');
    spSay(text, d?.ok ? 'var(--text)' : 'var(--accent)');
  } catch {
    spSay('未能连上页面采集脚本，请刷新目标页面后重试', 'var(--red)');
  }
});

// ── 动态识别当前标签页信息 ──
async function updateCurrentTabInfo() {
  const badge = document.getElementById('spPageBadge');
  const titleEl = document.getElementById('spPageTitle');
  if (!badge || !titleEl) return;
  // 「这是我的作品」按钮只在当前标签页确实是自有作品页/创作者后台时才露出来。
  // 必须在 getActiveTabContext() **之前**做：那个函数会向内容脚本要一次完整解析，
  // 后台页上要等表格渲染，慢的时候好几秒——按钮不该等它。
  try {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    const self = isSelfPage(t?.url || '');
    const selfBtn = document.getElementById('spCollectSelf');
    if (selfBtn) selfBtn.style.display = self ? '' : 'none';
    // 🔍 自检只有创作者后台（self-backend.js）实现，公开作品页上点它永远只回一句
    // 「当前页面不是受支持的创作者后台」——那种按钮不该露出来。
    const dg = document.getElementById('spDiagnoseSelf');
    if (dg) dg.style.display = SELF_ONLY_BACKEND.test(t?.url || '') ? '' : 'none';
    // 账号绑定只在能回填的页面上露出来（别的页面上它是个没有意义的下拉框）
    const row = document.getElementById('spAccountRow');
    if (row) row.style.display = self ? 'flex' : 'none';
  } catch { /* 取不到标签页就维持现状，不要把按钮弄没了 */ }
  try {
    const ctx = await getActiveTabContext();
    if (ctx.url && (ctx.url.includes('localhost') || ctx.url.includes('beacon.iyunci.cn') || ctx.url.includes('127.0.0.1'))) {
      badge.textContent = '烽火台控制台';
      titleEl.textContent = ctx.title || '烽火台 AI 作战室控制台';
    } else if (ctx.title) {
      badge.textContent = ctx.platform ? (PLATFORM_NAME[ctx.platform] || ctx.platform) : '社交网页';
      titleEl.textContent = (ctx.author ? `【${ctx.author}】` : '') + ctx.title;
    } else {
      badge.textContent = '当前网页';
      titleEl.textContent = '未识别到特定社交对象';
    }
  } catch {
    badge.textContent = '检测中';
  }
}

try {
  chrome.tabs.onActivated?.addListener(updateCurrentTabInfo);
  chrome.tabs.onUpdated?.addListener((_id, changeInfo) => {
    if (changeInfo.status === 'complete') updateCurrentTabInfo();
  });
} catch { /* ignore */ }

updateCurrentTabInfo();
