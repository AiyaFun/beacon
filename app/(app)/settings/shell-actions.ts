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

/**
 * 探一下本机常见的调试端口，找到就直接填好。
 *
 * 【为什么值得有这个按钮】原来的流程是：托盘弹一句「请到设置把端点填成 http://127.0.0.1:9222」
 * → 用户切窗口 → 手打一遍。中间任何一步记错（打成 localhost:9222 少了协议、
 * 打成 9223）都会得到一个「配好了但连不上」的状态，而那个状态的报错在采集那一刻才出现。
 * 能探到就没必要让人手打。
 *
 * 【为什么只探本机的几个端口】和 vetCdpUrl 同一条边界：端点只能指向本机回环。
 * 这里连「让用户填一个远程地址去探」的入口都不给。
 */
export async function actDetectCdp(): Promise<{ ok: boolean; url?: string; error?: string }> {
  const s = await getSession();
  try {
    if (!can('localBrowser')) return { ok: false, error: '这个版本不提供本机浏览器驱动' };
    requireRole(s, 'byok.manage');

    // 9222 是 Chrome 的约定端口；后面两个是用户手动指定过其他端口时的常见取值。
    // 不做端口扫描——那既慢又像在做别的事情
    for (const port of [9222, 9223, 9333]) {
      const url = `http://127.0.0.1:${port}`;
      try {
        // /json/version 是 CDP 的握手端点：**能连上 ≠ 是个浏览器**，
        // 本机随便一个服务都可能占着 9222。必须看它答的是不是 CDP
        const res = await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(1200) });
        if (!res.ok) continue;
        const j = (await res.json()) as { Browser?: string; webSocketDebuggerUrl?: string };
        if (!j?.webSocketDebuggerUrl) continue;
        const v = vetCdpUrl(url);
        if (!v.ok) continue;
        await prisma.workspace.update({ where: { id: s.workspaceId }, data: { browserCdpUrl: v.url } });
        revalidatePath('/settings');
        return { ok: true, url: `${v.url}（${j.Browser ?? '浏览器'}）` };
      } catch { /* 这个端口没有就试下一个，探测失败不是错误 */ }
    }
    return {
      ok: false,
      error: '没找到带调试端口的浏览器。先用客户端托盘里的「启动采集浏览器」把 Chrome 起起来，再点这里。',
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * 「浏览器操作」一个开关（2026-09-03）。
 *
 * 用户的原话：「需要类似 Claude Code 一样获得 Computer use 和 Browser use 的权限设置」——
 * 那个模型是一个开关，点了就能用，没有「先去托盘启动、再回来手填端点」这两跳。
 * 整机版的服务就跑在用户自己的电脑上，所以服务端能自己把 Chrome 带端口拉起来（lib/browser/launch.ts），
 * 拉起来了才写库；拉不起来（Chrome 正开着没端口 / 没装 Chrome）就如实说，**不写一个连不上的端点**。
 * 关：直接清空，不动浏览器（他可能正在用）。
 */
export async function actToggleLocalBrowser(on: boolean): Promise<{ ok: boolean; url?: string; started?: boolean; error?: string }> {
  const s = await getSession();
  try {
    if (!can('localBrowser')) return { ok: false, error: '这个版本不提供本机浏览器驱动' };
    requireRole(s, 'byok.manage');
    if (!on) {
      await prisma.workspace.update({ where: { id: s.workspaceId }, data: { browserCdpUrl: null } });
      revalidatePath('/settings');
      return { ok: true };
    }
    const { ensureLocalBrowser } = await import('@/lib/browser/launch');
    const r = await ensureLocalBrowser();
    if (!r.ok) return { ok: false, error: r.error };
    const v = vetCdpUrl(r.url);
    if (!v.ok) return { ok: false, error: v.error };
    await prisma.workspace.update({ where: { id: s.workspaceId }, data: { browserCdpUrl: v.url } });
    revalidatePath('/settings');
    return { ok: true, url: v.url!, started: r.started };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
