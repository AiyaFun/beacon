// 本机能力工具：命令执行 / 文件读写 / 采集配方 / 浏览器驱动
//（2026-08-30 从 tools.ts 抽出来）
//
// ── 为什么是这四块一起搬 ──
// 它们不是按行数凑的，是**同一个归属**：每一个的第一道闸都是形态判定
//   · run_shell / read_file / write_file / list_dir  → editionCan('localShell')
//   · browse_local / create_recipe / record_ai_citation / export_scrape_script
//                                                    → editionCan('localBrowser')
// SaaS 形态下这一整个文件的工具**全部恒返回「这个版本不提供」**。
// 也就是说：这里装的是整机版/桌面版专属的那半个产品。
//
// 【切口有多干净，是量出来的】抽之前 tools.ts 有 35 条 import，
// 其中 **26 条只被这 566 行用到**（其余两条 prisma/platformName 两边都用）。
// 一个文件里三分之二的依赖只服务于其中一段，那就不是一个文件，是两个。
//
// 【这里不放什么】跨形态都能用的工具（查选题、写草稿、派浏览器任务…）留在 tools.ts
// 与 tools-content/insight/produce/draft-plan 里。判据就是上面那道形态闸：
// 要加的新工具如果不需要 editionCan('local*')，它不属于这个文件。

import { checkCommand, runCommand, insideRoot, readTextFile, writeTextFile, listDir, SHELL_DEFAULTS } from './shell';
import { redactSecrets } from './redact';
import { resolve as resolvePath } from 'node:path';
import { can as editionCan } from '../edition';
import {
  vetOrigin, learnFromSkeleton, recordScrapeResult, markNeedsLogin, markRateLimited, recipeUrl,
  parseOptions, MAX_RECIPES_PER_WORKSPACE, type RecipeOptions,
} from '../scrape/recipe';
import { saveScrapeRecord } from '../scrape/record';
import { answerSiteOf, extractCitations, attributeCitations, saveCitations } from '../geo/citation';
import { browseLocal, vetCdpUrl, buildScrapeScript } from '../browser/local';
import { prisma } from '../db';
import { platformName } from '../constants';
import { type ToolContext, type AgentTool } from './tool-types';

