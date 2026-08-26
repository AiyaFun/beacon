import { cookies } from 'next/headers';
import { can } from '@/lib/edition';
import type { NavGroup } from '@/lib/nav';
import { SHELL_COOKIE, DEFAULT_SHELL, TASK_NAV, isShellMode, type ShellMode } from '@/lib/shell';

// 外壳的**服务端**那一半：读 cookie、按形态过滤任务台导航。
//
// 单独一个文件是被真机逼出来的：`next/headers` 这个 import 原本在 lib/shell.ts 里，
// 而那个文件同时被客户端组件 ShellSwitch 引用（它要 SHELL_COOKIE / SHELL_LABEL）。
// 结果是 tsc 全绿、单测全绿，一打开页面直接 Build Error：
//   「You're importing a component that needs "next/headers"」。
// 规矩：常量与类型放 lib/shell.ts（两侧都能 import），一切碰 next/headers 或
// process.env（lib/edition）的放这里。

/**
 * 当前用户选的外壳。**必须在服务端读**——布局是 RSC，客户端 localStorage 到不了。
 *
 * 次序：cookie → 成员记录 → 默认。
 * · cookie 在最前面：切换要**当场生效**，不能等一次落库往返。
 * · 成员记录兜底：换设备、清缓存、换浏览器之后，用户选过的那套还在。
 *   只靠 cookie 的话「我选的默认」其实只是「这台机器这个浏览器的默认」。
 * · 都没有才用 DEFAULT_SHELL —— 那是**没选过的人**的默认，不是凌驾于选择之上的默认。
 */
export async function currentShell(memberShell?: string | null): Promise<ShellMode> {
  const v = (await cookies()).get(SHELL_COOKIE)?.value;
  if (isShellMode(v)) return v;
  if (isShellMode(memberShell ?? undefined)) return memberShell as ShellMode;
  return DEFAULT_SHELL;
}

/**
 * 按当前部署形态过滤出可见的任务台导航。
 *
 * 与工作台的 visibleNav() 是同一套判据（`can(requires)`），必须**由服务端算好再传**——
 * TaskSidebar 里那份清单最终交给客户端组件 NavList 渲染，而客户端读不到 BEACON_EDITION。
 * 走 NEXT_PUBLIC_ 就出现了第二个形态真相源，两个源迟早不一致
 *（典型后果：客户机器上侧栏藏了入口，端点却还活着）。
 */
export function visibleTaskNav(): NavGroup[] {
  return TASK_NAV.map((g) => ({ ...g, items: g.items.filter((it) => !it.requires || can(it.requires)) }))
    .filter((g) => g.items.length > 0);
}
