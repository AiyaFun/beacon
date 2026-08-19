import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { can } from '@/lib/rbac';
import { buildAccountExport } from '@/lib/account/export';
import { checkRateLimit, retryHint, tenantKey } from '@/lib/ratelimit';
import { beijingDayKey } from '@/lib/beijing';

// 全量数据导出下载（PIPL 第 45 条可携带权）。
//
// 为什么是 GET 路由而不是 server action：导出包动辄几 MB，走 action 要 base64（+33%）
// 再经 RSC 流回来、在浏览器里手工解码成 Blob；一个带 Content-Disposition 的普通响应
// 让浏览器自己落盘就行，内存与带宽都省一大截。

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  let session;
  try {
    session = await getSession();
  } catch {
    return NextResponse.json({ error: '未登录' }, { status: 401 });
  }

  // 权限闸。导出的是**整个工作区**而非「我个人的数据」，团队场景下这等于一次性把公司资产
  // 打包成可离线传播的副本——editor/viewer 逐页看得到不代表该给他们这个动作。
  // 单人租户不受影响：他自己就是 owner。
  if (!can(session.role, 'data.export')) {
    return NextResponse.json(
      { error: '权限不足：全量数据导出仅工作区所有者与管理员可用，请联系工作区管理员' },
      { status: 403 },
    );
  }

  // 同源闸。导出包是这个账号的全部业务数据，只接受本站页面发起的下载：
  // 跨站虽然读不到响应体（CORS），但没有理由给它一个能把整库拉一遍的触发点。
  // sec-fetch-site 缺失（老浏览器/curl）时放行——它是加固，不是鉴权，鉴权在上面的会话上。
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') {
    return NextResponse.json({ error: '仅支持从站内发起导出' }, { status: 403 });
  }

  // 全量导出是重查询，限流按租户收口（团队里几个人同时点也共用这个额度）
  const rl = await checkRateLimit(tenantKey('account:export', session.tenantId), { limit: 10, windowMs: 3600_000 });
  if (!rl.ok) {
    return NextResponse.json({ error: `导出过于频繁，请${retryHint(rl.resetAt)}再试` }, { status: 429 });
  }

  const bundle = await buildAccountExport({ tenantId: session.tenantId, memberId: session.memberId });
  const day = beijingDayKey();
  const cnName = `烽火台数据导出_${day}.json`;

  return new NextResponse(JSON.stringify(bundle, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // 两份文件名：ASCII 兜底给不认 RFC 5987 的下载器，filename* 才是中文那份
      'content-disposition': `attachment; filename="beacon-export-${day}.json"; filename*=UTF-8''${encodeURIComponent(cnName)}`,
      'cache-control': 'no-store',
    },
  });
}