// ── 本机命令执行（2026-08-29）──────────────────────────────────────────
// 闸门全在 lib/agent/shell.ts，这里只负责「取策略 → 交给闸门 → 把结果说成人话」。
//
// 【四道前置，缺一不可】① 形态允许（SaaS 恒 false）② 工作区开了 ③ 配了工作目录
// ④ 命令在白名单里。任一不满足就直说，不含糊。
//
// 【write: true】它能改用户机器上的文件。授权三档里这类必须过确认闸，
// 标成 false 会让「确认每一步」那一档形同虚设。
const runShell: AgentTool = {
  name: 'run_shell',
  label: '在本机跑命令',
  action: 'content.create',
  write: true,
  def: {
    name: 'run_shell',
    description:
      '在装了烽火台的这台机器上执行一条命令（仅限管理员配好的白名单命令、且只能在指定工作目录内）。'
      + '命令与参数要分开给：cmd="git"、args=["status"]。不支持管道、重定向、&& 这些 shell 语法。',
    parameters: {
      type: 'object',
      properties: {
        cmd: { type: 'string', description: '命令名，如 git / ls / python3。不能带路径' },
        args: { type: 'array', items: { type: 'string' }, description: '参数数组，如 ["status","--short"]' },
        cwd: { type: 'string', description: '在工作目录下的哪个子目录里跑（相对路径）。不传=工作目录本身' },
      },
      required: ['cmd'],
    },
  },
  async run(ctx, args) {
    if (!editionCan('localShell')) return { ok: false, summary: '这个版本不提供本机命令执行' };
    const ws = await prisma.workspace.findUnique({
      where: { id: ctx.workspaceId },
      select: { shellEnabled: true, shellAllow: true, shellRoot: true, shellExecMode: true, shellTimeoutSec: true },
    });
    if (!ws?.shellEnabled) return { ok: false, summary: '这个工作区没有开启本机命令执行' };
    if (!ws.shellRoot) return { ok: false, summary: '还没配工作目录，没有边界就不许跑' };
    let allow: string[] = [];
    try { allow = JSON.parse(ws.shellAllow) as string[]; } catch { /* 坏配置当空清单 */ }
    const mode = ws.shellExecMode === 'full' ? 'full' as const : 'allowlist' as const;
    // full 档下空清单是正常的（本来就不看清单）；allowlist 档下空清单 = 一条都没放行
    if (mode === 'allowlist' && allow.length === 0) return { ok: false, summary: '允许清单是空的，一条命令都没放行' };

    const policy = {
      allow, mode, root: ws.shellRoot,
      // 装东西动辄几分钟。上限 30 分钟：再长就该做成后台任务，而不是挂着一次工具调用
      timeoutMs: Math.min(Math.max(ws.shellTimeoutSec, 1), 1800) * 1000,
      maxOutputBytes: SHELL_DEFAULTS.maxOutputBytes,
    };
    const argv = [String(args.cmd ?? ''), ...(Array.isArray(args.args) ? args.args.map(String) : [])];
    const chk = await checkCommand(policy, argv);
    if (!chk.ok) return { ok: false, summary: chk.error };

    // 子目录也要过路径闸——不然 cwd 就是绕过边界的后门
    let cwd = ws.shellRoot;
    const sub = String(args.cwd ?? '').trim();
    if (sub) {
      if (!(await insideRoot(ws.shellRoot, sub))) return { ok: false, summary: `目录「${sub}」在允许范围之外` };
      cwd = resolvePath(ws.shellRoot, sub);
    }

    const r = await runCommand(policy, chk.argv, cwd);
    // 输出进上下文之前先脱敏：这一步做在这里而不是 runCommand 里，是让「真跑」那层保持
    // 原样可测；进模型的东西在这一层统一处理（read_file 同）。见 lib/agent/redact.ts。
    const red = redactSecrets([r.stdout, r.stderr].filter(Boolean).join('\n').trim());
    const body = red.text;
    return {
      ok: r.code === 0 && !r.timedOut,
      data: { code: r.code, output: body, truncated: r.truncated, timedOut: r.timedOut, redacted: red.count },
      summary: r.timedOut
        ? `超时被中止（上限 ${Math.round(SHELL_DEFAULTS.timeoutMs / 1000)} 秒）`
        : `退出码 ${r.code}${r.truncated ? '（输出过长已截断）' : ''}${red.count ? `（${red.count} 处密钥已脱敏）` : ''}${body ? `\n${body}` : ''}`,
    };
  },
};


// ── 文件读写（2026-08-29）──────────────────────────────────────────────
// 为什么不让模型用 cat/echo 代替：见 lib/agent/shell.ts 文件读写那一段。
// 简单说——读文件不需要执行任何东西，而且 shell:false 下重定向根本写不了，
// 不给专用工具，模型只会反复瞎试。
//
// 三个工具共用同一段前置（开没开、有没有工作目录），抽成 shellRootOf 免得三处各写一遍走样。
async function shellRootOf(ctx: ToolContext): Promise<{ ok: true; root: string } | { ok: false; why: string }> {
  if (!editionCan('localShell')) return { ok: false, why: '这个版本不提供本机文件读写' };
  const ws = await prisma.workspace.findUnique({
    where: { id: ctx.workspaceId },
    select: { shellEnabled: true, shellRoot: true },
  });
  if (!ws?.shellEnabled) return { ok: false, why: '这个工作区没有开启本机命令执行' };
  if (!ws.shellRoot) return { ok: false, why: '还没配工作目录，没有边界就不许动文件' };
  return { ok: true, root: ws.shellRoot };
}

