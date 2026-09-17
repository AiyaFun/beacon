import { INGEST_TOKEN_INVALID, INGEST_TOKEN_HEADER } from '@/lib/ingest/competitor';
import { resolveIngestToken } from '@/lib/ingest/token';
import {
  loadParserSources, loadBackendSources, loadRecipeRunner,
  COLLECT_FN, READ_TEXT_FN, PAGE_READ_FN, BACKEND_PROBE_FN, BACKEND_COLLECT_FN, RECIPE_READY_FN,
} from '@/lib/browser/local-collect';
import { LOGIN_WALL_FN, LOGGED_OUT_FN } from '@/lib/browser/local';

export const dynamic = 'force-dynamic';

// 桌面客户端执行器要的脚本（2026-09-03；2026-09-16 加创作者后台 / 配方 / 页面直读）。
//
// 云端账号 + Mac/Win 客户端：服务在机房够不到用户的浏览器，客户端自己走 CDP 驱动本机 Chrome。
// 它只是个「开页 → 注入 → 取值 → 交回」的哑执行器，**解析器不随客户端打包**——
// 从这里现取，平台改版修了解析器，客户端不用发版就跟上（与插件的规则包同一思路）。
// 脚本与整机版本机浏览器那条路是同一份（lib/browser/local-collect.ts），三条路一个解析器。
//
// 【kind 决定脚本包长什么样】
//   · 不带 / collect_self_profile / collect_competitor：主页解析器（shim + common.js + 平台解析器）；
//   · collect_self_backend：后台脚本（shim + common.js [+ 公众号可选模块] + self-backend.js）+ 探针 + 读数函数；
//   · collect_competitor_recipe / collect_self_recipe：配方执行器（插件那份 tools/recipe-run.js 原样包一层）
//     + 这个工作区该平台的内置配方（规则/选项/状态）+ 就绪判据。
//   每种都带 pageRead：解析器/配方读不到时执行器把页面可见文字与链接带回，服务端让模型直读（页面直读）。
//
// 🔒 同一把采集令牌鉴权。脚本本身没有秘密（插件商店里就是公开的），要鉴权是为了不给
//    任意来源当免费的解析器分发点；配方是按工作区的，更不能不鉴权。

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

export async function GET(req: Request) {
  const auth = await resolveIngestToken(req.headers.get(INGEST_TOKEN_HEADER));
  if (!auth) return json({ ok: false, error: INGEST_TOKEN_INVALID }, 401);
  const sp = new URL(req.url).searchParams;
  const platform = sp.get('platform') ?? '';
  const kind = sp.get('kind') ?? '';
  const base = { loginWall: LOGIN_WALL_FN, loggedOut: LOGGED_OUT_FN, collect: COLLECT_FN, readText: READ_TEXT_FN, pageRead: PAGE_READ_FN };

  if (kind === 'collect_self_backend') {
    const src = loadBackendSources(platform);
    if (!src.ok) return json({ ok: false, error: src.error }, 400);
    return json({ ok: true, ...base, scripts: src.scripts, backendProbe: BACKEND_PROBE_FN, backendCollect: BACKEND_COLLECT_FN });
  }
  if (kind === 'collect_competitor_recipe' || kind === 'collect_self_recipe') {
    const runner = loadRecipeRunner();
    if (!runner.ok) return json({ ok: false, error: runner.error }, 400);
    const { platformRecipeFor } = await import('@/lib/browser-task/local-run');
    const recipe = platform ? await platformRecipeFor(auth.workspace.id, platform) : null;
    if (!recipe) return json({ ok: false, error: `${platform || '这个平台'} 没有内置配方` }, 400);
    const { tenantId: _t, ...pub } = recipe;
    void _t;
    return json({ ok: true, ...base, scripts: [], recipeRun: runner.fn, recipeReady: RECIPE_READY_FN, recipe: pub });
  }

  if (!platform) return json({ ok: true, ...base, scripts: [] });
  const src = loadParserSources(platform);
  if (!src.ok) return json({ ok: false, error: src.error }, 400);
  return json({ ok: true, ...base, scripts: src.scripts });
}
