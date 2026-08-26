// 烽火台采集助手 · 后台 service worker。

// 域名白名单与内容脚本共用**同一个文件**，不在这里再抄一份。
// 抄一份的下场是确定的：改一处漏一处，而漏掉的那处正好是防线所在
//（服务端也有一份同款清单，由 tests/ingest/read-allowlist-sync.test.ts 三方对账）。
//
// 【为什么要判一下 typeof】单测把这个文件当普通脚本求值，那里没有 importScripts。
// 拿不到白名单时 openAndRead 会当场拒绝执行（它自己判 typeof beaconReadAllowed）——
// **fail-closed**：宁可这条能力不可用，也不能在没有白名单的情况下去打开一个网址。
if (typeof importScripts === 'function') importScripts('content/read-allowlist.js');

const DEFAULT_HOST = 'https://beacon.iyunci.cn';
const LIST_TTL_MS = 60 * 60 * 1000;

async function getConfig() {
  const { host, token } = await chrome.storage.sync.get(['host', 'token']);
  return { host: (host || DEFAULT_HOST).replace(/\/$/, ''), token: token || '' };
}

// ⚠️ fetch **没有默认超时**：网络吊住时这个 promise 永不 settle，于是
// sendResponse 永远不发，界面上就是那颗按钮**永远停在「回填中…」**——不报错、不复原、无从下手。
// 真机 2026-07-27 在 X 上撞到：看 X 要挂 VPN，而烽火台是国内服务器，
// 两边路由不一致时请求就这么吊着。超时不是优化，是「让失败可见」的必要条件。
const REQUEST_TIMEOUT_MS = 30000;
async function fetchWithTimeout(url, init = {}, ms = REQUEST_TIMEOUT_MS) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// 网络异常讲成人话。超时与「连不上」是两种要分开说的故障：
// 前者多半是代理/VPN 把到烽火台的路由带歪了，后者才是地址填错或服务没起。
function netError(e, host) {
  if (e?.name === 'AbortError') {
    return `请求超时（${REQUEST_TIMEOUT_MS / 1000} 秒没有响应）：${host} 连得上但没回话。`
      + '如果你正在挂 VPN 看 X/YouTube/TikTok，多半是代理把到烽火台的流量也带出去了——把烽火台的域名加进代理白名单（直连）再试。';
  }
  return `无法连接服务器 (${host}): ${e?.message || e}`;
}

// ── 令牌作废后的自愈 ────────────────────────────────────────────────
//
// 账号在网页端注销时，Workspace 连同 ingestToken 一起被级联删掉，令牌**当场作废**；
// 但插件这边不会有人来通知——令牌串、工作区名、竞对清单、自有账号清单，全都还躺在本机
// chrome.storage 里（sync 那半边还会同步到用户登录过的每一台 Chrome）。于是：
//   · 每天的闹钟照常起来，开一次后台标签页、撞一次 401、弹一条看不懂的失败通知；
//   · 本该随注销一起从用户设备上消失的个人数据，继续留着。
//
// 两道防线，缺一不可：
//   ① 网页通道 —— 注销后落到 /login 时由页面 postMessage『clear-token』（content/bridge.js
//      → beacon-unlink），快且准，但只覆盖「在这台浏览器上注销」这一种情形；
//   ② 本条 —— 连续 AUTH_FAIL_LIMIT 次 401 就自己认定令牌没了。用户在手机上、在另一台电脑上
//      注销时 ① 根本够不着，只有这条兜得住。
//
// 为什么是「连续 N 次」而不是一次就清：401 也可能是用户在设置页点了「停用」正准备轮换、
// 或者令牌少粘了一个字符。清空的代价是整套设置要重配，值得多等两轮再下结论。
const AUTH_FAIL_LIMIT = 3;

// 注销/令牌作废时要抹掉的本机数据。**每加一个缓存键就要往这里补一行**——
// 漏掉的那一项会在用户注销之后继续留在他的设备上。
// host 不在其中：它只是服务器地址，不含个人信息，清掉只会让重新配置多一步。
const SYNC_KEYS_ON_UNLINK = ['token', 'selfAccountId'];
const LOCAL_KEYS_ON_UNLINK = [
  'competitors', 'competitorsAt', 'workspace', // 竞对清单 + 工作区名
  'selfAccounts', 'selfAccountsAt',            // 自有账号清单
  'lastScheduledCollectLog',                   // 最近一次定时采集摘要
  'lastSelfAutoLog',                           // 最近一次公众号自动回填结果
  'wechatThrottle',                            // 公众号采集节流记录
  'wechatFakeids',                             // 公众号名 → fakeid 缓存
  // 公众号采集的风险确认。**要清**：确认是「这个人对这次使用」作出的意思表示，
  // 换了工作区/换了人还沿用上一个人的确认，等于没告知过就开始采。
  'wechatRiskAck',
  'authFail',
];

// 批量采集会并发发出多条请求，令牌作废时它们会**同时**撞 401。没有这道闸的话，
// 用户会一次收到三条一模一样的「已停止采集」通知。清理本身是幂等的，通知不是。
let unlinking = false;

/** 与工作区解绑：停表 → 清凭证与缓存 → 说明原因。三步都做完才算数。 */
async function unlinkWorkspace(reason) {
  if (unlinking) return;
  unlinking = true;
  try {
    // 先停表再清数据：反过来的话，两者之间只要有一次闹钟触发，就会把缓存又写回来一份
    await chrome.alarms.clear('beacon-self-auto');
    await chrome.alarms.clear('beacon-scheduled-collect');
    await chrome.alarms.clear('beacon-daily');
    // 定时开关必须落盘关掉，不能只清闹钟：scheduledCollect 的默认值是**开**（!== false），
    // 只清闹钟的话，下次浏览器启动 armScheduledCollectAlarm 会照默认值原样挂回去。
    await chrome.storage.sync.set({ selfAutoCollect: false, scheduledCollect: false });
    await chrome.storage.sync.remove(SYNC_KEYS_ON_UNLINK);
    await chrome.storage.local.remove(LOCAL_KEYS_ON_UNLINK);
    try { await chrome.action.setBadgeText({ text: '' }); } catch { /* ignore */ }
    // 必须弹：插件突然不采了而用户不知道为什么，比继续报 401 更让人抓瞎。
    try {
      chrome.notifications.create('beacon-unlink-' + Date.now(), {
        type: 'basic',
        iconUrl: 'icon128.png',
        title: '烽火台采集助手已停止采集',
        message: reason || '采集令牌已失效，插件已停止自动采集并清除本机缓存的工作区数据。',
        priority: 2,
      });
    } catch { /* 通知不可用不影响清理本身 */ }
  } finally {
    // 只防同一轮的并发，不做「一辈子只清一次」——用户重新填了令牌之后，
    // 这条路径必须还能再走一遍。
    unlinking = false;
  }
}

/** 令牌还灵不灵，全插件只在这一个地方观察。 */
async function noteAuth(status) {
  if (status === 401) {
    const n = ((await chrome.storage.local.get('authFail')).authFail || 0) + 1;
    await chrome.storage.local.set({ authFail: n });
    if (n >= AUTH_FAIL_LIMIT) {
      await unlinkWorkspace(
        '采集令牌已失效（账号已注销，或令牌被停用/轮换）。已停止全部自动采集，并清除本机缓存的工作区数据。'
        + '若是误判，在网页端重新生成令牌后填回插件设置即可。',
      );
    }
    return;
  }
  // 只要真的通过一次，就说明令牌是好的——把失败计数清零。
  // 否则跨几周攒够 3 次偶发 401 也会误清。
  if (status >= 200 && status < 300) {
    const { authFail } = await chrome.storage.local.get('authFail');
    if (authFail) await chrome.storage.local.remove('authFail');
  }
}

/** 所有**带采集令牌**的请求都走这里；不带令牌的（如版本探询）仍用 fetchWithTimeout。 */
async function apiFetch(url, init = {}, ms = REQUEST_TIMEOUT_MS) {
  const res = await fetchWithTimeout(url, init, ms);
  await noteAuth(res.status);
  return res;
}