const readFileTool: AgentTool = {
  name: 'read_file',
  label: '读本机文件',
  action: 'content.view',
  write: false,
  def: {
    name: 'read_file',
    description: '读取工作目录内的一个文本文件。路径相对于工作目录。',
    parameters: { type: 'object', properties: { path: { type: 'string', description: '相对路径，如 src/index.ts' } }, required: ['path'] },
  },
  async run(ctx, args) {
    const g = await shellRootOf(ctx);
    if (!g.ok) return { ok: false, summary: g.why };
    const r = await readTextFile(g.root, String(args.path ?? ''));
    if (!r.ok) return { ok: false, summary: r.error };
    // .env 这类文件正是用户最常让 AI「看一眼」的，也正是密钥所在。脱敏后再进上下文。
    const red = redactSecrets(r.text);
    const note = red.count ? `\n…（${red.count} 处密钥已脱敏，模型看不到原值）` : '';
    return {
      ok: true,
      data: { text: red.text, truncated: r.truncated, redacted: red.count },
      summary: (r.truncated ? `${red.text}\n…（文件过长，只读了前 128KB）` : red.text) + note,
    };
  },
};

const writeFileTool: AgentTool = {
  name: 'write_file',
  label: '写本机文件',
  action: 'content.create',
  write: true, // 会改用户机器上的东西，必须能被确认闸拦住
  def: {
    name: 'write_file',
    description: '把内容写进工作目录内的一个文件（覆盖写）。父目录不存在会自动创建。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对路径' }, content: { type: 'string', description: '完整文件内容' } },
      required: ['path', 'content'],
    },
  },
  async run(ctx, args) {
    const g = await shellRootOf(ctx);
    if (!g.ok) return { ok: false, summary: g.why };
    const r = await writeTextFile(g.root, String(args.path ?? ''), String(args.content ?? ''));
    return r.ok ? { ok: true, summary: r.text } : { ok: false, summary: r.error };
  },
};

const listDirTool: AgentTool = {
  name: 'list_dir',
  label: '看本机目录',
  action: 'content.view',
  write: false,
  def: {
    name: 'list_dir',
    description: '列出工作目录内某个目录下的文件与子目录（只列一层）。',
    parameters: { type: 'object', properties: { path: { type: 'string', description: '相对路径，不传=工作目录本身' } } },
  },
  async run(ctx, args) {
    const g = await shellRootOf(ctx);
    if (!g.ok) return { ok: false, summary: g.why };
    const r = await listDir(g.root, String(args.path ?? ''));
    if (!r.ok) return { ok: false, summary: r.error };
    return { ok: true, data: { entries: r.text.split('\n') }, summary: r.truncated ? `${r.text}\n…（条目过多已截断）` : r.text };
  },
};


// ── 任意站点采集配方（2026-08-29）────────────────────────────────────
// 让 AI 能自己「指一个站点、说要抓什么」，学会之后反复用，坏了自动重学。
// 合规两道闸在 lib/scrape/recipe.ts：黑名单域名 + 真读 robots.txt。
// **建配方这一步就要过闸**，不能等到真去抓了才拦——那时候人已经以为能抓了。
const createRecipe: AgentTool = {
  name: 'create_recipe',
  label: '新建采集配方',
  action: 'content.create',
  write: true,
  def: {
    name: 'create_recipe',
    description:
      '为一个网站建立采集配方：给网址和想抓的字段，之后由浏览器插件学会怎么取。'
      + '适用于烽火台还没内置解析器的站点。政务／教育／医疗／金融类站点会被拒绝。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '配方名字，如「某站热榜」' },
        url: { type: 'string', description: '示例网址（完整 URL）' },
        fields: { type: 'array', items: { type: 'string' }, description: '要抓的字段，用人话，如 ["标题","点赞数","作者"]' },
      },
      required: ['name', 'url', 'fields'],
    },
  },
  async run(ctx, args) {
    const url = String(args.url ?? '').trim();
    let origin = ''; let path = '/';
    try { const u = new URL(url); origin = u.origin; path = u.pathname || '/'; }
    catch { return { ok: false, summary: '网址格式不对' }; }

    const vet = await vetOrigin(origin, path);
    if (!vet.ok) return { ok: false, summary: `不能给这个站点建配方：${vet.reason}` };

    // 【上限在建之前判】AI 误解一句话就可能连建十几个，而每个都会进定时扫描、
    // 每轮在用户浏览器里开一次标签。建完再拦等于已经建进去了
    const existing = await prisma.scrapeRecipe.count({ where: { workspaceId: ctx.workspaceId } });
    if (existing >= MAX_RECIPES_PER_WORKSPACE) {
      return { ok: false, summary: `配方已经有 ${existing} 个（上限 ${MAX_RECIPES_PER_WORKSPACE}）。先去技能页删掉用不上的再建。` };
    }

    const raw = Array.isArray(args.fields) ? args.fields.map(String).filter(Boolean) : [];
    if (raw.length === 0) return { ok: false, summary: '没说要抓什么字段' };
    // key 用 f1/f2… 而不是中文：它要进 CSS 选择器与 JSON，中文 key 在插件那端易出岔子
    const fields = raw.slice(0, 12).map((label, i) => ({ key: `f${i + 1}`, label }));

    const r = await prisma.scrapeRecipe.create({
      data: {
        tenantId: ctx.tenantId, workspaceId: ctx.workspaceId,
        name: String(args.name ?? '未命名').slice(0, 60),
        origin, pathPattern: path, fields: JSON.stringify(fields),
        createdBy: ctx.memberId,
      },
      select: { id: true },
    });
    return {
      ok: true,
      data: { recipeId: r.id, origin },
      summary: `已建配方「${args.name}」（${origin}），要抓 ${fields.map((f) => f.label).join('、')}。`
        + '下一步：在装了采集助手的浏览器里打开这个网址，插件会申请该站点授权并学习一次。',
    };
  },
};

