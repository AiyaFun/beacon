// 公众号竞对采集（在用户自己的公众号后台页面里跑）。
//
// 为什么是这条路：公众号没有公开网页主页，插件采不到；而后台「写文章→超链接→查找文章」那套
// 接口本来就能搜任意公众号的图文列表。我们只是用**用户自己已经登录的后台会话**、以同源请求
// 调同样两个接口——服务器全程不接触任何登录态，请求也从用户自己的 IP 发出。
//
// 与 self-backend.js 的区别：那个读**自己**的后台页面（抓 DOM），这个调**接口**拿别人的公开
// 图文列表（JSON）。接口比 DOM 稳（微信改类名不影响），但也因此更要克制——见下面的节流。
//
// 合规边界（与 lib/ingest/wechat-export.ts 同一套）：
//   · 只取标题/链接/发布时间，**不取阅读量/在看**（那要抓包截取微信客户端凭证，是灰色通道）；
//   · token 只从当前地址栏取、只用于这一次同源请求，不存储、不上传、不进日志；
//   · 用户主动触发，非后台常驻轮询。
//
// ⚠️ 数字必须与 lib/wechat-collect-rules.ts 一致，改一处两处都要改
//    （tests/ingest/wechat-collect-rules.test.ts 会把这里的数字读回去比对）。
(() => {
  // sw.js 在「页面里没有内容脚本」时会用 scripting.executeScript 补注入一次（见 ensureWechatScript）。
  // 若本来就在跑，补注入会让整段再执行一遍、挂上第二个 onMessage 监听器——两个监听器抢同一个
  // sendResponse，行为难以预测。已在跑就直接退出。
  if (globalThis.__beaconWechatCompetitor) return;

  const RULES = {
    maxPages: 2,
    pageSize: 10,
    recentDays: 7,
    minGapMs: 3000,
    maxGapMs: 6000,
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 间隔取随机而不是固定值：固定 3 秒是一条太整齐的机器指纹，随机更像人在点。
  const gap = () => RULES.minGapMs + Math.floor(Math.random() * (RULES.maxGapMs - RULES.minGapMs + 1));

  // token 的三个来源，按可靠性递降。
  //
  // ⚠️ 真机 2026-07-29：用户明明登着后台，却报「当前页面没有登录态」——因为只读了地址栏。
  // 插件自己开的 `/cgi-bin/home` **不保证**会把 token 补进地址（用户手动点进来的页面才一定带），
  // 于是「地址栏没有 token」被当成了「没登录」。这两件事必须分开判断：页面渲染出来的菜单链接
  // 里到处都是 token=，能取到就说明会话是活的。
  function readToken() {
    // 1) 地址栏（用户手动导航来的页面一定有）
    try {
      const t = new URL(location.href).searchParams.get('token');
      if (/^\d+$/.test(t || '')) return t;
    } catch {
      /* 地址不合法就往下找 */
    }
    // 2) 页面里任意一条带 token= 的链接（后台的侧边菜单、顶栏都是）
    for (const a of document.querySelectorAll('a[href*="token="]')) {
      const m = /[?&]token=(\d{6,12})\b/.exec(a.getAttribute('href') || '');
      if (m) return m[1];
    }
    // 3) 内联脚本里的 token（后台把它写在 cgiData 里）。内容脚本读不到页面的 JS 变量
    //    （隔离世界），但读得到 <script> 的文本——这是同一份数据的可达形态。
    for (const s of document.querySelectorAll('script:not([src])')) {
      const m = /\btoken\s*[:=]\s*["']?(\d{6,12})\b/.exec(s.textContent || '');
      if (m) return m[1];
    }
    return '';
  }

  // 拿不到 token 时，「没登录」和「登录了但这页取不到」要说成两件事——
  // 前者要用户去扫码，后者要用户换一个后台页面再点，指错方向就是让人白折腾。
  function noTokenReason() {
    const onLoginPage = /\/cgi-bin\/(loginpage|bizlogin)/.test(location.pathname)
      || !!document.querySelector('.login__type__container, .login_container, #headimg_qrcode');
    return onLoginPage
      ? '公众号后台未登录（当前停在登录页），请先扫码登录后再采集'
      : '这个页面上取不到后台 token——请打开公众号后台首页（左侧菜单可见的任意页面）后，在那个页面上再点一次采集';
  }

  async function mpGet(path, params, token) {
    const qs = new URLSearchParams({ ...params, token, lang: 'zh_CN', f: 'json', ajax: '1' });
    const res = await fetch(`${path}?${qs}`, { credentials: 'include' });
    return res.json();
  }

  // 微信的错误码分三类，处理方式完全不同：
  //   200003 = 登录态过期 → 让用户重新登录，重试没有意义
  //   频控    → 立刻停手并进入冷却（由 sw.js 记时），继续打只会更糟
  //   其他    → 如实报错
  function classify(baseResp) {
    const ret = baseResp?.ret;
    const msg = String(baseResp?.err_msg || '');
    if (ret === 0) return null;
    if (ret === 200003) return { code: 'session_expired', error: '公众号后台登录态已过期，请重新登录后再采集' };
    if (ret === 200013 || /freq|频繁|frequen/i.test(msg)) {
      return { code: 'rate_limited', error: '微信提示操作过于频繁，已停止采集（稍后再试）' };
    }
    return { code: 'mp_error', error: `微信接口返回 ${ret}${msg ? `：${msg}` : ''}` };
  }

  // 按名字搜号 → fakeid。**只认完全同名**：同名/近似名的号很多，猜错就会把别人的文章
  // 记到这个竞对名下（同 lib/ingest 那条「定不出身份就丢弃」的规矩）。搜不到就把候选名报回去，
  // 让用户自己改成后台里显示的准确名字。
  async function resolveFakeid(name, token) {
    const data = await mpGet('/cgi-bin/searchbiz', { action: 'search_biz', begin: '0', count: '5', query: name }, token);
    const bad = classify(data.base_resp);
    if (bad) return bad;
    const list = Array.isArray(data.list) ? data.list : [];
    const hit = list.find((x) => String(x.nickname || '').trim() === String(name).trim());
    if (!hit) {
      return {
        code: 'not_found',
        error: list.length
          ? `没搜到完全同名的公众号「${name}」。后台搜到的是：${list.map((x) => x.nickname).join('、')}——请把竞对名字改成其中之一`
          : `后台搜不到公众号「${name}」`,
      };
    }
    return { fakeid: hit.fakeid, nickname: hit.nickname };
  }

  // 一条图文 → 入库条目。口径与 lib/ingest/wechat-export.ts 完全一致：
  // platformItemId = aid（形如 <appmsgid>_<itemidx>），对齐官方内容分析接口的 msgid+index。
  // 有意不给 metrics：这条通道没有互动数据，无 metrics 的条目不会覆盖已有指标。
  function mapArticle(m) {
    const idx = Number.isFinite(Number(m.itemidx)) ? Number(m.itemidx) : 1;
    const id = /^\d+_\d+$/.test(String(m.aid || ''))
      ? String(m.aid)
      : (Number.isFinite(Number(m.appmsgid)) ? `${Number(m.appmsgid)}_${idx}` : '');
    const title = String(m.title || '').trim();
    if (!id || !title) return null;
    const ts = Number(m.create_time || m.update_time);
    const out = { platformItemId: id.slice(0, 128), title: title.slice(0, 300) };
    if (typeof m.link === 'string' && /^https?:\/\//.test(m.link) && m.link.length <= 500) out.url = m.link;
    const digest = String(m.digest || '').trim();
    if (digest) out.summary = digest.slice(0, 500);
    if (Number.isFinite(ts) && ts > 0) out.publishedAt = new Date(ts * 1000).toISOString();
    return out;
  }

  // 翻页拉列表。两个刹车同时生效：翻满 maxPages 停、翻到早于 recentDays 停——
  // 央视新闻这种 44174 篇的号，没有时间刹车就会一直翻下去。
  async function fetchArticles(fakeid, token) {
    const cutoff = Date.now() / 1000 - RULES.recentDays * 86400;
    const posts = [];
    let reachedOld = false;
    for (let page = 0; page < RULES.maxPages && !reachedOld; page++) {
      if (page > 0) await sleep(gap());
      const data = await mpGet(
        '/cgi-bin/appmsgpublish',
        {
          sub: 'list',
          search_field: 'null',
          begin: String(page * RULES.pageSize),
          count: String(RULES.pageSize),
          query: '',
          fakeid,
          type: '101_1',
          free_publish_type: '1',
          sub_action: 'list_ex',
        },
        token,
      );
      const bad = classify(data.base_resp);
      if (bad) return { ...bad, posts };

      let list = [];
      try {
        list = JSON.parse(data.publish_page || '{}').publish_list || [];
      } catch {
        return { code: 'mp_error', error: '微信返回的列表解析失败', posts };
      }
      if (!list.length) break;

      for (const item of list) {
        if (!item?.publish_info) continue;
        let msgs = [];
        try {
          msgs = JSON.parse(item.publish_info).appmsgex || [];
        } catch {
          continue;
        }
        for (const m of msgs) {
          const ts = Number(m.create_time || m.update_time);
          if (Number.isFinite(ts) && ts < cutoff) { reachedOld = true; continue; }
          const post = mapArticle(m);
          if (post) posts.push(post);
        }
      }
    }
    return { posts };
  }

  // 一次完整采集：搜号 → 等 → 拉列表。返回给 sw.js 直接回传 /api/ingest/competitor 的 payload。
  async function collect(name) {
    const token = readToken();
    if (!token) return { ok: false, code: 'no_token', error: noTokenReason() };

    const found = await resolveFakeid(name, token);
    if (found.code) return { ok: false, ...found };

    await sleep(gap());
    const got = await fetchArticles(found.fakeid, token);
    if (got.code && got.posts.length === 0) return { ok: false, code: got.code, error: got.error };

    return {
      ok: true,
      // 中途撞频控但已拿到部分文章：入库已拿到的，同时把原因带上去如实展示
      partial: got.code ? got.error : undefined,
      code: got.code,
      payload: {
        platform: 'wechat',
        handle: name,
        autoSubscribe: false, // 竞对必须已在库并已订阅——这条通道不建档
        profile: { name: found.nickname },
        posts: got.posts.slice(0, 50), // 与 ingestPayloadSchema 的单批上限对齐
      },
    };
  }

  // 供单测用（tests/ingest/wechat-competitor-parse.test.ts 用 node:vm 跑本文件后取这里）
  globalThis.__beaconWechatCompetitor = { RULES, mapArticle, resolveFakeid, fetchArticles, collect, readToken };

  chrome?.runtime?.onMessage?.addListener?.((msg, _sender, sendResponse) => {
    if (msg?.type !== 'beacon-wechat-collect') return undefined;
    collect(String(msg.name || ''))
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, code: 'exception', error: String(e?.message || e) }));
    return true;
  });
})();
