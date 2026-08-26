/**
 * 本机执行体（整机版 / 私有化版专用）—— 原来叫「本地发布器」。
 *
 * 用法：`npm run publisher`（在装了烽火台的那台 Mac mini / Windows 上跑）
 *
 * ── 它现在做两件事 ──────────────────────────────────────────────────────────
 *   ① **发布填充**：把烽火台里排好的稿子填进各平台的发布后台（老本行，见下）。
 *   ② **替 AI 读网页**：领 open_and_read 类型的浏览器任务，打开指定网址、读回正文。
 *
 * 【为什么把②也放进来】那件事本来只有浏览器插件能做，而插件依赖「用户的浏览器开着」。
 * 这台机器是**一直开着的**——它就是那台 24 小时在线的浏览器。装了它之后，
 * AI 派下去的活不用再等用户什么时候打开 Chrome。
 *
 * 【它与插件的分工】两者领的是同一个队列（BrowserTask），谁先醒谁领走，
 * 服务端用乐观锁保证同一条只会被领一次。插件擅长「用户已登录的那些平台后台」，
 * 这台机器擅长「随时都在」。
 *
 * ── 它解决什么 ──────────────────────────────────────────────────────────────
 * SaaS 版上「一键发布」只能到插件为止：服务端在机房，够不到用户的浏览器。
 * 但整机版**本来就跑在用户自己的机器上**——那台机器上可以有一个浏览器，
 * 一次登录之后长期保持登录态。于是这条路成立：
 *   烽火台里排好发布任务 → 本地发布器打开对应平台的发布页 → 填好 → （可选）点发布。
 *
 * ── 它不是什么 ──────────────────────────────────────────────────────────────
 * · **不是云端 cookie 托管**：登录态只在这台机器的浏览器 profile 里，不上传、不外发。
 * · **不是无人值守的批量号农场**：一次一个任务，串行，且默认不点发布。
 * · **不绕过任何平台的登录/风控**：它就是一个你自己开着的浏览器，你自己登录过。
 *
 * ── 三条硬闸（与插件同款，理由也一样）──────────────────────────────────────
 *   ① 默认只填不点。要代点必须显式设 BEACON_PUBLISHER_AUTO_CLICK=1；
 *   ② 只有标题与正文**都填成功**才可能去点；
 *   ③ 只认精确文案的发布按钮（lib/publish/selectors.ts 的白名单+拒绝名单），
 *      认不出就**不点**，如实报 filled。
 *
 * ── 依赖 ────────────────────────────────────────────────────────────────────
 * Playwright **不在 package.json 里**：SaaS 的 docker 镜像不需要它，装进去白白多几百 MB。
 * 整机版装机时单独装：`npm i -D playwright && npx playwright install chromium`。
 * 没装就给一句能照着做的话，而不是一堆 MODULE_NOT_FOUND。
 */
import { PUBLISH_SELECTORS, PUBLISH_BUTTON_TEXT, PUBLISH_BUTTON_DENY, selectorsFor } from './lib/publish/selectors';
// 白名单与服务端、插件端共用同一份口径（三方由 tests/ingest/read-allowlist-sync.test.ts 对账）
import { isReadAllowed } from './lib/browser-task/read-allowlist';

type Task = {
  id: string;
  platform: string;
  title: string;
  content: string;
  topics?: string[];
};