const listRecipes: AgentTool = {
  name: 'list_recipes',
  label: '看采集配方',
  action: 'content.view',
  write: false,
  def: {
    name: 'list_recipes',
    description: '列出这个工作区已有的任意站点采集配方，以及它们现在能不能用。',
    parameters: { type: 'object', properties: {} },
  },
  async run(ctx) {
    const rows = await prisma.scrapeRecipe.findMany({
      where: { workspaceId: ctx.workspaceId },
      orderBy: { updatedAt: 'desc' }, take: 30,
      select: { id: true, name: true, origin: true, status: true, version: true, failCount: true },
    });
    const label = { learning: '还没学会', active: '能用', broken: '抓不到了，等重学' } as Record<string, string>;
    return {
      ok: true,
      data: rows,
      summary: rows.length
        ? rows.map((r) => `${r.name}（${r.origin}）· ${label[r.status] ?? r.status} · v${r.version}`).join('\n')
        : '还没有任意站点配方',
    };
  },
};


// ── 本机浏览器驱动（2026-08-29）──────────────────────────────────────
// 与插件那条路的分工：插件受 Chrome 扩展模型约束（逐站点授权、只跑注入脚本）；
// 这条路直接连用户已开着的 Chrome，能力大得多，所以边界也更硬——五条闸见 lib/browser/local.ts。
// 这里只做「取策略 → 交给闸门 → 说人话」，判据一条都不在这个文件里。
const browseLocalTool: AgentTool = {
  name: 'browse_local',
  label: '用本机浏览器打开',
  action: 'content.view',
  write: false, // 只读：打开页面、取内容。不点不填不提交
  def: {
    name: 'browse_local',
    description:
      '用这台电脑上已经开着的 Chrome 打开一个网址并读取内容（需要 Chrome 以调试端口启动）。'
      + '因为用的是你自己的浏览器，需要登录才看得见的内容也读得到。只读，不会点击或填写任何东西。'
      + '给了 recipeId 就顺便按那个配方取值；配方还没学会时会自动学一次。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要打开的完整网址' },
        recipeId: { type: 'string', description: '可选：按这个采集配方取值' },
        waitLoginSec: { type: 'number', description: '可选：遇到登录页时，把它推到前台并等用户登录多少秒（默认 90，最多 300，0=不等）' },
      },
      required: ['url'],
    },
  },
  async run(ctx, args) {
    if (!editionCan('localBrowser')) return { ok: false, summary: '这个版本不提供本机浏览器驱动' };
    const ws = await prisma.workspace.findUnique({
      where: { id: ctx.workspaceId },
      select: { browserCdpUrl: true, shellRoot: true },
    });
    const vet = vetCdpUrl(ws?.browserCdpUrl);
    if (!vet.ok) return { ok: false, summary: `${vet.error}。请在设置里填浏览器调试端点（如 http://127.0.0.1:9222）` };

    const url = String(args.url ?? '').trim();
    const recipeId = String(args.recipeId ?? '').trim();

    let rules: { key: string; selectors: string[]; anchors: string[] }[] = [];
    let recipe: { id: string; name: string; status: string } | null = null;
    let opts: RecipeOptions = {};
    if (recipeId) {
      const r = await prisma.scrapeRecipe.findFirst({
        where: { id: recipeId, workspaceId: ctx.workspaceId },
        select: { id: true, name: true, status: true, rules: true, options: true },
      });
      if (!r) return { ok: false, summary: '找不到这个配方' };
      recipe = { id: r.id, name: r.name, status: r.status };
      opts = parseOptions(r.options);
      try { rules = JSON.parse(r.rules); } catch { /* 坏数据当空 */ }
    }

    // 撞上登录墙就把页面推到前台等他登（有上限）。默认 90 秒：
    // 人在键盘前扫码/输密码够用，不在的话也不会把整次执行挂死。
    const waitSec = Math.min(Math.max(Number(args.waitLoginSec ?? 90) || 0, 0), 300);
    const page = await browseLocal(vet.url!, url, rules, waitSec, opts);
    if (!page.ok) {
      // 登录墙：跳过而不是判失败——配方可能好好的，只是这个浏览器没登录。
      // 计进失败会把好配方推去重学，而重学看到的还是登录页，于是学出一堆「请登录」的规则。
      // 用结构化字段判，不靠匹配报错文案——文案改一个字判据就悄悄失效
      if (recipe && page.rateLimited) {
        const m = await markRateLimited(recipe.id, ctx.workspaceId, new URL(url).origin);
        return {
          ok: false,
          data: { rateLimited: true, notified: m.notified },
          summary: `${page.error}${m.notified ? '（已给你留了一条通知）' : ''}`,
        };
      }
      if (recipe && page.needsLogin) {
        const m = await markNeedsLogin(recipe.id, ctx.workspaceId, new URL(url).origin);
        return {
          ok: false,
          data: { needsLogin: true, notified: m.notified },
          summary: `${page.error}${m.notified ? '（已给你留了一条通知）' : ''}`,
        };
      }
      // 【失败要带上「下一步试什么」】模型拿到一句报错，只会原样转述给用户，
      // 或者把同一个网址再试一遍。它需要的是**一份可选项清单**——
      // 这就是 Hermes 那套「工具出错时自省重试」在采集这条路上的落地形态：
      // 自省的前提是错误里有可自省的东西，一句「打开页面失败」什么都推不出来。
      return {
        ok: false,
        data: { hint: browseFailureHint(page.error, !!recipe) },
        summary: `${page.error}\n\n${browseFailureHint(page.error, !!recipe)}`,
      };
    }

    // 配方还没学会 / 一个值都没取到 → 拿这次的骨架学一次（这就是「进化」那一环）
    const got = page.values ? Object.keys(page.values).length : 0;
    const rowCount = page.rows?.length ?? 0;
    // 【有行就算抓到了】纯列表页往往没有任何页面级标量，只看 got 会把满载判成失败
    if (recipe && (recipe.status !== 'active' || (got === 0 && rowCount === 0))) {
      const learned = await learnFromSkeleton({
        tenantId: ctx.tenantId, recipeId: recipe.id, skeleton: page.skeleton, jsonHints: page.jsonHints,
      });
      await recordScrapeResult(recipe.id, ctx.workspaceId, false);
      return {
        ok: learned.ok,
        data: { title: page.title, learned: learned.learned },
        summary: learned.ok
          ? `打开了「${page.title}」，学会了 ${learned.learned} 个字段的取法。再跑一次就能取到值了。`
          : `打开了「${page.title}」，但没学出可用规则：${learned.error}`,
      };
    }
    // 【抓到了就落库】与定时扫描同一条口径：先存，再判配方好坏。
    // 不存的话，AI 抓到的东西只活在这一次对话里，用户回头什么都查不到。
    let saved: { saved: boolean; rows: number } = { saved: false, rows: 0 };
    if (recipe && (got > 0 || rowCount > 0)) {
      saved = await saveScrapeRecord({
        tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, recipeId: recipe.id,
        url, values: page.values, rows: page.rows, want: rules.length, channel: 'manual',
      });
    }
    if (recipe) await recordScrapeResult(recipe.id, ctx.workspaceId, got > 0 || rowCount > 0);

    // 【正文要真的回给模型】工具描述说的是「打开一个网址并读取内容」。
    // 在补上这一段之前，没给配方时这里只回标题——模型拿不到任何内容，
    // 于是它要么瞎猜，要么再调一次别的工具。正文只进这次对话的上下文，不落库。
    const parts: string[] = [];
    if (page.values && Object.keys(page.values).length) {
      parts.push(Object.entries(page.values).map(([k, v]) => `${k}=${v}`).join('，'));
      if (saved.saved) parts.push('已入库');
    }
    if (rowCount > 0) parts.push(`列表 ${rowCount} 行${saved.saved ? '已入库' : ''}`);
    if (page.text) parts.push(`正文 ${page.text.length} 字已读`);
    return {
      ok: true,
      data: { title: page.title, values: page.values, rows: page.rows, text: page.text, meta: page.meta },
      summary: parts.length
        ? `「${page.title}」：${parts.join('；')}`
        : `打开了「${page.title}」，但没解析出正文（可能是应用型页面而不是文章页）`,
    };
  },
};

