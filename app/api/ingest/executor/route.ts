import { INGEST_TOKEN_INVALID, INGEST_TOKEN_HEADER } from '@/lib/ingest/competitor';
import { resolveIngestToken } from '@/lib/ingest/token';
import { loadParserSources, COLLECT_FN, READ_TEXT_FN } from '@/lib/browser/local-collect';
import { LOGIN_WALL_FN } from '@/lib/browser/local';

export const dynamic = 'force-dynamic';

// 桌面客户端执行器要的脚本（2026-09-03）。
//
// 云端账号 + Mac/Win 客户端：服务在机房够不到用户的浏览器，客户端自己走 CDP 驱动本机 Chrome。
// 它只是个「开页 → 注入 → 取值 → 交回」的哑执行器，**解析器不随客户端打包**——
// 从这里现取，平台改版修了解析器，客户端不用发版就跟上（与插件的规则包同一思路）。
// 脚本与整机版本机浏览器那条路是同一份（lib/browser/local-collect.ts），三条路一个解析器。
//
// 🔒 同一把采集令牌鉴权。脚本本身没有秘密（插件商店里就是公开的），要鉴权是为了不给
//    任意来源当免费的解析器分发点。

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

export async function GET(req: Request) {
  const auth = await resolveIngestToken(req.headers.get(INGEST_TOKEN_HEADER));
  if (!auth) return json({ ok: false, error: INGEST_TOKEN_INVALID }, 401);
  const platform = new URL(req.url).searchParams.get('platform') ?? '';
  const base = { loginWall: LOGIN_WALL_FN, collect: COLLECT_FN, readText: READ_TEXT_FN };
  if (!platform) return json({ ok: true, ...base, scripts: [] });
  const src = loadParserSources(platform);
  if (!src.ok) return json({ ok: false, error: src.error }, 400);
  return json({ ok: true, ...base, scripts: src.scripts });
}