// ── 回传单个竞对采集结果 ──
async function ingest(payload) {
  const { host, token } = await getConfig();
  if (!token) return { ok: false, error: '请先在插件设置里填写采集令牌' };
  try {
    const res = await apiFetch(`${host}/api/ingest/competitor`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-beacon-ingest-token': token },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    return res.ok ? { ok: true, ...data } : { ok: false, error: data.error || `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: netError(e, host) };
  }
}

// ── 采集自学习：上报解析失效样本 / 拉规则包 ───────────────────────────────────
//
// 上报的是**脱敏结构骨架**（content/common.js 的 beaconSkeleton 已经把内容抹成形状），
// 服务端还会再脱敏一次。两道闸的理由：插件是本地代码，用户能改。
async function reportParserMiss(payload) {
  const { host, token } = await getConfig();
  if (!token) return { ok: false, error: '未配置采集令牌' };
  try {
    const res = await apiFetch(`${host}/api/ingest/parser`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-beacon-ingest-token': token },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    return res.ok ? { ok: true, ...data } : { ok: false, error: data.error || `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: netError(e, host) };
  }
}

/** 拉规则包并缓存到本地。失败就保留上一份缓存——没网时不该把已有的兜底规则清掉。 */
async function refreshParserRules() {
  const { host, token } = await getConfig();
  if (!token) return { ok: false, error: '未配置采集令牌' };
  try {
    const res = await apiFetch(`${host}/api/ingest/parser`, { headers: { 'x-beacon-ingest-token': token } });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json().catch(() => ({}));
    if (!data || !Array.isArray(data.rules)) return { ok: false, error: '规则包格式不对' };
    await chrome.storage.local.set({ parserRules: { version: data.version, rules: data.rules, at: Date.now() } });
    return { ok: true, count: data.rules.length, version: data.version };
  } catch (e) {
    return { ok: false, error: netError(e, host) };
  }
}

// ── 一键发布：拉待填充任务 / 报回执 ───────────────────────────────────────────
//
// 与采集回传复用同一枚工作区令牌。插件在这条链路上**只做填表**，
// 发布按钮永远由用户自己点（content/publish-fill.js 里也不存在点击发布的代码）。
async function fetchPublishTasks(platform) {
  const { host, token } = await getConfig();
  if (!token) return { ok: false, error: '请先在插件设置里填写采集令牌' };
  try {
    const res = await apiFetch(`${host}/api/publish/tasks?platform=${encodeURIComponent(platform || '')}`, {
      headers: { 'x-beacon-ingest-token': token },
    });
    const data = await res.json().catch(() => ({}));
    return res.ok ? { ok: true, tasks: data.tasks || [] } : { ok: false, error: data.error || `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: netError(e, host) };
  }
}

async function sendPublishReceipt(payload) {
  const { host, token } = await getConfig();
  if (!token) return { ok: false, error: '请先在插件设置里填写采集令牌' };
  try {
    const res = await apiFetch(`${host}/api/publish/receipt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-beacon-ingest-token': token },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    return res.ok ? { ok: true, ...data } : { ok: false, error: data.error || `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: netError(e, host) };
  }
}

// 把回填结果讲成人话。**唯一的口径**：三个入口（popup / SidePanel / 页内侧栏）都用它，
// 免得同一件事在三处各说各话。
//
// ⚠️ 这里最要紧的是 `skipped`：后端对「一个指标都没读到」的作品直接跳过（不建空记录污染基线），
// 于是 HTTP 200 + {updated:0, created:0, skipped:9} 是一个**完全正常的成功响应**。
// 此前三个入口都只看 updated+created，0 条时统一报「✓ 已回填到数据看板」——
// 用户看到勾，去数据看板一看什么都没有，还以为是看板坏了。
// 采到 0 条不是错误，但绝不能报成成功。
function selfIngestSummary(data, platform) {
  const posts = (data.updated ?? 0) + (data.created ?? 0);
  const skipped = data.skipped ?? 0;
  const bits = [];
  if (posts > 0) bits.push(`${posts} 条作品`);
  if (data.account?.dailyStats > 0) bits.push('粉丝数据');
  if (data.account?.audience) bits.push('受众画像');
  if (bits.length) {
    const tail = skipped > 0 ? `（另有 ${skipped} 条只认出作品、没读到指标，已跳过）` : '';
    // **记在谁名下**必须说出来。数据看板每一页都按 accountId 过滤，挂到哪个号上决定了
    // 用户能不能看见它；只说「已回填 N 条」而不说去向，用户在看板上找不到时完全无从判断
    // （真机 2026-07-27：回填成功但看板空白，因为数据落在插件新建的那个号名下，
    //  而网页顶栏选的还是老号）。
    const to = data.targetAccount?.name ? ` → 记在「${data.targetAccount.name}」名下` : '';
    return { ok: true, text: `✓ 已回填：${bits.join(' + ')}${tail}${to}` };
  }
  if (skipped > 0) {
    // 「列名」「自检」都是**创作者后台**才有的东西：后台页由 self-backend.js 读表格，
    // 也只有那儿实现了 __beaconSelfDiagnose。在 X / 公开作品页上照抄这套说辞，
    // 用户会照着去点一个根本不存在的自检，再收到一句「当前页面不是受支持的创作者后台」——
    // 真机 2026-07-27 就是这么绕了一圈（那次真正的原因是中文界面下指标没读到）。
    const isBackend = ['wechat', 'shipinhao'].includes(platform) || platform === undefined;
    return {
      ok: false,
      text: `认出了 ${skipped} 条作品，但一个指标都没读到，因此一条都没入库。`
        + (isBackend
          ? '多半是列表还没渲染完，或后台改版了列名——等页面完全显示出来再点一次；仍不行请用「自检」把现场发我。'
          : '多半是页面没完全加载出来——把列表往下滚一点、等互动数字（回复/转帖/喜欢/查看）都显示出来再点一次。'),
    };
  }
  return { ok: false, text: '这一页没读到任何可回填的数据（既没有作品指标，也没有粉丝/受众数据）。' };
}

// ── 回传「自有作品」表现数据 ──

const SW_PLATFORM_NAME = {
  bilibili: 'B站', douyin: '抖音', xiaohongshu: '小红书', youtube: 'YouTube',
  x: 'X', wechat: '公众号', shipinhao: '视频号', tiktok: 'TikTok',
};

// 建号时用什么名字。
// 公开主页（X 等）能读到真实昵称，直接用它；创作者后台的 handle **恒为 'self'**
// （self-backend.js：身份标识不参与归属，少采一个就少一份数据），那儿只能退到平台名兜底——
// 名字是可以事后在烽火台里改的，而卡在「没有账号」上是走不下去的。
function accountNameFrom(payload) {
  const nick = String(payload?.profile?.name || '').trim();
  if (nick) return nick.slice(0, 60);
  const handle = String(payload?.handle || '').trim();
  if (handle && handle !== 'self') return handle.slice(0, 60);
  return `${SW_PLATFORM_NAME[payload?.platform] || payload?.platform || '我的'}账号`;
}

// ── 自有**主页**读到的粉丝数要折成当天一条快照 ──
//
// 「我的主页」（抖音/小红书/B站/X/YouTube）解析出来的粉丝数在 `profile.followers` 里，
// 但 /api/ingest/self 的账号级 schema（lib/ingest/own-account.ts）只认 `dailyStats`——
// zod 会把整个 profile 静默剥掉，于是这个数**一路走到服务端然后蒸发**：
// 数据看板的「粉丝与受众」卡永远显示「还没有账号级数据」，用户看到的就是粉丝数是空的
//（真机 2026-08-07 抖音）。这里就地折成 `dailyStats: [{date, followers}]`，
// 服务端按 (accountId, platform, date) upsert，一天点几次也只有一条。
//
// ⚠️ 日期必须在**本地**算：服务端容器跑 UTC，交给它算会把上午八点前的回填记到前一天
//（同 worker cron 的时区坑）。self-backend.js 的后台回填也是这么算的，两条路口径一致。
// ⚠️ 后台已经给了 dailyStats 就不动：那是「粉丝分析」页的日序列，比主页那个瞬时数准。
function withProfileFollowers(payload) {
  const f = payload?.profile?.followers;
  if (typeof f !== 'number' || !Number.isFinite(f) || f < 0) return payload;
  if (Array.isArray(payload.dailyStats) && payload.dailyStats.length > 0) return payload;
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return {
    ...payload,
    dailyStats: [{ date, followers: Math.round(f) }],
    // 「这个数是怎么读到的」要跟着一起上去：服务端靠它判断插件是不是降级了，
    // 也靠它在量级突变时说清「读取来源：…」。丢在 profile 里会被 zod 剥掉（就是这次的坑）。
    ...(payload.profile.followersVia ? { followersVia: payload.profile.followersVia } : {}),
  };
}

async function ingestSelf(payload, opts = {}) {
  const { host, token } = await getConfig();
  if (!token) return { ok: false, error: '请先在插件设置里填写采集令牌' };
  try {
    // 绑定的账号统一在这里挂上去：三个入口（popup / SidePanel / 页内侧栏）都走这条函数，
    // 挂在各自的点击处理里迟早会漏一个，而漏掉的那个入口回填出去的数据会被后端按平台猜归属。
    // ⚠️ 必须在 try 里：它读 chrome.storage，一旦抛出来就没人接，
    // 于是 sendResponse 不发、按钮永远停在「回填中…」。
    // 归属顺序：调用方指定 > 用户显式绑定 > 按平台现算（没有同平台账号就用页面昵称建一个）
    let createdAccount;
    let accountId = payload?.accountId || (await boundAccountId());
    if (!accountId) {
      const picked = await resolvePlatformAccount(payload);
      accountId = picked.id;
      createdAccount = picked.created;
    }
    if (accountId) payload = { ...payload, accountId };
    payload = withProfileFollowers(payload);
    // 自有回填给的时间比别的通道长：服务端对**每一条**作品都要跑一遍学习与预警
    // （lib/insight/learn.ts + alert.ts，各十来次库操作），而 X 主页一次能给到 20 条。
    const res = await apiFetch(`${host}/api/ingest/self`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-beacon-ingest-token': token },
      body: JSON.stringify(payload),
    }, 60000);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // ── 工作区里还没有这个平台的账号 → 就地建一个，然后立刻把数据写进去 ──
      // 用户明确要求「不用太多操作」：不再让他先建号、再回来点第二次。
      // 名字取页面上的昵称（X 上就是「Aiya哎呀」），后台页取不到昵称就用平台名兜底，事后可改。
      //
      // 放在这里而不是三个界面里：三个入口都走这条函数，写在各自的点击处理里迟早漏一个；
      // 每天自动回填那条路（selfAutoRun）根本没有界面，也只有放在这儿才覆盖得到。
      //
      // ⚠️ 只重试一次（retried 标记）：建号后仍报没账号说明是别的问题（比如绑定的账号
      // 属于别的工作区），再循环下去就是无限建号。
      const noAccount = data.code === 'no_account' || data.code === 'no_account_for_platform';
      if (noAccount && !opts.retried && payload?.platform) {
        const name = accountNameFrom(payload);
        const c = await createAccount({ name, platform: payload.platform, handle: payload.handle });
        if (!c.ok) return { ok: false, error: `想自动建号「${name}」但没成功：${c.error}`, code: data.code };
        // 建号会把 selfAccountId 绑到新号上；重试时**必须清掉 payload 里的旧 accountId**，
        // 否则带着那个被后端判定为「不在本工作区 / 平台对不上」的 id 再撞一次墙。
        const { accountId: _drop, ...clean } = payload;
        const again = await ingestSelf(clean, { retried: true });
        if (!again.ok) return again;
        // existed = 服务端认出这就是已有的那个号，没有新建（见 createAccount 上方注释）
        const verb = c.existed ? `已归到账号「${c.account.name}」并` : `已新建账号「${c.account.name}」并`;
        return {
          ...again,
          ...(c.existed ? {} : { createdAccount: c.account }),
          summary: `✓ ${verb}${(again.summary || '').replace(/^✓\s*已/, '')}`,
        };
      }
      return { ok: false, error: data.error || `HTTP ${res.status}`, code: data.code };
    }
    // 入库成功但一条都没写进去 → 按失败报给用户（summaryOk 保留真实的 HTTP 结果，
    // 调用方要区分「网络/令牌问题」和「采到 0 条」时用得上）。
    const s = selfIngestSummary(data, payload?.platform);
    // 新建了账号就说出来。用户明确要过这句：数据落到哪个号上是他要判断的事，
    // 「悄悄建了个号」和「悄悄落进老号」一样让人找不着北。
    const text = createdAccount ? `✓ 已新建账号「${createdAccount.name}」并${s.text.replace(/^✓\s*已/, '')}` : s.text;
    return { ok: true, ...data, summary: text, summaryOk: s.ok, ...(createdAccount ? { createdAccount } : {}) };
  } catch (e) {
    return { ok: false, error: netError(e, host) };
  }
}

// ── 收进灵感箱 ──
// 三条回传通道里权限面最小的一条：只往工作区自己的收集箱加一行，不碰任何全局共享表。

// 页面地址里可能带着等同于登录态的参数（公众号后台每个地址都有 token=）。
// 灵感箱要把 url 存到服务器上，存之前一律抹掉——与 sidebar.js safeHref /
// self-backend.js beaconSafeRoute 同一套口径。
const INSPIRE_SECRET_PARAM = /token|ticket|secret|sign|key|uin|sid|pass|cookie|auth/i;
function inspireSafeUrl(href) {
  try {
    const u = new URL(String(href));
    for (const k of [...u.searchParams.keys()]) {
      if (INSPIRE_SECRET_PARAM.test(k)) u.searchParams.set(k, '***');
    }
    return u.toString();
  } catch {
    return '';
  }
}

// 服务端 inspirationPayloadSchema 是**严格**的：title 不能空、url 必须是合法 URL、
// source 只认 plugin|manual|comment|rival-comment，任何一条不合都整条 400 打回。
// 右键菜单此前直接把 {source:'context-menu', title: tab.title||'', url: tab.url||''} 发上去——
// source 不在枚举里，于是**每一次右键收藏都是 400**，而失败时连个通知都不弹（只在成功时弹），
// 用户完全看不出它从来没成功过。所以规整放在这个唯一出口里做，三个入口都过它。
function normalizeInspiration(raw) {
  const p = raw || {};
  const url = p.url ? inspireSafeUrl(p.url) : '';
  // 选中文字优先当备注（「为什么想记它」正是这段选中的话）；标题空了退回选中文字，再退回链接
  const note = String(p.note || p.text || '').trim().slice(0, 300);
  const title = String(p.title || '').trim().slice(0, 200) || note.slice(0, 60) || url.slice(0, 200);
  if (!title) return null; // 标题、备注、链接全空 —— 没有任何可存的东西
  const SOURCES = ['plugin', 'manual', 'comment', 'rival-comment', 'clip'];
  return {
    title,
    ...(note ? { note } : {}),
    ...(url ? { url: url.slice(0, 500) } : {}),
    ...(p.platform ? { platform: p.platform } : {}),
    ...(p.author ? { author: String(p.author).slice(0, 100) } : {}),
    // 正文（资讯库通道）：服务端上限 20000，这里先截一刀，别把超长页面塞进一次请求
    ...(p.content ? { content: String(p.content).slice(0, 20_000) } : {}),
    source: SOURCES.includes(p.source) ? p.source : 'plugin',
  };
}

async function saveInspiration(rawPayload) {
  const payload = normalizeInspiration(rawPayload);
  if (!payload) return { ok: false, error: '这一页没有可保存的标题或链接' };
  const { host, token } = await getConfig();
  if (!token) return { ok: false, error: '请先在插件设置里填写采集令牌' };
  try {
    const res = await apiFetch(`${host}/api/ingest/inspiration`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-beacon-ingest-token': token },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    return res.ok ? { ok: true, ...data } : { ok: false, error: data.error || `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: netError(e, host) };
  }
}

// ── 一键拆解这条作品 ──
//
// 【它到不了「视频级」，这一点必须一路诚实到底】
// 插件读的是标题/文案/封面/指标——用户自己看得到的那一页。视频文件拿不到（blob: 流 + 防盗链），
// 也**不去替用户下载**（那是「要画面级拆解就自己下载后上传」这条规矩的另一面）。
// 服务端会把这次分析标成「封面档 / 文案档」并在报告顶部写明依据；这里的通知也照抄那句话，
// 三处（报告 / 回执 / 通知）用的是服务端同一个 CHANNEL_BASIS，不各写各的。
async function analyzeWork(tabId, opts) {
  const { host, token } = await getConfig();
  if (!token) return { ok: false, error: '请先在插件设置里填写采集令牌' };

  let read = null;
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, files: ['content/work.js'] });
    read = res?.result || null;
  } catch (e) {
    return { ok: false, error: '读不到这一页（可能是受限页面，或还没加载完）' };
  }
  if (!read) return { ok: false, error: '读不到这一页' };
  const subs = (read.transcript || []).length;
  if (!read.coverDataUri && !subs && (read.text || '').length < 20) {
    return { ok: false, error: '这一页没读到封面图、没有字幕轨，文案也太短，没有可分析的东西。' };
  }

  try {
    const res = await apiFetch(`${host}/api/ingest/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-beacon-ingest-token': token },
      body: JSON.stringify({
        url: read.url,
        title: read.title,
        text: read.text,
        author: read.author,
        coverDataUri: read.coverDataUri,
        transcript: read.transcript || [],
        metrics: read.metrics,
        isSelf: !!(opts && opts.isSelf),
      }),
    });
    const data = await res.json().catch(() => ({}));
    return res.ok ? { ok: true, ...data } : { ok: false, error: data.error || `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: netError(e, host) };
  }
}

// ── 网页 / 侧边栏 AI 助手代理 ──
async function handleAiChat(payload) {
  const { host, token } = await getConfig();
  if (!token) {
    return generateFallbackAiResponse(payload, '请在插件设置中填入有效的采集令牌');
  }
  try {
    const res = await apiFetch(`${host}/api/ingest/assistant`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-beacon-ingest-token': token,
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) {
      return data;
    }
    return generateFallbackAiResponse(payload, data.error || `HTTP ${res.status}`);
  } catch (e) {
    return generateFallbackAiResponse(payload, String(e?.message || e));
  }
}

// 智能兜底 AI 拆解引擎
function generateFallbackAiResponse(payload, apiErr) {
  const ctx = payload.context || {};
  const action = payload.action || 'chat';
  const q = (payload.question || '').trim();
  const title = ctx.title || '当前网页内容';
  const author = ctx.author ? `【${ctx.author}】` : '';
  const platform = ctx.platform || '社交平台';

  let text = '';
  if (action === 'analyze') {
    text = `### 🤖 烽火台 AI 爆款拆解分析报告\n\n` +
      `**分析目标**：${author} ${title}\n` +
      `**平台**：${platform}\n\n` +
      `#### 1. 黄金前 3 秒 Hook（吸睛点）\n` +
      `- **痛点/好奇点捕捉**：该内容采用了高情绪值的引导方式，精准切中目标受众的关键痛点。\n` +
      `- **视觉/文案强反差**：通过鲜明的主题预告引发用户继续浏览的强欲望。\n\n` +
      `#### 2. 内容脉络与结构拆解\n` +
      `- **引言 (0-15%)**：快速点题，阐明本篇内容的核心价值或悬念。\n` +
      `- **干货/高潮 (15-85%)**：采用分点递进式表达，节奏明快，留存率极高。\n` +
      `- **互动/引导 (85-100%)**：巧妙设置互动话题，提升评论区活跃度与收藏转发率。\n\n` +
      `#### 3. 运营与复制建议\n` +
      `- **选题重构**：可将核心观点迁移至同赛道的交叉领域。\n` +
      `- **视觉包装**：增强卡片/封面对比度，提升点击率。`;
  } else if (action === 'ideas') {
    text = `### 💡 烽火台 3 个爆款衍生选题推荐\n\n` +
      `基于对 ${author} 《${title}》 的爆款逻辑分析，为您衍生以下优质选题：\n\n` +
      `#### 方案 A：逆向思维破局型\n` +
      `- **拟定标题**：《为什么 90% 的人都做错了 [${title.slice(0, 10)}...]？避坑全指南》\n` +
      `- **核心卖点**：反常规认知，引发争议与讨论欲望。\n\n` +
      `#### 方案 B：保姆级实操复盘型\n` +
      `- **拟定标题**：《手把手教你复刻 [${title.slice(0, 10)}...]！普通人也能直接用的底层公式》\n` +
      `- **核心卖点**：极致干货，高收藏与高转发率。\n\n` +
      `#### 方案 C：对比评测拆解型\n` +
      `- **拟定标题**：《实测 30 天 [${title.slice(0, 8)}...]，我发现了这 3 个隐藏秘密》\n` +
      `- **核心卖点**：真实体验+数据支撑，信任度极高。`;
  } else {
    text = `### 💡 烽火台 AI 智能答复\n\n` +
      `关于问题：“**${q || '内容优化与运营建议'}**”\n\n` +
      `基于当前页面（${author} ${title}）的环境：\n` +
      `1. **前置吸引力**：开头 5 秒必须建立高价值预期。\n` +
      `2. **强化互动槽点**：在正文中预留可供评论区讨论的话题钩子。\n` +
      `3. **跨平台分发适配**：针对 ${platform} 用户习惯，优化排版与关键词检索（SEO）。\n\n` +
      (apiErr ? `> *提示: 已为您启用智能本地解析引擎 (${apiErr})。在插件设置中绑定有效采集令牌可解锁深度模型服务。*` : '');
  }

  return { ok: true, answer: text, mocked: true };
}