/**
 * 采集失败时，告诉模型下一步可以试什么。
 *
 * 【为什么是清单而不是一句话】模型在工具失败后的默认行为有两种：把报错原样念给用户，
 * 或者把同一次调用原样重试一遍。两种都没用。给它一组**互不相同的下一步**，
 * 它才有东西可选——这是「自省重试」真正需要的输入。
 *
 * 【为什么按报错分档而不是永远给同一份】永远给同一份的话，模型在「网址打错了」时
 * 也会被建议「去登录一次」，那比不给建议更糟：它会把用户支使去做一件没用的事。
 */
export function browseFailureHint(error: string, hasRecipe: boolean): string {
  const e = String(error ?? '');
  if (e.includes('连不上本机浏览器')) {
    return '下一步：这不是网页的问题，是浏览器没以调试端口开着。'
      + '让用户在客户端托盘点「启动采集浏览器」，或到「设置 → 本机命令执行」点「自动检测」。'
      + '**不要重试这次调用**——浏览器起来之前重试多少次都一样。';
  }
  if (e.includes('权利人已经要求停止采集') || e.includes('权利人已要求停止采集')) {
    // 【这一档必须单独有】不加的话它落进兜底那档，而兜底会建议「设就绪选择器 / 加滚动 /
    // 重新学一次」——那是在教模型绕过一条**法律边界**。停采不是抓取失败，是不许抓。
    return '下一步：这个站点的权利人已经要求我们停止采集。**不要重试、不要换网址、不要换写法**——'
      + '这不是抓取失败，是不许抓。如实告诉用户这个站点已停采；'
      + '如果他本人就是站点权利人、想撤回，指他去「数据移除申请」页说明。';
  }
  if (e.includes('robots')) {
    return '下一步：这个站点声明了不允许抓取该路径。**不要换个写法再试**——'
      + '换写法绕过 robots 是我们明确不做的事。如实告诉用户这个站点不能采。';
  }
  if (e.includes('不采集的范围') || e.includes('敏感度过高')) {
    return '下一步：这类站点一律不采，这是产品边界不是故障。如实告诉用户，别再换网址试同一个站。';
  }
  if (e.includes('人机验证') || e.includes('过于频繁')) {
    return '下一步：站点这次把我们拦下了。**现在不要重试**，那只会让情况更糟。'
      + '告诉用户过一阵会自动再试；如果他很急，可以让他自己在浏览器里打开那一页看看。';
  }
  if (e.includes('要求登录')) {
    return '下一步：等用户在他自己的 Chrome 里登录一次，之后直接就能读到。'
      + '**不要替他输入任何账号密码**，也不要重试——没登录之前每次都是这个结果。';
  }
  return [
    '下一步可以试（按顺序，别一次全试）：',
    '① 这个网址是不是要先登录？让用户在他的浏览器里打开看一眼。',
    '② 页面是不是靠脚本慢慢渲染出来的？'
      + (hasRecipe ? '给这个配方设一个「就绪选择器」，等到它出现再取。' : '先建一个配方，让它学一次。'),
    '③ 内容是不是要往下滚才出现？给配方设 scrollScreens。',
    '④ 以上都不是的话，把这一页交给配方重新学一次（再调一次本工具并带上 recipeId）。',
  ].join('\n');
}

