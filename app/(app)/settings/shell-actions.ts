'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { requireRole } from '@/lib/rbac';
import { can } from '@/lib/edition';
import { vetCdpUrl } from '@/lib/browser/local';

// 本机命令执行的配置。
//
// 【三道必须在服务端再判一次的】① 形态（SaaS 恒 false）② 角色（与密钥同级，
// 不是谁都能开）③ 命令名不许带路径。界面上判过不算数——action 是可以被直接调的。

export async function actSaveShellPolicy(
  input: { enabled: boolean; allow: string; root: string; full: boolean; timeoutSec: string; cdpUrl?: string },
): Promise<{ ok: boolean; error?: string }> {
  const s = await getSession();
  try {
    // SaaS 上这个 action 存在但永远拒绝：服务在我们机房，开了等于给模型别人的数据
    if (!can('localShell')) return { ok: false, error: '这个版本不提供本机命令执行' };
    requireRole(s, 'byok.manage'); // owner/admin，与密钥同级

    const root = input.root.trim();
    // 命令名逐个校验：带路径的一律拒（允许 git ≠ 允许 /tmp/git）
    const allow = input.allow.split(/\s+/).map((x) => x.trim()).filter(Boolean);
    const bad = allow.find((c) => c.includes('/') || c.includes('\\'));
    if (bad) return { ok: false, error: `命令名不能带路径：${bad}` };
    // 开了却没给目录 = 没有边界。宁可不让开，也不接受「全机器可动」
    if (input.enabled && !root) return { ok: false, error: '开启前必须指定工作目录' };

    // 超时收在 1..1800 秒。上限 30 分钟——再长的活该做成后台任务，
    // 而不是挂着一次工具调用等它（那一整段时间里这次执行是卡住的）
    const secs = Math.min(Math.max(parseInt(input.timeoutSec, 10) || 20, 1), 1800);

    // 浏览器调试端点：留空=关闭；填了就必须过「只能指向本机」那道闸。
    // 在这里就判，而不是等真去连的时候——那时候用户已经以为自己配好了。
    const cdpRaw = (input.cdpUrl ?? '').trim();
    let cdp: string | null = null;
    if (cdpRaw) {
      if (!can('localBrowser')) return { ok: false, error: '这个版本不提供本机浏览器驱动' };
      const v = vetCdpUrl(cdpRaw);
      if (!v.ok) return { ok: false, error: v.error };
      cdp = v.url!;
    }

    await prisma.workspace.update({
      where: { id: s.workspaceId },
      data: {
        shellEnabled: input.enabled,
        shellAllow: JSON.stringify(allow),
        shellRoot: root || null,
        shellExecMode: input.full ? 'full' : 'allowlist',
        shellTimeoutSec: secs,
        browserCdpUrl: cdp,
      },
    });
    revalidatePath('/settings');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '保存失败' };
  }
}