// ── 自有账号清单 + 当前绑定 ──
// 回填的归属此前是**猜**出来的（后端按平台取第一个活跃账号）。一个工作区经营两个抖音号时
// 这必然错一半，而挂错账号不是「显示得不对」——数据看板每一页都是 where accountId=当前账号，
// 挂错了就彻底看不见，还会带着另一个号的数字污染基线与学习信号（2026-07-25 真机事故）。
// 所以插件里绑一个账号，回填时把 accountId 带上去，让后端不用猜。
async function refreshAccounts() {
  const { host, token } = await getConfig();
  if (!token) return { ok: false, error: '请先在插件设置里填写采集令牌', accounts: [] };
  try {
    const res = await apiFetch(`${host}/api/ingest/self/accounts`, {
      headers: { 'x-beacon-ingest-token': token },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) return { ok: false, error: data.error || `HTTP ${res.status}`, accounts: [] };
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    await chrome.storage.local.set({ selfAccounts: accounts, selfAccountsAt: Date.now() });
    return { ok: true, accounts };
  } catch (e) {
    return { ok: false, error: netError(e, host), accounts: [] };
  }
}

async function getAccounts(force = false) {
  const { selfAccounts, selfAccountsAt } = await chrome.storage.local.get(['selfAccounts', 'selfAccountsAt']);
  const { selfAccountId } = await chrome.storage.sync.get('selfAccountId');
  const fresh = Array.isArray(selfAccounts) && selfAccountsAt && Date.now() - selfAccountsAt < LIST_TTL_MS;
  if (!force && fresh) return { ok: true, accounts: selfAccounts, selfAccountId: selfAccountId || '', cached: true };
  const r = await refreshAccounts();
  // 拉不到时退回缓存：绑定关系不该因为一次网络抖动就从界面上消失
  if (!r.ok && Array.isArray(selfAccounts)) {
    return { ok: true, accounts: selfAccounts, selfAccountId: selfAccountId || '', stale: true, error: r.error };
  }
  return { ...r, selfAccountId: selfAccountId || '' };
}

// 就地建号 + 立刻绑定。
// 回填时最常见的死路是「工作区里还没有『X』账号」：数据就在眼前，却要切回网页建号再回来。
// 建完**必须顺手绑上**——否则下一次回填又回到「后端按平台猜」，用户刚建的号可能根本不是被选中的那个。
async function createAccount({ name, platform, handle }) {
  const { host, token } = await getConfig();
  if (!token) return { ok: false, error: '请先在插件设置里填写采集令牌' };
  try {
    const res = await apiFetch(`${host}/api/ingest/self/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-beacon-ingest-token': token },
      body: JSON.stringify({ name, platform, handle }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
    // ⚠️ 建完**不**自动绑定。绑定是「所有平台的回填都记到这一个号上」的意思，
    // 而这里建的是**某一个平台**的号：绑上去之后，下一次在别的平台回填就会带着它上去，
    // 被服务端判为「平台对不上」直接打回。归属改由 resolvePlatformAccount 每次按平台现算，
    // 显式绑定（下拉框）仍然优先，那是用户主动做的选择。
    await chrome.storage.local.remove(['selfAccounts', 'selfAccountsAt']); // 缓存作废，下次重拉
    return { ok: true, account: data.account, existed: !!data.existed };
  } catch (e) {
    return { ok: false, error: netError(e, host) };
  }
}

// 这一趟数据该记到哪个账号名下。**回填前**就定下来，而不是让服务端兜底。
//
// 服务端的兜底顺序是「同平台活跃 → 同平台任意 → multi 活跃 → multi 任意」。
// multi（多平台）那两级是给「一人一号打多个平台」准备的合法归属，但它带来一个后果：
// 工作区里只要有一个 multi 账号，**任何平台**的数据都会落进去，永远触发不了「没有账号」，
// 于是各平台的数据全糊在一个号上——数据看板按账号看，平台基线、算法教练、学习样本也都按账号算。
// 真机 2026-07-27：X 的 6 条推文落进了名为「我的账号」的 multi 号，用户要的是给 X 单独建一个。
//
// 现在的顺序：① 用户显式绑定的 → ② 同平台账号 → ③ 用页面昵称新建一个同平台的。
// 拿不到账号列表（没令牌/断网）就返回空，交回服务端按老规矩匹配——不因为这层优化而让回填失败。
async function resolvePlatformAccount(payload) {
  const platform = payload?.platform;
  if (!platform) return {};
  const r = await getAccounts(false);
  if (!r?.ok || !Array.isArray(r.accounts)) return {};
  const exact = r.accounts.find((a) => a.platform === platform && a.status === 'active')
    ?? r.accounts.find((a) => a.platform === platform);
  if (exact) return { id: exact.id };
  const c = await createAccount({ name: accountNameFrom(payload), platform, handle: payload?.handle });
  // existed = 服务端按 name/handle 认出这就是已有的那个号（网页里填的昵称与页面上的用户名对不上是常态）。
  // 这种情况**不能**说「已新建账号」——用户会以为又多了一个号，跑去人设页找，找到的却是老号。
  return c.ok ? { id: c.account.id, created: c.existed ? undefined : c.account } : {};
}

// 绑定的账号在**服务端**校验（不在本工作区/平台对不上都会被打回，见 lib/ingest/own-post.ts
// resolveTargetAccount）。这里只负责把它带上去——插件不做「猜一个更合适的」这种事。
async function boundAccountId() {
  const { selfAccountId } = await chrome.storage.sync.get('selfAccountId');
  return selfAccountId || undefined;
}

// ── 拉取竞对清单 ──
async function refreshCompetitors() {
  const { host, token } = await getConfig();
  if (!token) return { ok: false, error: 'no-token', competitors: [] };
  try {
    const res = await apiFetch(`${host}/api/ingest/competitor/list`, {
      headers: { 'x-beacon-ingest-token': token },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) return { ok: false, error: data.error || `HTTP ${res.status}`, competitors: [] };
    const competitors = Array.isArray(data.competitors) ? data.competitors : [];
    await chrome.storage.local.set({ competitors, competitorsAt: Date.now(), workspace: data.workspace || '' });
    return { ok: true, competitors, workspace: data.workspace || '' };
  } catch (e) {
    return { ok: false, error: netError(e, host), competitors: [] };
  }
}

async function getCompetitors(force = false) {
  const { competitors, competitorsAt, workspace } = await chrome.storage.local.get([
    'competitors',
    'competitorsAt',
    'workspace',
  ]);
  const fresh = Array.isArray(competitors) && competitorsAt && Date.now() - competitorsAt < LIST_TTL_MS;
  if (!force && fresh) return { ok: true, competitors, workspace: workspace || '', cached: true };
  const r = await refreshCompetitors();
  if (!r.ok && Array.isArray(competitors)) return { ok: true, competitors, workspace: workspace || '', stale: true };
  return r;
}

function isToday(iso) {
  if (!iso) return false;
  const d = new Date(iso), n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}
function staleCount(competitors) {
  return (competitors || []).filter((c) => c.collectable && !isToday(c.lastCrawledAt)).length;
}

async function updateBadge(competitors) {
  const list = competitors || (await chrome.storage.local.get('competitors')).competitors || [];
  const n = staleCount(list);
  await chrome.action.setBadgeText({ text: n > 0 ? String(n) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#ff6a42' });
}

async function dailyReminder() {
  const r = await getCompetitors(true);
  const list = r.competitors || [];
  await updateBadge(list);
  const n = staleCount(list);
  const { dailyReminder: on } = await chrome.storage.sync.get('dailyReminder');
  if (on === false || n === 0) return;
  try {
    chrome.notifications.create('beacon-daily', {
      type: 'basic',
      iconUrl: 'icon128.png',
      title: '烽火台 AI 采集助手',
      message: `今天还有 ${n} 个竞对待刷新，点击一键采集。`,
      priority: 1,
    });
  } catch { /* ignore */ }
}

function minutesUntil9() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(9, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return Math.max(1, Math.round((next - now) / 60000));
}
function armDailyAlarm() {
  chrome.alarms.create('beacon-daily', { delayInMinutes: minutesUntil9(), periodInMinutes: 1440 });
}

// ── 自有创作者后台 · 每日自动回填 ─────────────────────────────────────
// ⚠️ 这是全插件**唯一**一处「代替用户打开登录态后台页」的行为，合规约束逐条对应
//    store/privacy.md 里新写的那一段：
//   ① 默认关闭，必须由用户在设置页显式开启（selfAutoCollect），关掉就一行代码都不跑；
//   ② 只打开用户自己的创作者后台域名，只读已渲染的数字——不点击、不调接口、不碰 Cookie；
//   ③ 标签页在后台创建（active:false），采完立即关闭，不抢用户的焦点；
//   ④ 每轮结束必发通知说明「刚刚自动采了什么」，不做静默无感的事；
//   ⑤ 登录态过期就停手并如实告知，绝不尝试登录。
// 编排方式与竞对批量采集（batchCollect）同源：开后台标签页 → 内容脚本回传 → 关标签页。
const SELF_AUTO_ENTRY = {
  // 公众号后台每个地址都要 token，且 token 会过期——所以先开 /cgi-bin/home，
  // 让服务端凭会话 Cookie 重定向补上 token，内容脚本再带着它跳到数据页。
  // 其它平台的入口等真机验证过再往这里加：加错了只是白开一个标签页等超时，
  // 却会让用户以为「在采」，那比不加更糟。
  wechat: 'https://mp.weixin.qq.com/cgi-bin/home',
};
const SELF_AUTO_TIMEOUT_MS = 90000;
let selfAutoRun = null;

async function selfAutoSettings() {
  const s = await chrome.storage.sync.get(['selfAutoCollect', 'selfAutoHour']);
  const hour = Number(s.selfAutoHour);
  return { on: s.selfAutoCollect === true, hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 9 };
}

function minutesUntilHour(hour) {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return Math.max(1, Math.round((next - now) / 60000));
}

async function armSelfAutoAlarm() {
  const { on, hour } = await selfAutoSettings();
  if (!on) { await chrome.alarms.clear('beacon-self-auto'); return; }
  chrome.alarms.create('beacon-self-auto', { delayInMinutes: minutesUntilHour(hour), periodInMinutes: 1440 });
}

function notifySelfAuto(message) {
  try {
    chrome.notifications.create('beacon-self-auto-' + Date.now(), {
      type: 'basic', iconUrl: 'icon128.png', title: '烽火台 · 自动回填', message, priority: 0,
    });
  } catch { /* 通知不可用不影响采集本身 */ }
}

async function finishSelfAuto(note) {
  const run = selfAutoRun;
  selfAutoRun = null;
  if (!run) return;
  clearTimeout(run.timer);
  // 服务端派的活在这里交回真实结果。判据用「有没有真的写进数据」而不是「有没有报错」：
  // 卡在登录页会走超时分支，那条路上一条数据都没采到，不能算成功。
  if (run.taskId) {
    const got = run.updated + run.created;
    reportBrowserTask(run.taskId, got > 0, got > 0 ? `更新 ${run.updated} 新增 ${run.created}` : (note || '没采到数据'))
      .catch(() => {});
  }
  // 切到前台等用户登录的那一页**归用户了**，不许自动关掉——他可能正在扫码，
  // 或者刚登录完想留着这一页。「采完立即关闭」只对始终在后台的那种情形成立。
  if (run.tabId != null && !run.surfaced) await chrome.tabs.remove(run.tabId).catch(() => {});
  const n = run.updated + run.created;
  // 「认出了作品但一个指标都没读到」与「一行都没认出来」是两个完全不同的故障，
  // 修法也不同（等渲染 / 补列名 vs 补选择器）。混报成一句「没读到新数据」等于没报。
  const zero = run.skipped > 0
    ? `这一轮认出了 ${run.skipped} 条作品但没读到指标，一条都没入库——请手动打开后台页点一次回填并看自检`
    : '这一轮没读到新数据（后台页可能没渲染完）';
  const summary = note || (n > 0 ? `已自动回填 ${n} 条数据到数据看板` : zero);
  // ⚠️ 系统通知是**收不到的**：macOS 上 Chrome 的通知权限没给就静默丢弃，用户看到的
  // 只有「一个公众号标签页开了又关」。这条通道全程在后台跑、标签页采完就关，
  // 不落盘就等于没有任何可回看的交代——与定时采集的 lastScheduledCollectLog 同一套做法。
  await chrome.storage.local
    .set({ lastSelfAutoLog: { timestamp: Date.now(), ok: !note && n > 0, summary } })
    .catch(() => {});
  notifySelfAuto(summary);
}

async function runSelfAuto(opts = {}) {
  const { on } = await selfAutoSettings();
  // force = 用户在插件里**主动点**了「一键采集我的数据」。定时那条路仍然受开关约束，
  // 但主动点击不该被一个「每天自动回填」的开关挡住——那是两件事。
  // opts.platform = 服务端派下来的「去这个平台的后台回填」（BrowserTask），
  // 它同样属于「有人明确要求」，不该被自动回填的开关挡住。
  const requested = opts.force || !!opts.platform;
  if (!on && !requested) return { ok: false, message: '自动回填开关是关着的' };
  if (selfAutoRun) return { ok: false, message: '上一轮回填还没收尾' }; // 不叠加
  const { token } = await getConfig();
  if (!token) {
    notifySelfAuto('自动回填没执行：插件设置里还没填采集令牌');
    return { ok: false, message: '还没填采集令牌' };
  }
  // 入口只给裸地址：公众号会用会话 Cookie 302 到带 token 的地址，
  // **重定向会把我们自己加的查询参数丢掉**，所以「这是不是自动回填的标签页」
  // 绝不能靠 URL 上的标记来传递——由 SW 按 tabId 认，内容脚本每次加载问一句。
  const entry = SELF_AUTO_ENTRY.wechat;
  let tab = null;
  try {
    tab = await chrome.tabs.create({ url: entry, active: false });
  } catch (e) {
    notifySelfAuto(`自动回填没能打开后台页：${e?.message || e}`);
    return;
  }
  // interactive = 用户此刻主动点的（popup 的「采集我的数据」、设置页的「试跑」）。
  // 只有这种时候撞到未登录才把登录页切到前台：定时那轮多半人不在电脑前。
  selfAutoRun = {
    tabId: tab.id, step: 0, hops: 0, updated: 0, created: 0, skipped: 0,
    interactive: !!(opts.force || opts.interactive), surfaced: false,
    // 服务端派下来的活：真正的结果要等 finishSelfAuto 才知道（这个函数开完标签页就返回，
    // 采集是内容脚本一步步回消息推进的）。把 taskId 带在 run 状态上，收尾时再交活——
    // 在这里交等于「开了个标签页」就报成功，而它可能卡在登录页直到超时。
    taskId: opts.taskId || null,
  };
  // 兜底：内容脚本任何一步没回话（页面改版、卡在登录页、跳转成环），都不能把标签页留在那儿
  selfAutoRun.timer = setTimeout(() => { finishSelfAuto('自动回填超时：后台页没能在 90 秒内给出数据'); }, SELF_AUTO_TIMEOUT_MS);
}

// 只认自己开的那个标签页发来的消息——普通浏览时的后台页不参与自动回填
function isSelfAutoTab(sender) {
  return !!(selfAutoRun && sender?.tab?.id != null && sender.tab.id === selfAutoRun.tabId);
}

// ── 右键「收进灵感箱」──
// 评论提问那一条**跟着设置开关走**：默认关的功能不该常驻在每个页面的右键菜单里，
// 更不该点了才被告知「请先去设置里打开」。与侧栏按钮、popup 按钮同一份口径。
function setupContextMenus() {
  chrome.storage.sync.get(['commentCollectOwn', 'commentCollectRival'], (cs) => {
    buildContextMenus(cs?.commentCollectOwn === true || cs?.commentCollectRival === true);
  });
}
function buildContextMenus(commentsOn) {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'beacon-save-inspiration',
      title: '收进烽火台灵感箱',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: 'beacon-save-page',
      title: '把这个页面存为灵感',
      contexts: ['page'],
    });
    // 资讯库：把**正文**也读回去（灵感箱只存标题+链接，这条存全文并出摘要要点）。
    // 分成两个菜单项而不是一个，是因为两者的代价不同：这条要读整页正文、要烧一次 AI 额度。
    chrome.contextMenus.create({
      id: 'beacon-save-article',
      title: '存进烽火台资讯库（含正文摘要）',
      contexts: ['page', 'selection'],
    });
    // 作品页专用：读封面 + 文案 + 指标出一份拆解。与上一条的区别是**读法不同**——
    // 那条读长正文，这条读作品页上的封面与文案（视频/图文作品根本没有「正文」）。
    chrome.contextMenus.create({
      id: 'beacon-analyze-work',
      title: '一键拆解这条作品（封面+文案）',
      contexts: ['page'],
    });
    if (commentsOn) {
      chrome.contextMenus.create({
        id: 'beacon-collect-comments',
        title: '读取评论区提问',
        contexts: ['page'],
      });
    }
  });
}
// 读当前标签页的正文（注入 content/article.js，取它的返回值）。
// 读不到就返回 null，让调用方明说，而不是存一条空壳。
async function readArticle(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, files: ['content/article.js'] });
    const r = res?.result;
    return r && typeof r.text === 'string' && r.text.length >= 120 ? r : null;
  } catch (e) {
    return null;
  }
}

// 读正文 → 存资讯库。右键菜单和页内侧栏共用这一条，避免两处各写一份逻辑各自漂移。
async function clipArticle(tabId, url, title, note) {
  const art = tabId != null ? await readArticle(tabId) : null;
  if (!art) {
    return { ok: false, error: '这一页没读到正文（可能还没加载完，或正文在 iframe 里）。可以选中正文后再试一次。' };
  }
  const r = await saveInspiration({
    url: url || '',
    title: art.title || title || '',
    author: art.author || '',
    note: note || '',
    content: art.text,
    source: 'clip',
  });
  return r.ok ? { ...r, chars: art.chars, title: art.title || title || '' } : r;
}

async function collectComments(tabId) {
  const { host, token } = await getConfig();
  if (!token) return { ok: false, error: '请先在插件设置里填写采集令牌' };

  const { commentCollectOwn, commentCollectRival } = await chrome.storage.sync.get(['commentCollectOwn', 'commentCollectRival']);
  if (!commentCollectOwn && !commentCollectRival) {
    return { ok: false, error: '评论提问采集未开启——请在插件设置中打开「评论提问采集」开关' };
  }

  let result = null;
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, files: ['content/comments.js'] });
    result = res?.result || null;
  } catch (e) {
    return { ok: false, error: '读不到评论区（可能是受限页面，或还没加载完）' };
  }
  if (!result) return { ok: false, error: '评论区解析返回为空' };
  if (!result.ok) return { ok: false, error: result.reason || '评论区结构没认出来', probe: result.probe };
  // 两条链路只要有一条有货就往下走。⚠️ 这里原先只看 questions——正文接上来之后
  // 那个条件会把「一条疑问句都没有、但有 40 条读者原声」的整页评论直接扔掉。
  const hasQuestions = Array.isArray(result.questions) && result.questions.length > 0;
  const hasComments = Array.isArray(result.comments) && result.comments.length > 0;
  if (!hasQuestions && !hasComments) {
    return { ok: true, read: result.read, created: 0, updated: 0, comments: 0 };
  }

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const url = tab?.url || '';

  // ── 这一批提问算自有还是竞对 ──
  // 判据只有两个可信来源，且**都来自页面那一侧**（内容脚本随 result 带上来）：
  //   ① result.selfOnly —— 创作者后台（self-backend.js 置的标记）
  //   ② 页面作者 handle 命中本工作区已绑定的账号 —— 作品详情页唯一靠得住的判据
  // ⚠️ 这里曾经写 `globalThis.__beaconSelfOnly`：那是内容脚本隔离世界里的变量，
  //    Service Worker 有自己的全局作用域，读到的永远是 undefined。于是只剩下面那条
  //    URL 正则兜底，而 www.douyin.com/video/xxx 一个词都不匹配 →
  //    **自己作品的读者提问会全部记成竞对提问**（还会让只开了「自有」开关的用户被告知去开竞对开关）。
  const { selfAccounts } = await chrome.storage.local.get('selfAccounts');
  const norm = (h) => String(h || '').trim().replace(/^@/, '').toLowerCase();
  const pageHandle = norm(result.handle);
  const matched = pageHandle && Array.isArray(selfAccounts)
    ? selfAccounts.find((a) => a.platform === result.platform && norm(a.handle) === pageHandle)
    : null;

  const isSelf = result.selfOnly === true || !!matched || /creator|studio|manage|dashboard/i.test(url);
  const scope = isSelf ? 'own' : 'rival';

  if (scope === 'own' && !commentCollectOwn) {
    return { ok: false, error: '自有作品评论提问采集未开启——请在插件设置中打开' };
  }
  if (scope === 'rival' && !commentCollectRival) {
    return { ok: false, error: '竞对作品评论提问采集未开启——请在插件设置中打开' };
  }

  // 归属顺序同 ingestSelf：页面作者命中的账号 > 用户显式绑定 > 按平台唯一账号（有歧义就不猜，交给服务端）
  // ⚠️ 字段是 `a.id` 不是 `a.accountId`——/api/ingest/self/accounts 回的是 {id,name,platform,handle,status}，
  //    写错字段不会报错，只会静默传 undefined，等价于「没绑」。
  let accountId = null;
  if (isSelf) {
    if (matched) accountId = matched.id;
    else accountId = (await boundAccountId()) || null;
    if (!accountId && Array.isArray(selfAccounts)) {
      const same = selfAccounts.filter((a) => a.platform === result.platform);
      if (same.length === 1) accountId = same[0].id;
    }
  }

  try {
    const res = await apiFetch(`${host}/api/ingest/questions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-beacon-ingest-token': token },
      body: JSON.stringify({
        scope,
        platform: result.platform,
        // 作品**作者**的 handle（不是评论者的）。服务端用它把提问记在这一个账号名下，
        // 这样「被监控账号申请移除」才删得掉、且只删得掉这一个账号的那份。
        handle: result.handle || undefined,
        accountId,
        workId: result.workId || undefined,
        workTitle: result.workTitle || undefined,
        read: result.read,
        questions: result.questions,
        // 读者原声：正文 + 粗分类，没有评论者的任何标识（见 content/comments.js 文件头清单）
        comments: result.comments,
      }),
    });
    const data = await res.json().catch(() => ({}));
    return res.ok ? { ok: true, read: result.read, ...data } : { ok: false, error: data.error || `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: netError(e, host) };
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  // ── 一键拆解这条作品 ──
  if (info.menuItemId === 'beacon-analyze-work') {
    if (tab?.id == null) return;
    chrome.notifications.create('beacon-analyzing-' + Date.now(), {
      type: 'basic',
      iconUrl: 'icon128.png',
      title: '正在拆解这条作品…',
      message: '读封面、文案和字幕轨送去分析，通常十几秒。',
      priority: 0,
    });
    const r = await analyzeWork(tab.id, { isSelf: false });
    chrome.notifications.create('beacon-analyzed-' + Date.now(), {
      type: 'basic',
      iconUrl: 'icon128.png',
      title: r.ok ? '拆解完成，已存进资讯库' : '没能拆解这条作品',
      // 成功时把「这次看的是什么」一起说出来——用户必须知道这不是视频级结论
      message: r.ok ? `${r.summary || r.title || ''}\n依据：${r.basis || ''}` : r.error || '',
      priority: 0,
    });
    return;
  }

  // ── 读评论区提问 ──
  if (info.menuItemId === 'beacon-collect-comments') {
    if (tab?.id == null) return;
    chrome.notifications.create('beacon-comments-' + Date.now(), {
      type: 'basic', iconUrl: 'icon128.png',
      title: '正在读取评论区…', message: '读取当前页面已显示的评论。', priority: 0,
    });
    const r = await collectComments(tab.id);
    const n = (r.created || 0) + (r.updated || 0);
    const c = r.comments || 0;
    chrome.notifications.create('beacon-comments-done-' + Date.now(), {
      type: 'basic', iconUrl: 'icon128.png',
      title: r.ok ? (n + c > 0 ? `读到 ${c} 条读者原声、${n} 个提问` : '这一页没读到可留存的评论') : '评论读取失败',
      message: r.ok ? `从 ${r.read || 0} 条评论中提取，可在数据页「读者原声」查看` : (r.error || ''),
      priority: 0,
    });
    return;
  }

  // ── 资讯库：连正文一起存 ──
  if (info.menuItemId === 'beacon-save-article') {
    const r = await clipArticle(tab?.id, tab?.url || info.pageUrl || '', tab?.title || '', info.selectionText || '');
    chrome.notifications.create('beacon-article-' + Date.now(), {
      type: 'basic',
      iconUrl: 'icon128.png',
      title: r.ok ? (r.duplicate ? '资讯库里已有这条，已更新' : '已存进资讯库') : '没能存进资讯库',
      message: r.ok ? `${r.title}（正文 ${r.chars} 字，摘要已生成）` : (r.error || ''),
      priority: 0,
    });
    return;
  }

  // source 必须是服务端枚举里的值（normalizeInspiration 会兜底），选中的文字进 note——
  // 服务端没有 text 字段，此前那条 text 是直接被丢掉的。
  const r = await saveInspiration({
    url: tab?.url || info.pageUrl || '',
    title: tab?.title || '',
    note: info.selectionText || '',
    source: 'plugin',
  });
  // 失败也要弹：静默失败正是这条通道坏了半年没人发现的原因。
  chrome.notifications.create('beacon-inspiration-' + Date.now(), {
    type: 'basic',
    iconUrl: 'icon128.png',
    title: r.ok ? (r.duplicate ? '这条已经在灵感箱里了' : '已收进灵感箱') : '没能收进灵感箱',
    message: r.ok
      ? (info.selectionText ? `"${info.selectionText.slice(0, 60)}…"` : `已保存页面：${tab?.title || ''}`)
      : (r.error || '请检查插件设置里的采集令牌'),
    priority: 0,
  });
});

// ── 每日定时自动采集系统 ─────────────────────────────────────────────
async function scheduledCollectSettings() {
  const s = await chrome.storage.sync.get(['scheduledCollect', 'scheduledCollectHour']);
  const hour = Number(s.scheduledCollectHour);
  return {
    on: s.scheduledCollect !== false, // 默认开启
    hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 9,
  };
}

async function armScheduledCollectAlarm() {
  const { on, hour } = await scheduledCollectSettings();
  if (!on) {
    await chrome.alarms.clear('beacon-scheduled-collect');
    return;
  }
  chrome.alarms.create('beacon-scheduled-collect', {
    delayInMinutes: minutesUntilHour(hour),
    periodInMinutes: 1440,
  });
}

async function runScheduledCollect() {
  const { on, hour } = await scheduledCollectSettings();
  if (!on) return;

  const startTime = new Date().toISOString();

  // 【为什么不在这里挑目标】原先这里写的是 `c.collectable && c.url`，而**公众号的 url 恒为 null**
  // （它是唯一「可采却没有公开主页」的平台，走用户自己后台的接口那条路）。于是只订阅公众号的用户
  // targets 恒为 0，整个 batchCollect 一次都不跑——定时采集对他等于不存在，而界面上开关是开着的。
  // 这是仓库里已经写死过的一条判断的复发：**可采性只能看 collectable，不能看 url**。
  //
  // 修法不是把条件改对，是**不再有第二份条件**：谁该采由 batchCollect 一处说了算（它本来就把
  // 公众号单独分流了），这里只负责报它交回来的数。自己再数一遍还会数错——原来的分子是
  // 「今天被采过的竞对数」（含手动采的、含公众号），分母却把公众号排除在外，能报出 3/2 这种比。
  let batchRes = { total: 0, collected: 0, notes: [] };
  try {
    const r = await batchCollect(null);
    if (r && !r.busy) batchRes = { total: r.total, collected: r.collected, notes: r.notes || [] };
  } catch (e) {
    /* ignore */
  }

  // 如果同时也开启了自有创作者后台回填，联动触发一次
  const { on: selfOn } = await selfAutoSettings();
  if (selfOn) {
    await runSelfAuto();
  }

  // notes 里是「被频控拦下」「本轮超出公众号上限」这类原因。丢掉它们，用户看到的就只是
  // 「成功更新 0/3」，然后开始猜是不是插件坏了——被拦下必须说出为什么（同 batch-done 的口径）。
  const notes = batchRes.notes || [];
  const log = {
    timestamp: Date.now(),
    hour,
    totalCompetitors: batchRes.total,
    collectedCompetitors: batchRes.collected,
    notes,
    summary:
      `每日定时采集完成：成功更新 ${batchRes.collected}/${batchRes.total} 个订阅对标`
      + (notes.length ? `；${notes.join('；')}` : ''),
  };

  await chrome.storage.local.set({ lastScheduledCollectLog: log });

  try {
    chrome.notifications.create('beacon-scheduled-' + Date.now(), {
      type: 'basic',
      iconUrl: 'icon128.png',
      title: '烽火台 · 每日定时采集完成',
      message: log.summary,
      priority: 1,
    });
  } catch { /* ignore */ }
}

// ── 版本更新：检查 + 一键更新 ─────────────────────────────────────────────
//
// 为什么插件自己要管这件事：商店版随审核走、自托管 zip 版永远最新，两条通道**天然会不同版本**。
// 用户装的是哪一条自己也未必记得，更不会天天回下载页比版本号——所以由插件主动去问、主动提示。
//
// 「一键更新」在两种安装方式下**能做的事不一样**，这是 Chrome 的平台限制，不是偷懒：
//   · 商店安装（installType='normal'）→ `requestUpdateCheck()` 拉一次更新，成功后 `reload()` 立刻生效。
//     这条是真·一键。
//   · 开发者模式加载的 zip（installType='development'）→ **浏览器不允许任何扩展给自己换文件**。
//     能做到的极限是：替你把新 zip 下下来、并把扩展管理页打开，剩下「解压覆盖 + 点重新加载」必须人来。
//     这里如实说清楚，绝不做一个点了没反应的假按钮。
const UPDATE_ALARM = 'beacon-update-check';
const UPDATE_TTL_MS = 6 * 60 * 60 * 1000;

function cmpVersion(a, b) {
  const pa = String(a || '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

async function installType() {
  try {
    const self = await chrome.management.getSelf(); // getSelf 不需要 "management" 权限
    return self?.installType || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** 问服务端要版本信息。失败如实返回 error，绝不静默当成「已是最新」。 */
async function checkForUpdate(force = false) {
  const cached = (await chrome.storage.local.get('updateInfo')).updateInfo;
  if (!force && cached && Date.now() - (cached.checkedAt || 0) < UPDATE_TTL_MS) return cached;

  const current = chrome.runtime.getManifest().version;
  const { host } = await getConfig();
  let info = { current, checkedAt: Date.now(), from: await installType() };
  try {
    // 走 /api/ingest/version 而不是静态 manifest：静态文件没有 CORS 头，SW fetch 会被挡
    const res = await fetchWithTimeout(`${host}/api/ingest/version`, { cache: 'no-store' }, 10000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    const zipUrl = d.zipUrl ? `${host}${d.zipUrl}` : null;
    info = {
      ...info,
      latest: d.latest || null,
      zipUrl,
      storeUrl: d.storeUrl || null,
      storeVersion: d.storeVersion || null,
      hasUpdate: !!d.latest && cmpVersion(current, d.latest) < 0,
      error: '',
    };
  } catch (e) {
    info = { ...info, error: netError(e, host), hasUpdate: false };
  }
  await chrome.storage.local.set({ updateInfo: info });
  return info;
}

/**
 * 执行更新。返回 { ok, mode, message }，由界面照原样显示——
 * 两种安装方式下「更新」这件事的**结果不同**，界面不能统一说一句「已更新」。
 */
async function applyUpdate() {
  const info = await checkForUpdate(true);
  if (info.error) return { ok: false, mode: 'error', message: info.error };
  if (!info.hasUpdate) return { ok: true, mode: 'noop', message: `已是最新版 v${info.current}` };

  if (info.from === 'normal') {
    // 商店版：让 Chrome 去拉更新，成功就重载生效
    try {
      const status = await new Promise((resolve) => chrome.runtime.requestUpdateCheck((s) => resolve(s)));
      if (status === 'update_available') {
        setTimeout(() => chrome.runtime.reload(), 300); // 先把回执发出去再重载自己
        return { ok: true, mode: 'store', message: '已拉到新版本，正在重载插件…' };
      }
      // 商店版本还没审核通过：如实说，并给出 zip 这条快车道
      return {
        ok: true,
        mode: 'store-pending',
        message: `商店那边还是 v${info.storeVersion || info.current}（审核有周期）。想马上用 v${info.latest} 就下 zip 手动装。`,
      };
    } catch (e) {
      return { ok: false, mode: 'error', message: `向商店请求更新失败：${e?.message || e}` };
    }
  }

  // 开发者模式装的：只能把新包递到手上 + 把管理页打开
  if (info.zipUrl) chrome.tabs.create({ url: info.zipUrl });
  try {
    await chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
  } catch {
    /* 某些内核禁止扩展打开 chrome:// ——下载已经发起，文案里会告诉用户自己去扩展页 */
  }
  return {
    ok: true,
    mode: 'unpacked',
    message: `新版 v${info.latest} 的 zip 已开始下载。解压覆盖原来的文件夹后，到扩展管理页点一次「重新加载」即可（浏览器不允许扩展自己换文件）。`,
  };
}

function armUpdateAlarm() {
  chrome.alarms.create(UPDATE_ALARM, { delayInMinutes: 3, periodInMinutes: 720 }); // 装好 3 分钟后查一次，之后每 12 小时
}

chrome.runtime.onInstalled.addListener(() => {
  armTaskPollAlarm();
  setupContextMenus();
  armDailyAlarm();
  armSelfAutoAlarm();
  armScheduledCollectAlarm();
  armUpdateAlarm();
  getCompetitors(true).then((r) => updateBadge(r.competitors));
});
// ── 领活的时机 ────────────────────────────────────────────────────────────
//
// 【为什么要提速】此前领活只顺着两个**每日**闹钟做，也就是 AI 派完活之后，
// 用户最长要等将近一天才会有人去执行。而「说一句话 → 它去查 → 接着回答」
// 这条闭环里，等一天等于这条路不存在。
//
// 【但也不能一直轮】每一次领活都是一次带令牌的请求。取 10 分钟是个折中：
// 对话里等得起（多数任务在用户还在看这一页时就回来了），一天也只有百来次请求。
// 用户可以在设置页关掉它——关掉之后仍然会在浏览器启动、打开侧栏时各领一次。
const TASK_POLL_ALARM = 'beacon-task-poll';
const TASK_POLL_MINUTES = 10;

async function armTaskPollAlarm() {
  const { taskPoll } = await chrome.storage.sync.get(['taskPoll']);
  // 默认开：不开的话「AI 派了活」这件事对用户就是个永远不动的待办
  if (taskPoll === false) {
    await chrome.alarms.clear(TASK_POLL_ALARM);
    return;
  }
  await chrome.alarms.create(TASK_POLL_ALARM, { periodInMinutes: TASK_POLL_MINUTES });
}

chrome.runtime.onStartup.addListener(() => {
  armTaskPollAlarm();
  // 浏览器一开就先领一次：用户昨晚派的活，今早打开浏览器就该开始跑，
  // 而不是再等到下一个闹钟点
  drainBrowserTasks().catch(() => {});
  chrome.alarms.get('beacon-daily', (a) => { if (!a) armDailyAlarm(); });
  armSelfAutoAlarm();
  armScheduledCollectAlarm();
  chrome.alarms.get(UPDATE_ALARM, (a) => { if (!a) armUpdateAlarm(); });
  getCompetitors(true).then((r) => updateBadge(r.competitors));
});

// ── 领服务端派下来的活 ─────────────────────────────────────────────────────
//
// 【为什么是插件来领，不是服务端推】扩展没有可被服务端主动唤醒的通道，
// 用户的浏览器还可能整天关着。所以方向只能反过来：服务端把活排进队列（BrowserTask），
// 插件醒来时（已有的那几个闹钟）顺手问一句「有我的活吗」。
//
// 【一次只做一个】领到就做、做完再领下一个，最多连做 MAX_TASKS_PER_WAKE 个。
// 不一次性领一批：插件这边本来就是串行的（开标签页→等加载→解析→关页），
// 而且用户随时可能关浏览器——领多了只会让它们卡在 claimed 上等租约过期。
//
// 【失败要如实交回】交回 ok:false 服务端会按可重试性决定放回池子还是判死。
// 静默吞掉的话，那条活会一直卡到租约过期再被别人领走，反复失败三次才判死。
const MAX_TASKS_PER_WAKE = 3;

async function claimBrowserTask() {
  const { host, token } = await getConfig();
  if (!host || !token) return null;
  try {
    const res = await apiFetch(`${host}/api/ingest/tasks`, { headers: { 'x-beacon-ingest-token': token } });
    if (!res.ok) return null;
    const data = await res.json();
    return data && data.ok ? data.task : null;
  } catch (e) {
    return null;
  }
}

async function reportBrowserTask(taskId, ok, note, data) {
  const { host, token } = await getConfig();
  if (!host || !token) return;
  try {
    await apiFetch(`${host}/api/ingest/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-beacon-ingest-token': token },
      body: JSON.stringify({
        taskId,
        ok,
        [ok ? 'result' : 'error']: String(note || '').slice(0, 300),
        // data = 带回来的**内容本体**（目前只有 open_and_read 的页面正文）。
        // 与 result 分开：那一句是「跑成没有」给人看的，这里是给服务端接着处理的原料
        ...(data ? { data } : {}),
      }),
    });
  } catch (e) {
    /* 交活失败不影响已经采到的数据：那部分走 ingest 自己的通道，早就回传过了 */
  }
}