const HOST = (process.env.BEACON_PUBLISHER_HOST || process.env.BEACON_SITE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const TOKEN = process.env.BEACON_PUBLISHER_TOKEN || '';
const AUTO_CLICK = process.env.BEACON_PUBLISHER_AUTO_CLICK === '1';
const PROFILE_DIR = process.env.BEACON_PUBLISHER_PROFILE || './.publisher-profile';
const POLL_MS = Math.max(30_000, Number(process.env.BEACON_PUBLISHER_POLL_MS || 60_000));

function log(msg: string, extra?: unknown): void {
  const t = new Date().toISOString();
  console.log(`[publisher ${t}] ${msg}${extra === undefined ? '' : ' ' + JSON.stringify(extra)}`);
}

async function api<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(`${HOST}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-beacon-ingest-token': TOKEN, ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json()) as { ok?: boolean; error?: string } & T;
    if (!res.ok || body.ok === false) {
      log(`接口失败 ${path}：${body.error ?? res.status}`);
      return null;
    }
    return body;
  } catch (e) {
    log(`连不上烽火台 ${path}：${(e as Error).message}`);
    return null;
  }
}

/** 拉这个工作区里等着发的任务。与浏览器插件走**同一个**接口、同一枚令牌。 */
async function pendingTasks(platform: string): Promise<Task[]> {
  const r = await api<{ tasks?: Task[] }>(`/api/publish/tasks?platform=${encodeURIComponent(platform)}`);
  return r?.tasks ?? [];
}

async function receipt(taskId: string, status: 'filled' | 'published' | 'failed', error?: string): Promise<void> {
  await api('/api/publish/receipt', {
    method: 'POST',
    body: JSON.stringify({ taskId, status, error }),
  });
}

// ── 浏览器任务（与插件同一个队列）────────────────────────────────────────────

type BrowserTask = { id: string; kind: string; payload: Record<string, unknown> };

/** 领一条浏览器任务。一次一条：这台机器串行做，领一批也只能一条条来。 */
async function claimBrowserTask(): Promise<BrowserTask | null> {
  const r = await api<{ task?: BrowserTask | null }>('/api/ingest/tasks');
  return r?.task ?? null;
}

async function reportBrowserTask(
  taskId: string,
  ok: boolean,
  note: string,
  data?: Record<string, unknown>,
): Promise<void> {
  await api('/api/ingest/tasks', {
    method: 'POST',
    body: JSON.stringify({ taskId, ok, [ok ? 'result' : 'error']: note.slice(0, 300), ...(data ? { data } : {}) }),
  });
}

/**
 * 打开一个网址、把正文读回来。
 *
 * 【白名单这一道不能省，理由与插件端完全相同】这是唯一一个由**服务端指定 URL** 的动作。
 * 只在服务端校验等于「执行体无条件信任服务端」，而这台机器连的地址是用户自己填的
 *（BEACON_PUBLISHER_HOST）——填错或被改掉，就等于把一台带着全部登录态的浏览器交出去。
 * 落地后再按**最终 URL** 复验一次：白名单域里到处是短链和跳转页。
 */
async function openAndRead(page: any, payload: Record<string, unknown>): Promise<{ ok: boolean; note: string; data?: Record<string, unknown> }> {
  const url = typeof payload.url === 'string' ? payload.url : '';
  if (!isReadAllowed(url)) return { ok: false, note: '这个网址不在允许打开的站点清单里' };

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  // 等一下懒加载的正文（与插件那侧同一个量级）
  await page.waitForTimeout(2_500);

  const finalUrl: string = page.url();
  if (!isReadAllowed(finalUrl)) {
    return { ok: false, note: '页面跳转到了清单以外的站点，没有读取' };
  }

  const got = await page.evaluate(`(() => {
    const drop = 'script,style,noscript,svg,nav,header,footer,aside';
    const root = document.querySelector('article, main, [role="main"]') || document.body;
    const clone = root.cloneNode(true);
    clone.querySelectorAll(drop).forEach((n) => n.remove());
    const text = (clone.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
    return { text: text.slice(0, 60000), title: document.title || '' };
  })()`);

  if (!got?.text) return { ok: false, note: '这一页没读到正文（可能要登录，或内容是图片/视频）' };
  return {
    ok: true,
    note: `读到 ${got.text.length} 字`,
    data: { url, finalUrl, title: got.title, text: got.text },
  };
}

/** 跑一条浏览器任务。**认不出的 kind 如实交回失败**，不傻等到超时。 */
async function runBrowserTask(browser: any, task: BrowserTask): Promise<void> {
  if (task.kind !== 'open_and_read') {
    // 采集类的活让插件去做：那些依赖用户在各平台的登录态，而这台机器未必登过
    await reportBrowserTask(task.id, false, `本机执行体只做「读网页」，${task.kind} 请交给浏览器插件`);
    return;
  }
  const page = await browser.newPage();
  try {
    const r = await openAndRead(page, task.payload ?? {});
    await reportBrowserTask(task.id, r.ok, r.note, r.data);
    log(r.ok ? `读完一页：${r.note}` : `没读成：${r.note}`, { taskId: task.id });
  } catch (e) {
    await reportBrowserTask(task.id, false, (e as Error).message.slice(0, 200));
  } finally {
    // 读完就关：这台机器上开一堆标签页会把内存吃掉
    await page.close().catch(() => {});
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function loadPlaywright(): Promise<any> {
  try {
    return await import('playwright');
  } catch {
    console.error(
      [
        '',
        '缺少 playwright。本地发布器要一个真的浏览器，装一次即可：',
        '  npm i -D playwright',
        '  npx playwright install chromium',
        '',
        '（SaaS 版不需要它，所以它不在 package.json 的依赖里）',
      ].join('\n'),
    );
    process.exit(1);
  }
}

/** 在页面里找输入框：按选择器列表依次试，取第一个可见的。 */
const PICK = `(list) => {
  for (const sel of list) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null) return sel;
  }
  return null;
}`;

async function fillOne(page: any, task: Task): Promise<{ ok: boolean; reason?: string }> {
  const conf = selectorsFor(task.platform);
  if (!conf) return { ok: false, reason: `没有 ${task.platform} 的发布页选择器` };

  const titleSel = await page.evaluate(PICK, conf.title);
  const bodySel = await page.evaluate(PICK, conf.body);
  if (!titleSel && !bodySel) {
    return { ok: false, reason: '这一页没找到标题/正文输入框（可能是后台改版，或没登录）' };
  }
  if (titleSel) await page.fill(titleSel, task.title || '');
  if (bodySel) {
    const body = [task.content || '', (task.topics ?? []).map((t) => `#${t}`).join(' ')].filter(Boolean).join('\n\n');
    // contenteditable 用 fill 填不进去（那是富文本），改成聚焦后逐字输入
    const editable = await page.evaluate(
      `(sel) => { const el = document.querySelector(sel); return !!el && el.isContentEditable; }`,
      bodySel,
    );
    if (editable) {
      await page.click(bodySel);
      await page.keyboard.insertText(body);
    } else {
      await page.fill(bodySel, body);
    }
  }
  if (!titleSel || !bodySel) {
    return { ok: false, reason: `只填进了${titleSel ? '标题' : '正文'}，另一半没找到输入框` };
  }
  return { ok: true };
}