const recordCitationTool: AgentTool = {
  name: 'record_ai_citation',
  label: '记一次 AI 引用回执',
  // 【必须是 create 不是 view】它 write:true（要落 AiCitation）。
  // 配成 content.view 的话，只读成员（viewer 有 content.view）就拿到了一个会写库的工具——
  // 而「只读角色不该有任何 write 工具」是这个项目收口过的不变量，
  // tests/agent-tool-config.test.ts 当场把它抓了出来。
  action: 'content.create',
  write: true, // 落库
  def: {
    name: 'record_ai_citation',
    description:
      '读一页 AI 的回答（用户自己已经在浏览器里问出来的那一页），看它引用了哪些内容，'
      + '其中有没有用户自己发过的。**不会替用户提问**——只读他自己问出来的那一页。'
      + '用于回答「我写的东西有没有被 AI 引用」。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'AI 回答页的完整网址（用户自己问完之后那一页的地址）' },
      },
      required: ['url'],
    },
  },
  async run(ctx, args) {
    if (!editionCan('localBrowser')) return { ok: false, summary: '这个版本不提供本机浏览器驱动' };
    const url = String(args.url ?? '').trim();

    // 【先认站点，再谈其他】认不出的站点不拦——用户可能在用别的引擎；
    // 但认得出的那几个里，元宝我们**知道**它不让抓，提前说清楚比让他等一个失败强
    const site = answerSiteOf(url);
    if (site?.expectBlocked) {
      return {
        ok: false,
        data: { engine: site.engine, blockedByRobots: true },
        summary: `${site.engine}读不了：${site.robotsNote}`
          + '\n换一个引擎试试（豆包的回答页目前是允许的）。'
          + '我们不绕 robots——绕过去拿到的数据，本身就是不能用的。',
      };
    }

    const ws = await prisma.workspace.findUnique({
      where: { id: ctx.workspaceId },
      select: { browserCdpUrl: true },
    });
    const vet = vetCdpUrl(ws?.browserCdpUrl);
    if (!vet.ok) return { ok: false, summary: `${vet.error}。请在设置里点「自动检测」` };

    // collectLinks：这是唯一需要链接的用途，所以在这里显式打开（默认是关的）
    const page = await browseLocal(vet.url!, url, [], 0, { collectLinks: true });
    if (!page.ok) {
      return { ok: false, summary: `${page.error}\n\n${browseFailureHint(page.error, false)}` };
    }

    const candidates = extractCitations(page.links ?? []);
    if (candidates.length === 0) {
      // 【「没引用」和「读失败」必须分得开】这是这个功能最容易被误读的地方：
      // 一条都没有时，用户会以为工具坏了。说清楚它读成功了、只是这一页没有可认的引用
      return {
        ok: true,
        data: { citations: 0 },
        summary: `读到了「${page.title}」，但这一页上没有可认出的作品链接。`
          + '可能是：这次回答没有引用来源；或者引用的是新闻站/官网这类不属于任何内容平台的地址'
          + '（那些我们不认，也不是你能优化的东西）。**这不是失败**。',
      };
    }

    const attributed = await attributeCitations(ctx.workspaceId, candidates);
    const saved = await saveCitations({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      engine: site?.engine ?? new URL(url).hostname,
      answerUrl: url,
      question: page.title,
      citations: attributed,
    });

    const byPlatform = new Map<string, number>();
    for (const c of attributed) byPlatform.set(c.platform ?? '', (byPlatform.get(c.platform ?? '') ?? 0) + 1);
    const spread = [...byPlatform.entries()].map(([p, n]) => `${platformName(p as never) || p} ${n}`).join('、');

    // 【只报条目与计数，绝不报比率】n=1 印成百分比是这条路上最难被发现的错
    return {
      ok: true,
      data: { citations: saved.saved, mine: saved.mine, byPlatform: Object.fromEntries(byPlatform) },
      summary: saved.mine > 0
        ? `这次回答引了 ${saved.saved} 条，其中 ${saved.mine} 条是你自己发的。来源分布：${spread}。`
        : `这次回答引了 ${saved.saved} 条，**没有一条是你的**。来源分布：${spread}。`
          + '这一条不能推出「你从不被引用」——它只是这一次这一问的结果。',
    };
  },
};