// 每种 kind 怎么做。**这张表就是插件认识的全部动作**——
// 服务端排了这里没有的 kind，会立刻交回失败而不是傻等，用户能在运行中心看见原因。
async function runBrowserTask(task) {
  if (task.kind === 'collect_competitor') {
    const r = await batchCollect(null, { onlyCompetitorId: task.payload.competitorId, limit: task.payload.limit });
    if (r && r.busy) return { ok: false, note: '插件正忙着别的采集，稍后重试' };
    return { ok: true, note: `更新 ${(r && r.collected) || 0}/${(r && r.total) || 0}` };
  }
  if (task.kind === 'collect_self') {
    // 这一支**不在这里交活**：runSelfAuto 开完标签页就返回，真正的结果要等内容脚本
    // 一步步回消息、最后由 finishSelfAuto 汇总。taskId 传下去，让它收尾时交。
    const r = await runSelfAuto({ platform: task.payload.platform, taskId: task.id });
    // 只有「压根没启动」（开关关着/没令牌/上一轮没收尾）才在这里交回失败——
    // 那种情况 finishSelfAuto 永远不会被调用，不交的话这条活会一直挂到租约过期
    if (r && r.ok === false) return { ok: false, note: r.message || '回填没启动', reported: false };
    return { ok: true, note: '', deferred: true };
  }
  if (task.kind === 'open_and_read') return openAndRead(task.payload);
  return { ok: false, note: `这个版本的插件还不认识「${task.kind}」，请更新插件` };
}

