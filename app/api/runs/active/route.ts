import { NextResponse } from 'next/server';
import { getSessionOrNull } from '@/lib/session';
import { listRuns, KIND_LABEL } from '@/lib/runs';

export const dynamic = 'force-dynamic';

// 任务台首屏的「正在办的事」轮询用。
//
// 【为什么是 GET 接口而不是 server action】调 server action 会让 Next 重渲当前路由——
// 每 15 秒把整页（含布局里那五张表的查询）重跑一遍，而且用户正在看的位置会被打断。
// 这个坑本项目在「做完还要接着点的入口不能挂卡片里」那次已经踩过一次。
//
// 【只回没结束的】等你处理 + 进行中。历史清单在侧栏与运行中心各有一份，
// 轮询里带上只是让响应变大、让首屏多一份同源列表。

export async function GET() {
  const s = await getSessionOrNull();
  // 中间件已经拦过没有 cookie 的请求；这里再判一次是因为 cookie 可能已经过期。
  // 返回 401 而不是空数组：前端据此知道「该重新登录了」，而不是以为「没有任务」
  if (!s) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const rows = await listRuns(s.workspaceId, { takePerKind: 8 });
  const active = rows
    .filter((r) => r.status === 'waiting' || r.status === 'running')
    .slice(0, 8)
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      kindLabel: KIND_LABEL[r.kind],
      title: r.title,
      status: r.status,
      detail: r.detail,
      href: r.href,
      // 【这条是不是在等我】这一页是工作区级的，同事的运行也在列，而 AI 执行的
      // 「等你确认」只有发起人点得动。不区分的话，同事看到的是一张写着「等你处理」、
      // 点过去却必定报错的卡（/runs 不放确认按钮防的就是这件事）。
      // memberId 不带给前端：判定在服务端做完，前端只需要知道结论。
      mine: r.memberId ? r.memberId === s.memberId : true,
      waitingOn: r.memberId && r.memberId !== s.memberId ? r.memberName : undefined,
    }));

  return NextResponse.json({ rows: active });
}