const exportScriptTool: AgentTool = {
  name: 'export_scrape_script',
  label: '导出采集脚本',
  action: 'content.create',
  write: true, // 往用户机器上写文件
  def: {
    name: 'export_scrape_script',
    description:
      '把一个已学会的采集配方导出成一份能独立运行的脚本，写到本机工作目录里。'
      + '用户可以自己读、改、放进定时任务，不依赖烽火台。',
    parameters: {
      type: 'object',
      properties: { recipeId: { type: 'string', description: '配方 ID' } },
      required: ['recipeId'],
    },
  },
  async run(ctx, args) {
    if (!editionCan('localBrowser')) return { ok: false, summary: '这个版本不提供本机浏览器驱动' };
    const ws = await prisma.workspace.findUnique({
      where: { id: ctx.workspaceId },
      select: { browserCdpUrl: true, shellRoot: true },
    });
    if (!ws?.shellRoot) return { ok: false, summary: '还没配工作目录，脚本没地方放' };
    const vet = vetCdpUrl(ws.browserCdpUrl);
    if (!vet.ok) return { ok: false, summary: vet.error! };

    const r = await prisma.scrapeRecipe.findFirst({
      where: { id: String(args.recipeId ?? ''), workspaceId: ctx.workspaceId },
      select: { name: true, origin: true, pathPattern: true, rules: true, status: true, options: true },
    });
    if (!r) return { ok: false, summary: '找不到这个配方' };
    if (r.status !== 'active') return { ok: false, summary: '这个配方还没学会，导出的脚本抓不到东西' };
    let rules: { key: string; selectors: string[]; anchors: string[] }[] = [];
    try { rules = JSON.parse(r.rules); } catch { /* 坏数据当空 */ }
    if (rules.length === 0) return { ok: false, summary: '这个配方没有可用规则' };

    const script = buildScrapeScript({
      name: r.name, url: recipeUrl(r.origin, r.pathPattern), rules, cdpUrl: vet.url!,
      // 【选项也要带上】不带的话，导出的脚本不等就绪、不滚、不取行——
      // 用户拿走的那份跑出来和站内不一样，而那份我们既看不见也修不了
      options: parseOptions(r.options),
    });
    const file = `采集-${r.name.replace(/[^\w\u4e00-\u9fa5-]/g, '_')}.js`;
    const w = await writeTextFile(ws.shellRoot, file, script);
    return w.ok
      ? { ok: true, data: { file }, summary: `脚本已写到工作目录：${file}。用 node 直接跑，输出 JSON。` }
      : { ok: false, summary: w.error };
  },
};


/**
 * 本机能力工具。由 tools.ts 的 AGENT_TOOLS 展开进那唯一一张注册表。
 *
 * 【顺序照搬原来的】模型看到的工具顺序会影响它先想到哪个，
 * 搬文件不该顺带改这个——所以这里保持抽出来之前 AGENT_TOOLS 里的排列。
 */
export const LOCAL_TOOLS: AgentTool[] = [
  browseLocalTool,
  recordCitationTool,
  exportScriptTool,
  createRecipe,
  listRecipes,
  readFileTool,
  writeFileTool,
  listDirTool,
  runShell,
];