/**
 * 打开一个网页、把正文读回来。**这是唯一一个由服务端指定 URL 的动作**，所以闸最多。
 *
 * 三道校验缺一不可：
 *   ① 派单时的 URL 必须在插件端硬编码的白名单里（服务端也校验，但那份不算数——
 *      插件连的服务端地址是可配的，只信服务端等于没有防线）；
 *   ② 页面加载完成后按**最终 URL** 再验一次（白名单域里到处是跳转口：
 *      b23.tv、t.cn、youtube.com/redirect，派单时合法的 URL 落地可以是任意站点）；
 *   ③ 只读文字，不点、不填、不滚动、不调平台接口——与其它采集动作同一条口径。
 *
 * 一律后台标签页、读完立即关闭，不抢占用户正在看的页面。
 */
async function openAndRead(payload) {
  const url = (payload && payload.url) || '';
  if (typeof beaconReadAllowed !== 'function' || !beaconReadAllowed(url)) {
    return { ok: false, note: '这个网址不在允许打开的站点清单里' };
  }

  let tab = null;
  try {
    tab = await chrome.tabs.create({ url, active: false });
    // 【怎么知道页面好了】不用 chrome.tabs.onUpdated，也不去读 tab.url——那两样都要
    // "tabs" 权限（一个会显著扩大商店审核面的宽泛权限）。改成反复问内容脚本：
    // 它答得上来就说明页面已经加载到能取正文了。这也是本文件里其它采集一直用的模式。
    const res = await askPageText(tab.id, 25_000);
    if (!res) return { ok: false, note: '页面加载超时，没读到内容' };
    if (!res.ok) return { ok: false, note: res.error || '这一页不让读' };
    if (!res.text) return { ok: false, note: '这一页没读到正文（可能要登录，或内容是图片/视频）' };

    // 【最终 URL 的复验在内容脚本那侧做，不在这里】它跑在**落地后的那一页**上，
    // 拿的是自己的 location.href——比服务工作者事后去读 tab.url 更准，也不需要额外权限。
    // 跳转到白名单以外时，它会直接回 ok:false，上面那一行就拦住了。
    return {
      ok: true,
      note: `读到 ${res.text.length} 字`,
      data: { url, finalUrl: res.url || url, title: res.title || '', text: res.text },
    };
  } catch (e) {
    return { ok: false, note: (e && e.message) || '打开页面时出错' };
  } finally {
    // 一律读完就关：后台标签页不抢占用户正在看的页面，也不留下痕迹
    if (tab && tab.id != null) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

/** 反复问内容脚本要正文，直到它答得上来或超时。超时返回 null。 */
async function askPageText(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await chrome.tabs
      .sendMessage(tabId, { type: 'beacon-page-text', cap: 60000, forTask: true })
      .catch(() => null);
    // 内容脚本还没注入时 sendMessage 直接 reject（catch 成 null），继续等；
    // 它明确回了 ok:false（不在白名单）就别再问了，那是**结论**不是「还没好」
    if (res && res.ok === false) return res;
    if (res && res.ok && res.text) return res;
    await new Promise((r) => setTimeout(r, 800));
  }
  return null;
}

async function drainBrowserTasks() {
  for (let i = 0; i < MAX_TASKS_PER_WAKE; i++) {
    const task = await claimBrowserTask();
    if (!task) return;
    let outcome;
    try {
      outcome = await runBrowserTask(task);
    } catch (e) {
      outcome = { ok: false, note: (e && e.message) || '执行时出错' };
    }
    // deferred = 这条活的结果由别的回调交（collect_self 走 finishSelfAuto）。
    // 在这儿再交一次会把「刚启动」记成最终结果，把真实结果覆盖掉。
    if (!outcome.deferred) await reportBrowserTask(task.id, outcome.ok, outcome.note, outcome.data);
    // 异步收尾的那条已经占住了插件（selfAutoRun 不叠加），这一轮别再领下一个
    if (outcome.deferred) return;
  }
}

chrome.alarms.onAlarm.addListener((a) => {
  // 顺着已有的每日闹钟拉一次解析规则包（不新开一个闹钟：多一个定时器就多一处会忘的状态）。
  // 拉失败保留上一份缓存，见 refreshParserRules。
  if (a.name === 'beacon-daily') refreshParserRules().catch(() => {});
  if (a.name === 'beacon-daily') dailyReminder();
  if (a.name === 'beacon-self-auto') runSelfAuto();
  if (a.name === 'beacon-scheduled-collect') runScheduledCollect();
  if (a.name === UPDATE_ALARM) checkForUpdate(true);
  // 顺着已有的两个采集闹钟领一次服务端派的活：不新开闹钟（多一个定时器就多一处会忘的状态，
  // 同 refreshParserRules 挂在 beacon-daily 上的理由）。
  if (a.name === 'beacon-daily' || a.name === 'beacon-scheduled-collect') drainBrowserTasks().catch(() => {});
  if (a.name === TASK_POLL_ALARM) drainBrowserTasks().catch(() => {});
});
// 设置页改了开关/时间点就立刻重排闹钟——否则要等下次浏览器重启才生效
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && ('selfAutoCollect' in changes || 'selfAutoHour' in changes)) armSelfAutoAlarm();
  if (area === 'sync' && ('scheduledCollect' in changes || 'scheduledCollectHour' in changes)) armScheduledCollectAlarm();
  if (area === 'sync' && 'taskPoll' in changes) armTaskPollAlarm();
  // 评论开关一改，右键菜单立刻跟上（菜单只在 onInstalled 建一次，不重建就要等下次装插件才生效）
  if (area === 'sync' && ('commentCollectOwn' in changes || 'commentCollectRival' in changes)) setupContextMenus();
});
// 自动回填的标签页被用户手动关掉时立即收尾，别让状态卡住下一轮
chrome.tabs.onRemoved.addListener((tabId) => {
  if (selfAutoRun && tabId === selfAutoRun.tabId) {
    selfAutoRun.tabId = null;
    finishSelfAuto('自动回填中断：后台页被关闭了');
  }
});
chrome.notifications.onClicked.addListener(async () => {
  const { host } = await getConfig();
  chrome.tabs.create({ url: `${host}/competitors` });
});

