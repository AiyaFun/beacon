'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { SHELL_COOKIE, SHELL_LABEL, SHELL_HINT, type ShellMode } from '@/lib/shell';
import { actSetShellMode } from '@/app/(app)/actions';

// 外壳切换：工作台 ⇄ 任务台。**两种模式功能完全对等**，差的只是按什么排
//（工作台按阶段，任务台按「我要什么」）——所以这里切的是排法，不是功能多少。
//
// 【cookie + 落库，两个都要】
//   · cookie：布局是 RSC，模式必须服务端可读（localStorage 到不了）。客户端写 +
//     router.refresh() 就当场生效，不用等一次 action 往返。它不含敏感信息、
//     不参与鉴权，所以没有 httpOnly 的必要。
//   · 落库（Member.shellMode）：cookie 只是「这台机器这个浏览器」的记忆。用户说的是
//     「我选哪种就一直用哪种」，那就得跟着人走——换电脑、清缓存之后还在。
//     它在 startTransition 里顺手发出去，失败也不打断切换（纯偏好，见 actSetShellMode）。
//
// 【为什么常驻顶栏】切换器是这两套排法之间唯一的门。藏进设置页的话，
// 用户第一次点错了就再也找不回来。
export function ShellSwitch({ mode }: { mode: ShellMode }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function pick(next: ShellMode) {
    if (next === mode) return;
    // 一年有效期：这是个偏好，不该每次开浏览器都退回默认
    document.cookie = `${SHELL_COOKIE}=${next}; path=/; max-age=${365 * 24 * 3600}; samesite=lax`;
    start(async () => {
      // 落库在前、刷新在后：反过来的话 refresh 拿到的还是旧行（虽然 cookie 已经对了，
      // 结果一样，但下次跨设备读到的会是上一次的选择）
      await actSetShellMode(next);
      router.refresh();
    });
  }

  return (
    <div className="shell-switch hide-mobile" role="group" aria-label="界面模式">
      {(['workbench', 'taskdeck'] as const).map((m) => (
        <button
          key={m}
          type="button"
          className={`shell-opt${m === mode ? ' active' : ''}`}
          aria-pressed={m === mode}
          title={SHELL_HINT[m]}
          disabled={pending}
          onClick={() => pick(m)}
        >
          {SHELL_LABEL[m]}
        </button>
      ))}
    </div>
  );
}