/** 找发布按钮。判据与插件逐字一致（同一份 lib/publish/selectors.ts）。 */
async function clickPublish(page: any): Promise<boolean> {
  const clicked = await page.evaluate(
    `(args) => {
      const okRe = new RegExp(args.ok);
      const denyRe = new RegExp(args.deny);
      const cands = [...document.querySelectorAll('button, [role="button"], a.btn, div[class*="publish"]')];
      for (const el of cands) {
        const txt = (el.innerText || el.textContent || '').replace(/\\s+/g, '');
        if (!txt || txt.length > 8) continue;
        if (denyRe.test(txt)) continue;
        if (!okRe.test(txt)) continue;
        if (el.offsetParent === null) continue;
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
        el.click();
        return true;
      }
      return false;
    }`,
    { ok: PUBLISH_BUTTON_TEXT.source, deny: PUBLISH_BUTTON_DENY.source },
  );
  return clicked === true;
}

async function runOnce(browser: any): Promise<number> {
  let handled = 0;
  for (const platform of Object.keys(PUBLISH_SELECTORS)) {
    const tasks = await pendingTasks(platform);
    if (tasks.length === 0) continue;
    const conf = selectorsFor(platform)!;
    for (const task of tasks) {
      const page = await browser.newPage();
      try {
        log(`打开 ${platform} 发布页`, { taskId: task.id });
        await page.goto(conf.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        // 后台大多是 SPA，给它一点时间把表单渲染出来
        await page.waitForTimeout(4_000);

        const r = await fillOne(page, task);
        if (!r.ok) {
          log(`填充失败：${r.reason}`, { taskId: task.id });
          await receipt(task.id, 'failed', r.reason);
          continue;
        }
        if (!AUTO_CLICK) {
          log('已填好，等你自己点发布（未开启 BEACON_PUBLISHER_AUTO_CLICK）', { taskId: task.id });
          await receipt(task.id, 'filled');
          continue;
        }
        const clicked = await clickPublish(page);
        if (!clicked) {
          log('已填好，但没认出发布按钮——不乱点，留给你自己发', { taskId: task.id });
          await receipt(task.id, 'filled');
          continue;
        }
        log('已代点发布。作品链接拿不到，去发布中心回填', { taskId: task.id });
        await receipt(task.id, 'published');
        handled++;
      } catch (e) {
        const msg = (e as Error).message.slice(0, 200);
        log(`任务出错：${msg}`, { taskId: task.id });
        await receipt(task.id, 'failed', msg);
      } finally {
        // 页面**不自动关**：用户要能看到填成什么样、以及平台弹了什么框
        if (AUTO_CLICK) await page.close().catch(() => {});
      }
    }
  }
  return handled;
}

async function main(): Promise<void> {
  if (!TOKEN) {
    console.error('缺少 BEACON_PUBLISHER_TOKEN：到烽火台「接入与密钥 · 插件采集令牌」为这台机器签发一枚。');
    process.exit(1);
  }
  const pw = await loadPlaywright();
  log(`启动。烽火台=${HOST} 代点发布=${AUTO_CLICK ? '开' : '关'} 轮询=${POLL_MS / 1000}s`);
  log(`浏览器 profile=${PROFILE_DIR}（第一次跑请在弹出的浏览器里逐个平台登录一次，登录态留在本机）`);

  // headless=false 是刻意的：这台机器是用户自己的，登录、验证码、二次确认都要他看得见。
  const browser = await pw.chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1440, height: 900 },
  });

  const loop = async () => {
    try {
      const n = await runOnce(browser);
      if (n > 0) log(`本轮处理发布任务 ${n} 条`);
    } catch (e) {
      log(`发布任务本轮异常：${(e as Error).message}`);
    }
    try {
      // 浏览器任务一轮最多做 3 条：这台机器还要留着做别的，
      // 而且一条读不完的页面不该把整轮卡死
      for (let i = 0; i < 3; i++) {
        const task = await claimBrowserTask();
        if (!task) break;
        await runBrowserTask(browser, task);
      }
    } catch (e) {
      log(`浏览器任务本轮异常：${(e as Error).message}`);
    }
  };
  await loop();
  setInterval(() => void loop(), POLL_MS);
}

void main();