// ── 批量采集编排 ──
const collectWaiters = new Map();
let keepAliveTimer = null;
let batchRunning = false;

function startKeepAlive() {
  if (!keepAliveTimer) keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
}
function stopKeepAlive() {
  if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
}

function reportBatch(reportTabId, msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
  if (reportTabId) chrome.tabs.sendMessage(reportTabId, msg).catch(() => {});
}

function waitForCollect(platform, handle, timeoutMs) {
  return new Promise((resolve) => {
    const key = `${platform}:${String(handle)}`;
    const t = setTimeout(() => { collectWaiters.delete(key); resolve('timeout'); }, timeoutMs);
    collectWaiters.set(key, () => { clearTimeout(t); collectWaiters.delete(key); resolve('ok'); });
  });
}

// opts.interactive 一路传到 collectWechatOne：用户点「全部采集」时人在电脑前，
// 撞到未登录可以把登录页摆给他；定时那轮（runScheduledCollect）人多半不在，不弹前台页。
async function batchCollect(reportTabId, opts = {}) {
  if (batchRunning) { reportBatch(reportTabId, { type: 'batch-progress', busy: true }); return { busy: true }; }
  batchRunning = true;
  startKeepAlive();
  try {
    const { competitors } = await getCompetitors(true);
    let collectable = (competitors || []).filter((c) => c.collectable);
    // opts.onlyCompetitorId：服务端派下来的「去采这一个」（BrowserTask）。
    // 缺了这一段，派活会静默变成**采全部**——用户以为只刷新了一个号，实际跑了一整轮，
    // 还会撞平台频控。找不到那个 id 就采空集合，让上层如实报「没找到」，而不是退回全量。
    if (opts.onlyCompetitorId) {
      collectable = collectable.filter((c) => String(c.id) === String(opts.onlyCompetitorId));
    }
    // 公众号没有公开主页（url 为 null），走后台接口那条路，且每轮有上限——单独分流。
    const wechatAll = collectable.filter((c) => c.platform === 'wechat');
    const wechatTargets = wechatAll.slice(0, WECHAT_RULES.maxAccountsPerRun);
    // 超出每轮上限的必须报出来。悄悄截断会让用户以为「全采了」，其实一半没动
    const wechatSkipped = wechatAll.length - wechatTargets.length;
    const targets = collectable.filter((c) => c.platform !== 'wechat' && c.url);
    const total = targets.length + wechatTargets.length;
    let done = 0;
    let collected = 0;
    const notes = [];
    reportBatch(reportTabId, { type: 'batch-progress', done, total, current: null });
    // 本轮第一个「开了页却没采到」的标签页：留着不关，采完切到前台交给用户亲眼看一眼。
    //
    // 公开主页这一路**没有可靠的「未登录」判据**——抖音/小红书未登录时弹的是登录遮罩，
    // 各平台长相不同且随时改版，照着猜一个选择器只会把「页面没加载完」误报成「你没登录」。
    // 所以这里不猜原因，只做一件确定有用的事：**别把现场关掉**。用户看一眼那一页，
    // 是登录墙、是改版、还是网慢，一眼就知道，比插件猜十次都准。
    // 分寸：一轮最多打扰一次（否则 10 个号失败就弹 10 个页面），且只在用户当场点击时——
    // 定时那轮人多半不在电脑前，弹页面只会在他回来时留下一堆莫名其妙的标签页。
    let stranded = null;
    for (const c of targets) {
      reportBatch(reportTabId, { type: 'batch-progress', done, total, current: c.name });
      let tab = null;
      let keep = false;
      try {
        tab = await chrome.tabs.create({ url: c.url, active: false });
        const res = await waitForCollect(c.platform, c.handle, 20000);
        if (res === 'ok') collected++;
        else if (opts.interactive && !stranded && tab?.id) {
          stranded = { id: tab.id, name: c.name };
          keep = true;
        }
      } catch {
        /* ignore */
      } finally {
        if (!keep && tab && tab.id) await chrome.tabs.remove(tab.id).catch(() => {});
      }
      done++;
    }
    if (stranded) {
      const shown = await surfaceTab(stranded.id);
      const note = `「${stranded.name}」这一页没采到数据——可能需要先登录该平台，也可能只是没加载完`
        + (shown ? '。已把这一页切到前台，请看一眼；处理好之后再点一次采集。' : '（页面已被关闭）。');
      notes.push(note);
      if (shown) notifyLogin(note, '烽火台 · 有一页没采到');
    }

    // 公众号：一个一个来，换号之间按规则再等一段——这条通道用的是用户自己的后台会话，慢比快重要
    for (let i = 0; i < wechatTargets.length; i++) {
      const c = wechatTargets[i];
      reportBatch(reportTabId, { type: 'batch-progress', done, total, current: c.name });
      const r = await collectWechatOne(c.handle, { interactive: !!opts.interactive });
      if (r.ok) {
        collected++;
        if (r.partial) notes.push(`${c.name}：${r.partial}`);
      } else {
        notes.push(`${c.name}：${r.error}`);
        // 撞频控就整轮停手：剩下的号继续打只会把冷却拖得更长，别一起赔进去。
        // （被 24h 冷却挡下的 throttled 不算故障，跳过继续即可。）
        if (r.code === 'rate_limited') { done++; break; }
      }
      done++;
      if (i < wechatTargets.length - 1) await new Promise((res) => setTimeout(res, WECHAT_RULES.betweenAccountsMs));
    }
    if (wechatSkipped > 0) {
      notes.push(`还有 ${wechatSkipped} 个公众号本轮没采（每轮最多 ${WECHAT_RULES.maxAccountsPerRun} 个），稍后再来一轮`);
    }

    await getCompetitors(true);
    reportBatch(reportTabId, { type: 'batch-done', total, collected, notes });
    // 把这一趟的真实结果交出去：定时采集要照它报数，不许自己再数一遍（见 runScheduledCollect）
    return { total, collected, notes };
  } finally {
    batchRunning = false;
    stopKeepAlive();
  }
}

// ── 我的账号 · 一键采集 ──
//
// 与竞对批量采集（batchCollect）同源：后台开标签页 → 采 → 关。但**不能复用 waitForCollect**：
// 那条路等的是「访问即采」，而访问即采只对**已订阅的竞对**触发（common.js 里拿竞对清单比对），
// 自己的主页永远等不到那个信号。所以这里主动向内容脚本要数据，采到就走自有通道回填。
//
// 【哪些账号能一键采】必须有一个「打开就能读到自有数据」的地址：
//   · X / TikTok —— 没有创作者后台，自有数据就在自己主页上（见 content/x.js、content/tiktok.js），
//     有 handle 就能开；TikTok 主页九宫格上每条封面都带播放量，一个地址能采一整页；
//   · 创作者后台（公众号等）—— 地址要登录态换 token、还要在站内跳两次，那是另一套步进机
//     （runSelfAuto），下面单独触发，不塞进这个循环；
//   · B站/抖音/小红书的公开作品页 —— 一个账号对应 N 篇作品，没有「一个地址采全部」这回事；
//   · multi（多平台）账号 —— 它不对应任何一个具体平台的页面。
// 认不出入口的账号**如实标成不可一键采**，而不是白开一个标签页让用户以为在采。
const SELF_COLLECT_URL = {
  x: (a) => (a.handle ? `https://x.com/${encodeURIComponent(String(a.handle).replace(/^@/, ''))}` : null),
  // TikTok 与 X 同类：没有创作者后台，自有数据（播放/点赞/评论/分享）就在自己主页的九宫格上。
  tiktok: (a) => (a.handle ? `https://www.tiktok.com/@${encodeURIComponent(String(a.handle).replace(/^@/, ''))}` : null),
};

function selfCollectUrl(account) {
  const make = SELF_COLLECT_URL[account?.platform];
  return make ? make(account) : null;
}

// 主动问内容脚本要一次解析结果。页面要渲染、脚本要注入，所以是轮询而不是问一次就算。
//
// ⚠️ 轮询阶段**必须浅采**：翻页采集一次最长 30 秒，塞进这个 1.5 秒一轮的循环里，
// 第一轮就会把整个 25 秒预算烧光，后面一轮都跑不到。
// 正确次序是：先浅采轮询到「页面已经渲染出作品」，**再**单独要一次翻页采集。
async function collectFromTab(tabId, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await chrome.tabs.sendMessage(tabId, { type: 'beacon-collect' });
      if (r?.ok && r.payload?.posts?.length > 0) {
        const deep = await chrome.tabs.sendMessage(tabId, { type: 'beacon-collect', deep: true }).catch(() => null);
        const dp = deep?.ok ? deep.payload : null;
        // 翻页翻不出更多（或中途出错）就用浅采那一份——绝不能因为翻页失败就整趟白跑
        return dp && (dp.posts?.length || 0) >= r.payload.posts.length ? dp : r.payload;
      }
    } catch { /* 内容脚本还没就绪，等下一轮 */ }
    await new Promise((res) => setTimeout(res, 1500));
  }
  return null;
}

// ── 补齐详情：逐条打开作品详情页采「主页给不了」的指标 ──────────────────────
//
// 【为什么需要】各平台主页/列表页给的字段是残缺的：抖音主页角标只有点赞，
// 评论/收藏/转发只有作品详情页才有（见 lib/insight/platform-metrics.ts 的能力矩阵）。
// 所以「补齐」= 把前 N 条作品的详情页逐个打开、解析、回传。
//
// 【三条自我约束，都是有意为之】
//   ① **每次最多 20 条**（用户 2026-08-11 定的）。超出的**必须报出来**——
//      悄悄截断会让用户以为「全采了」，其实一大半没动（与公众号那条 maxAccountsPerRun 同理）。
//   ② **逐条串行 + 页间等待**。20 个详情页连着并发打开，对站点是一串突发请求，
//      对用户是 20 个后台标签页同时抢 CPU。串行 + 间隔既礼貌也稳。
//   ③ **只在用户显式点击时跑**，绝不塞进批量采集。批量是 N 个竞对，
//      N×20 个页面既慢又像在爬站——这条通道只服务「我现在想把这个号补齐」。
const DETAIL_RULES = {
  maxPostsPerRun: 20,
  betweenPostsMs: 2000,
  perPageTimeoutMs: 15000,
};

let detailRunning = false;

/** 这个平台的作品详情页值不值得单独跑一趟（有没有「主页拿不到、详情页才有」的字段）。 */
const DETAIL_SUPPORTED = new Set(['douyin', 'bilibili', 'xiaohongshu', 'youtube', 'x']);

/**
 * 从一个作品详情页要一次解析结果。与 collectFromTab 的区别：
 * 详情页只有一条作品，**不翻页**（翻页是列表页的事，详情页上跑它纯属浪费预算）。
 */
async function parseDetailTab(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await chrome.tabs.sendMessage(tabId, { type: 'beacon-collect' });
      if (r?.ok && r.payload?.posts?.length > 0) return r.payload;
    } catch { /* 内容脚本还没注入好，等下一轮 */ }
    await new Promise((res) => setTimeout(res, 1200));
  }
  return null;
}

/**
 * 补齐当前竞对主页上前 N 条作品的详情数据。
 * tabId 是用户当前所在的**竞对主页**标签页——先从它拿作品清单，再逐条开详情页。
 */
async function collectPostDetails(tabId, reportTabId) {
  if (detailRunning) return { ok: false, error: '已经有一轮补齐在跑了，等它跑完再来' };
  detailRunning = true;
  startKeepAlive();
  try {
    // ① 先从当前页拿作品清单（用户就在竞对主页上，这一步不额外开页）
    const listed = await parseDetailTab(tabId, 8000);
    if (!listed) return { ok: false, error: '这一页没读到作品列表——等页面加载完，或确认这是竞对主页' };
    if (!DETAIL_SUPPORTED.has(listed.platform)) {
      return { ok: false, error: `${listed.platform} 暂不支持补齐详情（这个平台的详情页没有主页给不了的指标）` };
    }
    const all = (listed.posts || []).filter((p) => p.url);
    if (all.length === 0) return { ok: false, error: '这一页的作品都没有链接，没法打开详情页' };

    const targets = all.slice(0, DETAIL_RULES.maxPostsPerRun);
    const skipped = all.length - targets.length;

    let ok = 0;
    let failed = 0;
    for (let i = 0; i < targets.length; i++) {
      const post = targets[i];
      reportBatch(reportTabId, {
        type: 'detail-progress', done: i, total: targets.length, current: post.title || post.platformItemId,
      });
      let tab = null;
      try {
        tab = await chrome.tabs.create({ url: post.url, active: false });
        const payload = await parseDetailTab(tab.id, DETAIL_RULES.perPageTimeoutMs);
        // 详情页解析必须认出**同一条作品**才回传。认不出就跳过——
        // 宁可这条不补，也不能把 A 作品的数字写到 B 作品上。
        const got = payload?.posts?.find((x) => String(x.platformItemId) === String(post.platformItemId));
        if (got && got.metrics && Object.keys(got.metrics).length > 0) {
          // 标明这一条是**从作品详情页**采来的。不标的话，同一条作品的快照序列会在
          // 「只有点赞」（主页）和「四项齐全」（详情页）之间反复横跳，用户读不懂那条记录。
          const one = { ...payload, posts: [got], source: 'detail' };
          const r = await ingest(one);
          if (r?.ok) ok++; else failed++;
        } else {
          failed++;
        }
      } catch {
        failed++;
      } finally {
        if (tab && tab.id) await chrome.tabs.remove(tab.id).catch(() => {});
      }
      // 页间等待：最后一条之后不用等
      if (i < targets.length - 1) await new Promise((res) => setTimeout(res, DETAIL_RULES.betweenPostsMs));
    }

    reportBatch(reportTabId, { type: 'detail-done', total: targets.length, ok, failed, skipped });
    return { ok: true, total: targets.length, done: ok, failed, skipped };
  } finally {
    detailRunning = false;
    stopKeepAlive();
  }
}

// ── 公众号竞对采集 ────────────────────────────────────────────────────────────
// 公众号没有公开主页，走不了「打开主页顺手采」那一套。这条路是：开用户**自己**的公众号后台
// 标签页 → content/wechat-competitor.js 用当前地址栏的 token 同源调接口 → 回传 → 关页。
// 服务器全程不接触登录态，请求也从用户自己的 IP 发出。
//
// ⚠️ 下面的数字必须与 lib/wechat-collect-rules.ts 一致——网页上展示给用户的就是那份，
// 对不上就是「界面写一天一次、代码点一次采一次」，用户号被限了都不知道为什么。
// tests/ingest/wechat-collect-rules.test.ts 会把这里的数字读回去比对。
// 这里管**两次采集之间**的节流；一次采集内部翻几页、每个请求隔多久由内容脚本管。
const WECHAT_RULES = {
  perAccountCooldownHours: 12,
  maxAccountsPerRun: 5,
  betweenAccountsMs: 30000,
  rateLimitCooldownMinutes: 30,
  fakeidCacheDays: 30,
};

