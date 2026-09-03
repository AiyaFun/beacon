// 运行状态的展示口径。**纯函数、零依赖**——这个文件会被客户端组件 import。
//
// 【为什么单独一个文件】lib/runs/index.ts 引了 prisma。客户端组件（任务台首页的活动条）
// import 它会把 prisma 一起打进浏览器包：tsc 全绿、单测全绿，**只有真机打开页面才 Build Error**。
// 本项目在 lib/shell.ts 引 next/headers 那次踩过同一个形状，规矩是：
// 常量与纯函数放能被两侧 import 的文件，一切碰数据库/请求上下文的留在服务端文件里。

/** 五类跑动记录收敛后的统一状态。 */
export type RunStatus = 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';

export type RunKind = 'agent' | 'workflow' | 'collect' | 'publish' | 'browser';

export type RunStep = { seq: number; kind: string; tool: string; ok: boolean; result: string };

export type RunEntry = {
  id: string;
  kind: RunKind;
  title: string;
  status: RunStatus;
  at: Date;
  detail?: string;
  href: string;
  accountName?: string;
  memberId?: string;
  memberName?: string;
  steps?: RunStep[];
};

/**
 * 活动条上那枚徽章：文字与配色。
 *
 * 【这条判定有一个走反了不会报错的分支】同事发起的运行也在这个列表里
 *（工作区级，刻意的——跨账号跨人都该看得见），而 AI 执行的「等你确认」
 * 只有发起人点得动。印成第二人称「等你处理」就是叫人去点一个必定报错的按钮，
 * 正是 /runs 不放确认按钮所防的那件事。
 */
export function activeBadge(r: { status: RunStatus; mine?: boolean; waitingOn?: string }): { cls: string; text: string } {
  if (r.status !== 'waiting') return { cls: 'badge-gray', text: '进行中' };
  // mine 缺省按 true：没有发起人概念的那几类（采集、发布、插件任务）本来就是谁都能推的
  if (r.mine === false) return { cls: 'badge-gray', text: `等 ${r.waitingOn || '同事'}` };
  return { cls: 'badge-accent', text: '等你处理' };
}
