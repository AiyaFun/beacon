/**
 * Chrome 应用商店截图生成器 —— 输出 5 张 1280×800 PNG 到 extension/store/screenshots/。
 *
 * 用法：npx tsx scripts/store-screenshots.ts
 *
 * 【为什么要脚本而不是手动截屏】
 * 商店截图每次改 UI 都要重出一遍，手动截图既难对齐尺寸（Chrome 只收 1280×800 / 640×400），
 * 也很容易把**真实竞对数据/未脱敏账号**截进去——那是审核直接打回的项。
 * 这里用固定的示例数据渲染真实界面：尺寸永远对，内容永远是假数据。
 *
 * 【两趟渲染】
 *   ① 把每个真实界面（popup / SidePanel / 设置页 / 页内侧栏）按自身尺寸截成 PNG；
 *   ② 再把 PNG 摆进 1280×800 的版面里（标题 + 说明 + 阴影），截成最终图。
 * 直接在 1280×800 的页面里 iframe 那些 file:// 页面会撞跨源限制，所以拆两趟。
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const EXT = resolve(ROOT, 'extension');
const OUT = resolve(EXT, 'store/screenshots');
const TMP = resolve(ROOT, '.screenshot-tmp');

// ⚠️ 全部是示例数据。商店审核明确禁止出现真实竞对隐私数据/未脱敏账号（见 store/PUBLISH.md）。
const DEMO_ACCOUNTS = [
  { id: 'a1', name: '示例账号 · 成长笔记', platform: 'x', handle: 'demo_growth', status: 'active' },
  { id: 'a2', name: '示例账号 · 效率工具', platform: 'wechat', handle: null, status: 'active' },
];
const DEMO_COMPETITORS = [
  { name: '示例对标 A', platform: 'bilibili', url: 'https://space.bilibili.com/000000', collectable: true, lastCrawledAt: new Date().toISOString() },
  { name: '示例对标 B', platform: 'douyin', url: 'https://www.douyin.com/user/demo', collectable: true, lastCrawledAt: null },
  { name: '示例对标 C', platform: 'xiaohongshu', url: 'https://www.xiaohongshu.com/user/profile/demo', collectable: true, lastCrawledAt: null },
];

// 扩展页面（popup / sidepanel / options）跑在 file:// 上，没有 chrome.* API，
// 得在页面脚本执行**之前**把桩装好，否则它们一上来就抛。
function chromeStub() {
  const ACCOUNTS = JSON.stringify(DEMO_ACCOUNTS);
  const COMPETITORS = JSON.stringify(DEMO_COMPETITORS);
  return `
    const reply = (msg) => {
      if (msg.type === 'beacon-get-config') return { host: 'https://beacon.iyunci.cn' };
      if (msg.type === 'beacon-get-competitors') return { ok: true, competitors: ${COMPETITORS}, workspace: '示例工作区' };
      if (msg.type === 'beacon-get-accounts') return { ok: true, accounts: ${ACCOUNTS}, selfAccountId: 'a1' };
      return { ok: true };
    };
    window.chrome = {
      runtime: {
        getURL: (p) => p,
        sendMessage: (msg, cb) => { const r = reply(msg); if (cb) { cb(r); return; } return Promise.resolve(r); },
        openOptionsPage: () => {},
        onMessage: { addListener: () => {} },
      },
      tabs: {
        query: () => Promise.resolve([{ id: 1, url: 'https://x.com/demo_growth', title: '示例账号 · 成长笔记' }]),
        sendMessage: () => Promise.resolve({ ok: true, payload: {
          platform: 'x', handle: 'demo_growth', isSelf: true, profile: { name: '示例账号 · 成长笔记' },
          posts: [{ platformItemId: '1', title: '一个几乎没人用的技巧：走 Bonjour 主机名直接访问本地服务', metrics: { views: 12400, likes: 320, comments: 45, shares: 28 } }],
        } }),
        create: () => {}, onActivated: { addListener: () => {} }, onUpdated: { addListener: () => {} },
      },
      storage: {
        sync: {
          get: (k, cb) => { const v = { showInPageAi: true, scheduledCollect: true, scheduledCollectHour: 9, autoCollect: true, dailyReminder: true, host: 'https://beacon.iyunci.cn', token: 'bcn_示例令牌_请在设置页生成' };
            if (typeof cb === 'function') { cb(v); return; } return Promise.resolve(v); },
          set: () => Promise.resolve(),
        },
        local: { get: () => Promise.resolve({}), set: () => Promise.resolve(), remove: () => Promise.resolve() },
        onChanged: { addListener: () => {} },
      },
      windows: { getCurrent: () => Promise.resolve({ id: 1 }) },
      sidePanel: { open: () => Promise.resolve() },
      notifications: { create: () => {} },
    };
  `;
}

async function shotPage(
  page: Page, url: string, width: number, height: number, file: string,
  opts: { clip?: { x: number; y: number; width: number; height: number }; before?: string } = {},
) {
  await page.setViewportSize({ width, height });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700); // 等界面把异步拉到的清单渲染完
  // 有些界面的重点在内部滚动区里（popup 的 .content 限高 440px），截图前先把它滚到位
  if (opts.before) { await page.evaluate(opts.before); await page.waitForTimeout(250); }
  await page.screenshot({ path: file, ...(opts.clip ? { clip: opts.clip } : {}) });
}

// 页内侧栏是内容脚本注入出来的，没有自己的 HTML 文件——造一个仿真的内容页把它请进来
function drawerHost() {
  return `<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="file://${EXT}/content/sidebar.css">
<style>
  body { margin:0; font:15px/1.7 -apple-system,"PingFang SC",sans-serif; background:#fff; color:#0f1419; }
  .feed { max-width: 600px; padding: 28px 32px; }
  .name { font-weight:700; font-size:17px; }
  .handle { color:#536471; }
  article { border-bottom:1px solid #eff3f4; padding:16px 0; }
  .stats { color:#536471; font-size:13px; margin-top:10px; }
</style>
<div class="feed" data-testid="primaryColumn">
  <div class="name">示例账号 · 成长笔记 <span class="handle">@demo_growth</span></div>
  <button data-testid="editProfileButton" style="margin:10px 0">编辑个人资料</button>
  <article data-testid="tweet">
    <a href="/demo_growth/status/1">链接</a>
    <time datetime="2026-07-20T09:00:00.000Z"></time>
    <div data-testid="tweetText">一个几乎没人用的技巧：走 Bonjour 主机名，手机 / 其他电脑连同一 WiFi 直接访问，IP 变了也不用改。</div>
    <div class="stats" role="group">
      <span data-testid="reply"><span data-testid="app-text-transition-container">45</span> 回复</span> ·
      <span data-testid="retweet"><span data-testid="app-text-transition-container">28</span> 转帖</span> ·
      <span data-testid="like"><span data-testid="app-text-transition-container">320</span> 喜欢</span> ·
      <a href="/demo_growth/status/1/analytics"><span data-testid="app-text-transition-container">1.2万</span> 查看</a>
    </div>
  </article>
  <article data-testid="tweet">
    <a href="/demo_growth/status/2">链接</a>
    <time datetime="2026-07-18T09:00:00.000Z"></time>
    <div data-testid="tweetText">做了三个月独立产品，最有用的一条经验：先把「谁会用、为什么现在用」写成一句话。</div>
    <div class="stats" role="group">
      <span data-testid="reply"><span data-testid="app-text-transition-container">12</span> 回复</span> ·
      <span data-testid="like"><span data-testid="app-text-transition-container">198</span> 喜欢</span> ·
      <a href="/demo_growth/status/2/analytics"><span data-testid="app-text-transition-container">6842</span> 查看</a>
    </div>
  </article>
</div>
<script src="file://${EXT}/content/common.js"></script>
<script src="file://${EXT}/content/x.js"></script>
<script src="file://${EXT}/content/sidebar.js"></script>
<script>
  document.getElementById('beacon-ai-drawer').classList.add('open');
  // 页面情报卡默认写着「检测中…」，展开时才会刷新——截图里直接把它填好
  // 直接写死示例文案：file:// 上 x.js 的 status 链接正则匹配不到，走解析只会得到空结果
  document.getElementById('beacon-page-platform').textContent = 'x';
  document.getElementById('beacon-page-title').textContent =
    '【示例账号 · 成长笔记】一个几乎没人用的技巧：走 Bonjour 主机名直接访问本地服务';
  document.getElementById('beacon-page-meta').textContent = 'views: 12400 · likes: 320 · comments: 45 · shares: 28';
  document.getElementById('beacon-self-btn').style.display = '';
  document.getElementById('beacon-account-row').style.display = 'flex';
</script>`;
}

// 1280×800 的版面：左侧文案，右侧界面截图
function slide(opts: { title: string; sub: string; img: string; imgW: number; tint: string }) {
  return `<!doctype html><meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  body {
    margin:0; width:1280px; height:800px; overflow:hidden;
    font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
    background:
      radial-gradient(1100px 620px at 88% 10%, ${opts.tint} 0%, rgba(255,255,255,0) 62%),
      linear-gradient(140deg, #fdfdfe 0%, #f4f6f9 100%);
    display:flex; align-items:center; gap:44px; padding:0 56px;
  }
  .copy { width: 396px; flex: none; }
  .brand { display:flex; align-items:center; gap:10px; margin-bottom:26px; }
  .brand img { width:38px; height:38px; border-radius:9px; }
  .brand b { font-size:17px; letter-spacing:.2px; color:#1a1d21; }
  .brand span { font-size:12.5px; color:#6b7280; margin-left:2px; }
  h1 { font-size:35px; line-height:1.28; margin:0 0 16px; color:#12151a; letter-spacing:-.4px; }
  p { font-size:16px; line-height:1.75; color:#4b5563; margin:0; }
  .shot { flex:1; display:flex; justify-content:center; align-items:center; }
  .shot img {
    width:${opts.imgW}px; height:auto; max-height:718px; object-fit:contain; object-position:top;
    border-radius:13px; background:#fff;
    box-shadow:0 26px 60px rgba(16,24,40,.17), 0 3px 10px rgba(16,24,40,.09);
  }
</style>
<div class="copy">
  <div class="brand">
    <img src="file://${EXT}/icon128.png">
    <div><b>烽火台采集助手</b><br><span>跨平台内容作战室</span></div>
  </div>
  <h1>${opts.title}</h1>
  <p>${opts.sub}</p>
</div>
<div class="shot"><img src="file://${opts.img}"></div>`;
}

async function main() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch({ args: ['--allow-file-access-from-files', '--font-render-hinting=none'] });
  // 素材图用 2 倍拍，缩进版面里更锐利
  const ctx = await browser.newContext({ deviceScaleFactor: 2, locale: 'zh-CN' });
  await ctx.addInitScript(chromeStub());
  const page = await ctx.newPage();

  // ① 真实界面各自截一张
  const drawerFile = resolve(TMP, 'drawer-host.html');
  writeFileSync(drawerFile, drawerHost());

  const raw = {
    drawer: resolve(TMP, 'raw-drawer.png'),
    popup: resolve(TMP, 'raw-popup.png'),
    panel: resolve(TMP, 'raw-panel.png'),
    options: resolve(TMP, 'raw-options.png'),
  };
  // 侧栏宽 380，clip 出「一点页面 + 整条侧栏」，这样缩进版面后正文仍然读得清
  await shotPage(page, `file://${drawerFile}`, 1000, 820, raw.drawer,
    { clip: { x: 1000 - 560, y: 0, width: 560, height: 820 } });
  // popup 的高度是**它自己定的**（.content 限高 440px + 顶部页签 + 底部导航），
  // 视口给高了只会在下面留一大片灰。要露出「我的账号」那张卡，得滚它的内部滚动区。
  await shotPage(page, `file://${EXT}/popup.html`, 380, 620, raw.popup, {
    // ⚠️ 不能用 offsetTop：它是相对**最近的定位祖先**算的，而滚动容器 .content 并没有定位，
    // 于是算出来的偏移和实际滚动距离对不上（第一版就是这么滚过头，把标题连按钮一起顶出了视野）。
    // 用两个 rect 相减，得到的才是「卡片相对滚动容器的真实距离」。
    before: `(() => {
      const sc = document.querySelector('.content.active');
      const card = document.getElementById('selfhead').closest('.card');
      sc.scrollTop += card.getBoundingClientRect().top - sc.getBoundingClientRect().top - 10;
    })()`,
  });
  await shotPage(page, `file://${EXT}/sidepanel.html`, 400, 760, raw.panel);
  // 设置页很长，截到「定时采集」这一屏就够——文案讲的正是这块
  await shotPage(page, `file://${EXT}/options.html`, 900, 1000, raw.options);

  // ② 摆进 1280×800 版面
  const slides = [
    { file: '01-侧栏AI助手.png', img: raw.drawer, imgW: 500, tint: 'rgba(232,85,45,.16)',
      title: '刷到好内容，顺手就拆解', sub: '任意网页上唤出侧栏：AI 读当前页正文做爆款拆解、衍生选题，一键收进灵感箱。竞对采集与自有回填是两条独立通道，颜色区分，不会走串。' },
    { file: '02-我的账号一键采集.png', img: raw.popup, imgW: 372, tint: 'rgba(37,99,235,.16)',
      title: '我的数据，一键采回看板', sub: '「我的账号」与「竞对清单」并列，各自一键全部采集。哪些账号能一键采、哪些要手动，逐个如实标注，不会白开标签页假装在采。' },
    { file: '03-SidePanel控制台.png', img: raw.panel, imgW: 340, tint: 'rgba(124,58,237,.16)',
      title: '侧边控制台，边刷边分析', sub: '识别当前页面归属，自有作品回填到指定账号；AI 助手带着这一页的正文与真实数据回答，而不是只看到一个标题。' },
    { file: '04-设置与定时.png', img: raw.options, imgW: 660, tint: 'rgba(22,163,74,.15)',
      title: '填一次令牌，之后自动跑', sub: '每日定时采集竞对、定时回填自有数据；回填归属可绑定到具体账号，避免多账号时数据挂错号。所有自动任务都有系统通知，不做静默采集。' },
  ];

  // ⚠️ 最终图必须**正好** 1280×800：Chrome 应用商店只收 1280×800 或 640×400，
  // 2 倍图（2560×1600）会被直接打回。所以版面这一趟用 deviceScaleFactor: 1。
  const slideCtx = await browser.newContext({ deviceScaleFactor: 1, locale: 'zh-CN' });
  const slidePage = await slideCtx.newPage();
  await slidePage.setViewportSize({ width: 1280, height: 800 });
  for (const s of slides) {
    const html = resolve(TMP, `slide-${s.file}.html`);
    writeFileSync(html, slide({ title: s.title, sub: s.sub, img: s.img, imgW: s.imgW, tint: s.tint }));
    await slidePage.goto(`file://${html}`, { waitUntil: 'networkidle' });
    await slidePage.waitForTimeout(300);
    // clip 到精确 1280×800：deviceScaleFactor=2 会输出 2560×1600，Chrome 商店接受更高倍图
    await slidePage.screenshot({ path: resolve(OUT, s.file), clip: { x: 0, y: 0, width: 1280, height: 800 } });
    console.log('✓', s.file);
  }

  await browser.close();
  rmSync(TMP, { recursive: true, force: true });
  console.log(`\n输出目录：${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