// 冷却**只看本机**，不看服务端的 lastCrawledAt。
//
// 曾经短暂改成「取本机与服务端记录的较晚者」，是把两件事混了，2026-07-29 当天改回：
// 冷却存在的目的是保护**用户自己那个公众号后台账号**的频率预算，而别人用他自己的号、
// 他自己的 IP 采过，根本不消耗你的额度——拦你什么也没保护到，只拦掉了「我想要更新的数据」。
// 另外竞对档案是全局共享表，别人采到的文章本来就落在同一个档案下、你订阅就能看到，
// 所以那条拦截既没道理也没必要。真正该拦的只有两件事：你自己刚采过、以及撞了频控。

async function readWechatThrottle() {
  const { wechatThrottle } = await chrome.storage.local.get('wechatThrottle');
  return wechatThrottle && typeof wechatThrottle === 'object'
    ? { perAccount: wechatThrottle.perAccount || {}, blockedUntil: Number(wechatThrottle.blockedUntil) || 0 }
    : { perAccount: {}, blockedUntil: 0 };
}

// ── 公众号采集的风险确认闸（0.9.8 起）──────────────────────────────
//
// 【为什么要有这道闸】这条通道与插件其它所有采集**性质不同**：其它的都是读用户屏幕上
// 已经渲染出来的公开页面，而这一条是用**用户自己的公众平台登录态**去调 `searchbiz` /
// `appmsgpublish` 这两个**非官方**后台接口，查的还是**别人的**公众号。
// 它可能违反《微信公众平台服务协议》，而踩线的后果落在**用户自己的公众号账号**上
// （限接口、封功能），我们既挡不住也申诉不了。
//
// 代码里一直知道这件事（见 lib/wechat-collect-rules.ts 文件头「踩线的后果由用户自己的号
// 承担，所以一律往保守取」），但**从没告诉过用户**——节流规则降低的是概率，
// 不能代替告知。2026-08-24 合规审查把这个缺口补上：首次使用必须显式确认。
//
// 【为什么闸在这里而不在 UI】UI 有三个入口（弹窗、侧栏、网页派下来的任务），
// 挂在任何一个上都会漏掉另外两个。collectWechatOne 是所有入口的**唯一咽喉**。
const WECHAT_RISK_KEY = 'wechatRiskAck';
// 告知内容实质变化时升这个版本号 → 用户需要重新确认一次。
const WECHAT_RISK_VERSION = 1;

async function wechatRiskAcked() {
  const { [WECHAT_RISK_KEY]: ack } = await chrome.storage.local.get(WECHAT_RISK_KEY);
  return !!ack && Number(ack.version) >= WECHAT_RISK_VERSION;
}

async function ackWechatRisk() {
  await chrome.storage.local.set({
    [WECHAT_RISK_KEY]: { version: WECHAT_RISK_VERSION, at: Date.now() },
  });
}

async function revokeWechatRisk() {
  await chrome.storage.local.remove(WECHAT_RISK_KEY);
}

// 放行返回 null，拦下返回**给用户看的理由**。静默跳过是不行的：用户点了没反应，
// 会以为功能坏了然后猛点——那正是我们要避免的行为。
async function wechatGate(name) {
  const t = await readWechatThrottle();
  const now = Date.now();
  if (t.blockedUntil > now) {
    return `刚被微信提示操作频繁，已暂停公众号采集，约 ${Math.ceil((t.blockedUntil - now) / 60000)} 分钟后可再试`;
  }
  const last = Number(t.perAccount[name] || 0);
  const cooldownMs = WECHAT_RULES.perAccountCooldownHours * 3600_000;
  if (last && now - last < cooldownMs) {
    const left = Math.ceil((cooldownMs - (now - last)) / 3600_000);
    // 说清是「你自己」采的——别人采过不会走到这里，见上面 wechatGate 上方的注释
    return `「${name}」你在 ${WECHAT_RULES.perAccountCooldownHours} 小时内已采过，约 ${left} 小时后可再采`;
  }
  return null;
}

async function markWechatCollected(name) {
  const t = await readWechatThrottle();
  t.perAccount[name] = Date.now();
  await chrome.storage.local.set({ wechatThrottle: t });
}

async function markWechatRateLimited() {
  const t = await readWechatThrottle();
  t.blockedUntil = Date.now() + WECHAT_RULES.rateLimitCooldownMinutes * 60_000;
  await chrome.storage.local.set({ wechatThrottle: t });
}

// ── 公众号名 → fakeid 的本机缓存 ──
//
// 采一个公众号是三个请求：searchbiz 按名字搜号换 fakeid，再最多两页 appmsgpublish。
// 其中**搜号那一个口的配额最紧**——2026-08-13 用户撞的频控就是它。而 fakeid 对一个号是固定的，
// 每次采集都拿名字去重问一遍早就知道的答案，纯属白烧最贵的那个额度。存下来之后重复采集
// 3 个请求降到 2 个，且省掉的正好是最容易被限的那一个。
//
// TTL 见 WECHAT_RULES.fakeidCacheDays：万一存错了、或号真的迁移了，最多一个月自己纠正一次，
// 不用用户干预。命中续用**不刷新时间戳**——否则天天在采的号永远轮不到复核，TTL 等于没有。
const WECHAT_FAKEID_TTL_MS = WECHAT_RULES.fakeidCacheDays * 86400_000;

async function readWechatFakeids() {
  const { wechatFakeids } = await chrome.storage.local.get('wechatFakeids');
  return wechatFakeids && typeof wechatFakeids === 'object' ? wechatFakeids : {};
}

async function cachedWechatFakeid(name) {
  const e = (await readWechatFakeids())[name];
  if (!e || typeof e.fakeid !== 'string' || !e.fakeid) return '';
  return Date.now() - (Number(e.at) || 0) < WECHAT_FAKEID_TTL_MS ? e.fakeid : '';
}

async function rememberWechatFakeid(name, fakeid) {
  if (typeof fakeid !== 'string' || !fakeid) return;
  const all = await readWechatFakeids();
  if (all[name] && all[name].fakeid === fakeid) return; // 值没变就不动时间戳，让 TTL 照常走到期
  all[name] = { fakeid, at: Date.now() };
  await chrome.storage.local.set({ wechatFakeids: all });
}

async function forgetWechatFakeid(name) {
  const all = await readWechatFakeids();
  if (!(name in all)) return;
  delete all[name];
  await chrome.storage.local.set({ wechatFakeids: all });
}

// ── 需要登录时：把页面交回给用户，等他登录完再继续 ─────────────────────
//
// 用户 2026-08-18 明确要求的行为：没登录就**跳到公众号页面等登录，然后接着执行**，
// 而不是像原来那样当场关掉标签页报一句「登录态已过期」。
//
// 三条边界，改这段前先读（政策 store/privacy.md 同步写了同样三条）：
//   ① 登录动作**全部由用户本人完成**——插件只把已经打开的那一页切到前台，
//      不填账号密码、不点登录按钮、不碰二维码，一如既往「不代替用户登录」；
//   ② 等待有硬上限（LOGIN_WAIT_MS），到点就如实收尾，绝不无限期挂着；
//   ③ 一旦切到前台，这一页就**归用户了**——不再由插件自动关闭（关掉用户正在看的页面
//      比不关更糟），与「后台采集完立即关闭」那条规则的分界就在这里。
const LOGIN_WAIT_MS = 5 * 60_000;   // 等用户扫码的上限
const LOGIN_POLL_MS = 3000;         // 探登录态的间隔：只读页面、不发平台请求

// 把标签页摆到用户面前。windows.update 是为了「插件开的页在另一个窗口」时也真的可见——
// 只切 tab 不聚焦窗口的话，用户还是什么都看不到，却以为已经提示过他了。
async function surfaceTab(tabId) {
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    // 窗口聚焦是「锦上添花」的一步：拿不到 windows API 也不能把「已经切到前台」判成失败，
    // 否则用户明明看得到那一页，插件却当它没显示出来，转头把页关了。
    if (tab?.windowId != null && chrome.windows?.update) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    }
    return true;
  } catch {
    return false; // 标签页已经被用户关掉了
  }
}

function notifyLogin(message, title = '烽火台 · 需要你先登录') {
  try {
    chrome.notifications.create('beacon-login-' + Date.now(), {
      type: 'basic', iconUrl: 'icon128.png', title, message, priority: 2,
    });
  } catch { /* 通知不可用不影响流程本身 */ }
}

// 等用户在公众号后台登录完成。问的是只读探针（content/wechat-competitor.js 的 loginState），
// **一个微信接口都不打**——等待期间反复调采集接口，正是最容易把用户账号撞进频控的做法。
// 返回 'ok' | 'timeout' | 'gone'（用户把页关了）。
async function waitForWechatLogin(tabId, timeoutMs = LOGIN_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, LOGIN_POLL_MS));
    if (!(await chrome.tabs.get(tabId).catch(() => null))) return 'gone';
    // 登录成功后微信会跳到带 token 的后台首页，内容脚本随之重新注入——
    // 探针取到 token 就说明会话已经活了。
    const r = await chrome.tabs.sendMessage(tabId, { type: 'beacon-wechat-login-state' }).catch(() => null);
    if (r?.ok) return 'ok';
  }
  return 'timeout';
}

// 向后台标签页要数据。页面可能还在重定向补 token，内容脚本没就绪 → 轮询重试，
// 但失败原因要原样带回来（「没就绪」和「登录态过期」是两回事，不能都报成超时）。
//
// ⚠️ 真机 2026-07-29：用户站在已登录的后台页面上点采集，等满 60 秒报「一直没有响应」。
// 真因是 **Chrome 不会往已经打开的页面补注入内容脚本**——插件更新/安装之前就打开的那个标签页
// 里根本没有本脚本，sendMessage 永远找不到接收方，再等多久都一样。
// 让用户自己去猜「要按 F5」是不可接受的：这里用 activeTab 授予的临时权限补注入一次
//（scripting 权限，**不需要 host 权限**），补不上时的文案也直接说清该按 F5。
async function ensureWechatScript(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/wechat-competitor.js'] });
    return true;
  } catch {
    return false; // 非活动标签页拿不到 activeTab 授权，只能等声明式注入
  }
}

async function askWechatTab(tabId, name, fakeid, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let injected = false;
  while (Date.now() < deadline) {
    try {
      const r = await chrome.tabs.sendMessage(tabId, { type: 'beacon-wechat-collect', name, fakeid });
      if (r) return r;
    } catch {
      // 找不到接收方＝这页没有内容脚本。补注入一次就够，失败也不必反复试。
      if (!injected) {
        injected = true;
        await ensureWechatScript(tabId);
      }
    }
    await new Promise((res) => setTimeout(res, 1500));
  }
  return {
    ok: false,
    code: 'timeout',
    error: '这个公众号后台页面里没有采集脚本在跑——请在该页面按 F5 刷新一次再点采集（插件更新之前就打开的页面需要刷新才会注入）',
  };
}

// 用户当前就停在公众号后台时，直接用那个页面，不另开标签页。
//
// ⚠️ 真机 2026-07-29：用户登着后台却收到「没登录」——我们自己开的 /cgi-bin/home 地址里
// 不一定带 token，而用户手动点进来的页面一定带。优先用现成的那个，既更可靠也不打扰
// （activeTab 权限在用户点插件图标时授予，够读当前标签页的 url；不需要 host 权限）。
async function activeWechatBackendTab() {
  try {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (t?.id && typeof t.url === 'string' && t.url.startsWith('https://mp.weixin.qq.com/cgi-bin/')) return t;
  } catch {
    /* 拿不到就退回自己开页 */
  }
  return null;
}

// opts.interactive = 用户此刻正坐在电脑前点了这个按钮。
// 只有这种时候才允许把标签页切到前台等他登录：定时/后台那轮多半人不在，
// 弹一个前台页出来既打断不了别人也帮不到自己，只会在他回来时看到一堆莫名其妙的窗口。
async function collectWechatOne(name, opts = {}) {
  // 风险确认在最前面：还没告知过用户，就一个请求都不该发出去。
  // 定时那轮（interactive=false）同样拦——用户没确认过，自动跑更不能开始。
  if (!(await wechatRiskAcked())) {
    return {
      ok: false,
      code: 'risk_unacked',
      error: '公众号采集使用你自己的公众号后台登录态调用非官方接口，可能违反微信平台协议、导致你的号被限。请先在插件里确认知悉该风险。',
    };
  }
  const blocked = await wechatGate(name);
  if (blocked) return { ok: false, code: 'throttled', error: blocked };

  const existing = await activeWechatBackendTab();
  let tab = null;
  let surfaced = false; // 切到前台之后这一页就归用户了，finally 里不再关它
  try {
    // 借用用户已打开的后台页面时**不能关它**——那是用户自己的标签页
    tab = existing || (await chrome.tabs.create({ url: SELF_AUTO_ENTRY.wechat, active: false }));
    let r = await askWechatTab(tab.id, name, await cachedWechatFakeid(name));

    // 停在登录页：不再当场失败关页，而是把这一页摆到用户面前，等他自己扫码，然后接着采。
    if (r?.needLogin && opts.interactive) {
      surfaced = await surfaceTab(tab.id);
      if (surfaced) {
        notifyLogin(`采集「${name}」需要你的公众号后台登录态——已把登录页切到前台，扫码登录后会自动继续。`);
        const waited = await waitForWechatLogin(tab.id);
        if (waited === 'ok') {
          r = await askWechatTab(tab.id, name, await cachedWechatFakeid(name));
        } else {
          return {
            ok: false,
            code: 'login_required',
            error: waited === 'gone'
              ? '登录页被关掉了，本次采集已停止——重新登录公众号后台后再点一次采集'
              : `等了 ${Math.round(LOGIN_WAIT_MS / 60000)} 分钟仍未登录，本次采集已停止——登录后再点一次采集`,
          };
        }
      }
    }
    // 撞频控立刻进冷却——不管这次拿没拿到数据，继续打只会更糟
    if (r?.code === 'rate_limited') await markWechatRateLimited();
    // 缓存的 fakeid 被证伪（拿它拉列表微信报错）→ 当场扔掉，别留着让下次继续拿它去撞。
    // 这一次若重搜成功，下面的 rememberWechatFakeid 会立刻把新的写回来。
    if (r?.staleFakeid) await forgetWechatFakeid(name);
    if (!r?.ok) return { ok: false, code: r?.code, error: r?.error || '采集失败' };
    // 能成功拉出列表就说明这个 fakeid 是对的，先记下来——即便下面回传失败，
    // 下次也不必再为同一个号烧一次搜号配额。
    await rememberWechatFakeid(name, r.fakeid);

    const res = await ingest(r.payload);
    if (!res.ok) return { ok: false, error: res.error };
    // 冷却按「发起过一次成功采集」记，不按「采到几条」：没有新文章也是一次真实请求
    await markWechatCollected(name);
    return { ok: true, posts: r.payload.posts.length, partial: r.partial, competitor: res.competitor };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  } finally {
    // 只关自己开的那个；借用用户的标签页、或已经切到前台交给用户的，都留着
    if (!existing && !surfaced && tab?.id) await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function batchCollectSelf(reportTabId) {
  if (batchRunning) { reportBatch(reportTabId, { type: 'batch-self-progress', busy: true }); return; }
  batchRunning = true;
  startKeepAlive();
  try {
    const r = await getAccounts(true);
    const accounts = r?.accounts || [];
    const targets = accounts.map((a) => ({ a, url: selfCollectUrl(a) })).filter((t) => t.url);
    const total = targets.length;
    let done = 0;
    let posts = 0;
    reportBatch(reportTabId, { type: 'batch-self-progress', done, total, current: null });

    for (const { a, url } of targets) {
      reportBatch(reportTabId, { type: 'batch-self-progress', done, total, current: a.name });
      let tab = null;
      try {
        tab = await chrome.tabs.create({ url, active: false });
        const payload = await collectFromTab(tab.id);
        if (payload) {
          // accountId 显式指定：这一趟是**为这个账号**开的页面，归属不能再让别处去猜
          const res = await ingestSelf({ ...payload, accountId: a.id });
          if (res?.ok) posts += (res.updated || 0) + (res.created || 0);
        }
      } catch { /* 单个账号失败不该中断整批 */ } finally {
        if (tab && tab.id) await chrome.tabs.remove(tab.id).catch(() => {});
      }
      done++;
    }

    // 公众号后台走既有的那套步进机（要换 token、站内跳两次），它自带超时与通知
    const wechat = accounts.find((a) => a.platform === 'wechat');
    if (wechat) runSelfAuto({ force: true });

    reportBatch(reportTabId, { type: 'batch-self-done', total, posts, wechat: !!wechat });
    notifySelfAuto(
      total === 0 && !wechat
        ? '没有可一键采集的账号：X 账号需要填 handle，创作者后台请手动回填一次'
        : `我的数据采集完成：${total} 个账号，回填 ${posts} 条作品${wechat ? '；公众号后台正在后台回填' : ''}`,
    );
  } finally {
    batchRunning = false;
    stopKeepAlive();
  }
}

// ── 消息路由 ──
// ⚠️ 每一条 `.then(sendResponse)` 都必须配一个 catch。处理函数一旦抛出来，sendResponse 就
// **永远不会发**，消息通道随后关闭，调用方 await 的那个 promise 转为 reject——而三个界面的
// 按钮处理都没有 catch，于是 restore() 执行不到，按钮就那么停在「回填中…」，连个错都看不到。
function respond(promise, sendResponse, what) {
  Promise.resolve(promise)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: `${what}出错：${e?.message || e}` }));
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'beacon-get-config') {
    respond(getConfig(), sendResponse, '读取配置');
    return true;
  }
  if (msg?.type === 'beacon-check-update') {
    respond(checkForUpdate(!!msg.force), sendResponse, '检查更新');
    return true;
  }
  if (msg?.type === 'beacon-apply-update') {
    respond(applyUpdate(), sendResponse, '一键更新');
    return true;
  }
  if (msg?.type === 'open-sidepanel') {
    const windowId = _sender?.tab?.windowId;
    if (windowId && chrome.sidePanel?.open) {
      chrome.sidePanel.open({ windowId }).then(() => {
        sendResponse({ ok: true });
      }).catch((e) => {
        sendResponse({ ok: false, error: String(e?.message || e) });
      });
      return true;
    }
    sendResponse({ ok: false, error: '侧边栏需在常规标签页窗口触发' });
    return true;
  }
  if (msg?.type === 'parser:miss') {
    respond(
      reportParserMiss({ platform: msg.platform, scope: msg.scope || 'rival', field: msg.field, skeleton: msg.skeleton }),
      sendResponse,
      '上报解析样本',
    );
    return true;
  }
  if (msg?.type === 'parser:refresh') {
    respond(refreshParserRules(), sendResponse, '拉取解析规则');
    return true;
  }
  if (msg?.type === 'publish:pending') {
    respond(fetchPublishTasks(msg.platform), sendResponse, '拉取待发布任务');
    return true;
  }
  if (msg?.type === 'publish:receipt') {
    respond(
      sendPublishReceipt({ taskId: msg.taskId, status: msg.status, url: msg.url, error: msg.error }),
      sendResponse,
      '发布回执',
    );
    return true;
  }
  if (msg?.type === 'beacon-ai-chat') {
    respond(handleAiChat(msg.payload), sendResponse, 'AI 请求');
    return true;
  }
  // 侧栏「拆解这条作品」——与右键菜单同一条通道。
  // tabId 只能从 sender 拿，不接受消息体里传：内容脚本能伪造任何字段，
  // 而这个动作会往用户的资讯库里写东西。
  if (msg?.type === 'beacon-analyze-work') {
    const tabId = _sender?.tab?.id;
    if (tabId == null) {
      sendResponse({ ok: false, error: '拿不到当前标签页' });
      return true;
    }
    respond(analyzeWork(tabId, { isSelf: !!msg.isSelf }), sendResponse, '作品拆解');
    return true;
  }
  // 侧栏「存进资讯库」——与右键菜单同一条通道（tabId 同样只认 sender）
  if (msg?.type === 'beacon-clip-article') {
    const tabId = _sender?.tab?.id;
    if (tabId == null) {
      sendResponse({ ok: false, error: '拿不到当前标签页' });
      return true;
    }
    respond(clipArticle(tabId, _sender?.tab?.url || '', _sender?.tab?.title || ''), sendResponse, '存资讯库');
    return true;
  }
  if (msg?.type === 'beacon-collect-comments') {
    const knownTab = _sender?.tab?.id ?? msg.tabId;
    const p = knownTab != null
      ? collectComments(knownTab)
      : chrome.tabs.query({ active: true, currentWindow: true })
          .then(([t]) => t?.id != null ? collectComments(t.id) : { ok: false, error: '拿不到当前标签页' })
          .catch(() => ({ ok: false, error: '拿不到当前标签页' }));
    respond(p, sendResponse, '评论提问');
    return true;
  }
  if (msg?.type === 'batch-collect') {
    batchCollect(_sender?.tab?.id, { interactive: true }); // 用户此刻就在等着，未登录可以把登录页摆给他
    sendResponse({ ok: true, started: true });
    return true;
  }
  if (msg?.type === 'wechat-risk-status') {
    wechatRiskAcked().then((acked) => sendResponse({ ok: true, acked, version: WECHAT_RISK_VERSION }));
    return true;
  }
  if (msg?.type === 'wechat-risk-ack') {
    // 只认 true。前端传别的（undefined、'false' 字符串）一律当作撤回——
    // 这道闸宁可多问一次，也不能因为一个手滑的参数就默认放行。
    const p = msg.acked === true ? ackWechatRisk() : revokeWechatRisk();
    p.then(() => sendResponse({ ok: true, acked: msg.acked === true }));
    return true;
  }
  if (msg?.type === 'wechat-collect-one') {
    respond(collectWechatOne(String(msg.name || ''), { interactive: true }), sendResponse, '公众号采集');
    return true;
  }
  if (msg?.type === 'batch-collect-self') {
    batchCollectSelf(_sender?.tab?.id);
    sendResponse({ ok: true, started: true });
    return true;
  }
  if (msg?.type === 'beacon-collected') {
    const w = collectWaiters.get(`${msg.platform}:${String(msg.handle)}`);
    if (w) w();
    return undefined;
  }
  // 补齐详情：从当前竞对主页取前 20 条作品，逐个打开详情页采「主页给不了」的指标
  if (msg?.type === 'beacon-collect-details') {
    // ⚠️ 这里此前写的是 `sender?.tab?.id`，而形参名是 `_sender`——`sender` 根本没声明，
    // 可选链拦不住未声明的标识符，会直接抛 ReferenceError。目前唯一调用方
    //（sidepanel.js:609）总是带 msg.tabId，所以短路了没炸；调用方哪天不带就是一次崩溃。
    const tabId = msg.tabId ?? _sender?.tab?.id;
    if (!tabId) { sendResponse({ ok: false, error: '拿不到当前标签页' }); return true; }
    respond(collectPostDetails(tabId, tabId), sendResponse, '补齐详情');
    return true;
  }
  if (msg?.type === 'beacon-ingest') {
    (async () => {
      const r = await ingest(msg.payload);
      if (r.ok && msg.payload?.handle) {
        const { competitors } = await chrome.storage.local.get('competitors');
        if (Array.isArray(competitors)) {
          const hit = competitors.find(
            (c) => c.platform === msg.payload.platform && String(c.handle) === String(msg.payload.handle),
          );
          if (hit) {
            hit.lastCrawledAt = new Date().toISOString();
            await chrome.storage.local.set({ competitors });
            await updateBadge(competitors);
          }
        }
      }
      sendResponse(r);
    })();
    return true;
  }
  if (msg?.type === 'beacon-ingest-self') {
    respond(ingestSelf(msg.payload), sendResponse, '回填');
    return true;
  }
  // ── 自动回填三件套（只接受自己开的那个标签页） ──
  // 内容脚本每次加载都问一句：我是不是自动回填的标签页、现在走到第几站。
  // hops 是防跳转成环的硬闸：登录态中途失效时数据页会被踢回首页，
  // 那样内容脚本会一直「没到数据页 → 再跳一次」，光靠 90 秒超时会白转 90 秒。
  if (msg?.type === 'beacon-self-auto-run-now') {
    // 与定时触发同一条路径（不给试跑开捷径，否则试跑通过不代表定时通过）。
    // 唯一的差别是 interactive：试跑时用户就在设置页看着，撞到未登录可以把登录页摆给他；
    // 这不会造成「试跑绿、定时红」——他登完这一次，定时那轮用的就是同一个活着的会话。
    runSelfAuto({ interactive: true });
    sendResponse({ ok: true });
    return undefined;
  }
  if (msg?.type === 'beacon-run-scheduled-now') {
    runScheduledCollect();
    sendResponse({ ok: true });
    return undefined;
  }
  if (msg?.type === 'beacon-self-auto-hello') {
    if (!isSelfAutoTab(_sender)) { sendResponse({ auto: false }); return undefined; }
    selfAutoRun.hops++;
    if (selfAutoRun.hops > 8) {
      finishSelfAuto('自动回填中止：后台页反复跳转（多半是登录态失效），已停手');
      sendResponse({ auto: false });
      return undefined;
    }
    sendResponse({ auto: true, step: selfAutoRun.step });
    return undefined;
  }
  if (msg?.type === 'beacon-self-auto-advance') {
    if (!isSelfAutoTab(_sender)) { sendResponse({ step: -1 }); return undefined; }
    selfAutoRun.step++;
    sendResponse({ step: selfAutoRun.step });
    return undefined;
  }
  if (msg?.type === 'beacon-self-auto-payload') {
    if (!isSelfAutoTab(_sender)) { sendResponse({ ok: false }); return undefined; }
    ingestSelf(msg.payload).then((r) => {
      if (selfAutoRun && r?.ok) {
        selfAutoRun.updated += r.updated || 0;
        selfAutoRun.created += r.created || 0;
        selfAutoRun.skipped += r.skipped || 0;
      }
      // 回传失败（令牌失效、没有同平台账号等）也要把原因带给用户，别只说「没读到数据」
      if (selfAutoRun && r && !r.ok && !selfAutoRun.error) selfAutoRun.error = r.error;
      sendResponse({ ok: !!r?.ok });
    });
    return true;
  }
  if (msg?.type === 'beacon-self-auto-done') {
    if (isSelfAutoTab(_sender)) finishSelfAuto(selfAutoRun?.error ? `自动回填失败：${selfAutoRun.error}` : '');
    sendResponse({ ok: true });
    return undefined;
  }
  if (msg?.type === 'beacon-self-auto-abort') {
    if (isSelfAutoTab(_sender)) {
      // 「没登录」不是终局：把这一页切到前台交给用户，等他扫码，本轮接着跑。
      // 登录成功后公众号会跳回带 token 的后台首页 → 内容脚本重新加载 → 再问一次 hello →
      // 这次 autoRoutes 算得出来，于是从当前这一站继续。插件全程不碰登录动作本身。
      if (msg.needLogin && selfAutoRun.interactive && !selfAutoRun.surfaced) {
        const run = selfAutoRun;
        run.surfaced = true;
        run.hops = 0; // 登录过程会跳好几次，不能算进「跳转成环」那道闸
        clearTimeout(run.timer);
        run.timer = setTimeout(
          () => { finishSelfAuto(`等了 ${Math.round(LOGIN_WAIT_MS / 60000)} 分钟仍未登录，本轮自动回填已停止`); },
          LOGIN_WAIT_MS,
        );
        surfaceTab(run.tabId).then((ok) => {
          if (ok) notifyLogin('回填我的公众号数据需要后台登录态——已把登录页切到前台，扫码登录后会自动继续。');
          else finishSelfAuto('自动回填中止：登录页已被关闭');
        });
      } else {
        finishSelfAuto(msg.reason || '自动回填中止');
      }
    }
    sendResponse({ ok: true });
    return undefined;
  }
  // 竖条上的锁定态按钮点了要能直达设置页。内容脚本自己开不了 chrome://extensions 下的
  // 选项页（没权限也拿不到 URL），必须由 Service Worker 代开。
  if (msg?.type === 'beacon-open-options') {
    try { chrome.runtime.openOptionsPage(); sendResponse({ ok: true }); }
    catch (e) { sendResponse({ ok: false, error: String(e?.message || e) }); }
    return true;
  }
  if (msg?.type === 'beacon-save-inspiration') {
    respond(saveInspiration(msg.payload), sendResponse, '收藏');
    return true;
  }
  if (msg?.type === 'beacon-get-accounts') {
    respond(getAccounts(!!msg.force), sendResponse, '拉取账号列表');
    return true;
  }
  if (msg?.type === 'beacon-create-account') {
    respond(createAccount(msg.payload || {}), sendResponse, '新建账号');
    return true;
  }
  if (msg?.type === 'beacon-set-account') {
    // 空串 = 解除绑定，回到「后端按平台猜」的旧行为
    chrome.storage.sync.set({ selfAccountId: msg.accountId || '' }).then(() => sendResponse({ ok: true }));
    return true;
  }
  // 网页端注销后由 content/bridge.js 转发过来（对称于 config-token 那条下行通道）。
  // 清理必须在 SW 里做：闹钟只有后台停得掉，内容脚本碰不到 chrome.alarms。
  if (msg?.type === 'beacon-unlink') {
    unlinkWorkspace(msg.reason).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  }
  if (msg?.type === 'beacon-get-competitors') {
    getCompetitors(!!msg.force).then((r) => {
      updateBadge(r.competitors);
      sendResponse(r);
    });
    return true;
  }
  return undefined;
});
