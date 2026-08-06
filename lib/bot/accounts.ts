import { prisma } from '../db';
import { platformName } from '../constants';

// 「这条消息说的是哪个账号」——群里对话与体检共用的一处解析。
//
// 【为什么单独抽出来】工作区可以有多个创作者账号，而群里的人不会每句话都报账号名。
// 之前的入站收录直接取「第一个活跃账号」，多账号工作区里就会把选题记到别人名下——
// /data 全按 accountId 过滤，记错了页面上彻底看不见，且污染那个账号的基线。
// 所以这里的原则是：**能确定就用，确定不了就问，绝不猜**。

export type ResolvedAccount = { id: string; name: string; platform: string };

export type AccountResolution =
  | { ok: true; account: ResolvedAccount; source: 'named' | 'bound' | 'only' }
  | { ok: false; message: string };

export async function listActiveAccounts(workspaceId: string): Promise<ResolvedAccount[]> {
  return prisma.creatorAccount.findMany({
    where: { workspaceId, status: 'active' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true, platform: true },
  });
}

export function accountLine(a: ResolvedAccount): string {
  return `${a.name}（${platformName(a.platform)}）`;
}

/**
 * 解析目标账号。
 *   name 有值   → 按名字匹配（精确优先，其次包含）；匹配不到/匹配多个都如实回问。
 *   有群绑定    → 用绑定账号（绑定的号被删/停用则退回下一档，并在文案里说明）。
 *   只有一个号  → 用它。
 *   多个号未绑定 → 不猜，列出让用户 /账号 <名字> 绑定或 /分析 <名字> 指定。
 */
export async function resolveAccount(
  workspaceId: string,
  opts: { name?: string; boundId?: string | null } = {},
): Promise<AccountResolution> {
  const accounts = await listActiveAccounts(workspaceId);
  if (accounts.length === 0) {
    return { ok: false, message: '这个工作区还没有创作者账号。先去烽火台建一个账号，机器人才知道该分析谁。' };
  }

  const name = (opts.name ?? '').trim();
  if (name) {
    const exact = accounts.filter((a) => a.name === name);
    const fuzzy = exact.length ? exact : accounts.filter((a) => a.name.includes(name) || name.includes(a.name));
    if (fuzzy.length === 1) return { ok: true, account: fuzzy[0], source: 'named' };
    if (fuzzy.length > 1) {
      return { ok: false, message: `「${name}」匹配到多个账号：${fuzzy.map(accountLine).join('、')}。请写全名。` };
    }
    return { ok: false, message: `没找到叫「${name}」的账号。当前可选：${accounts.map(accountLine).join('、')}` };
  }

  if (opts.boundId) {
    const bound = accounts.find((a) => a.id === opts.boundId);
    if (bound) return { ok: true, account: bound, source: 'bound' };
    // 绑定的号已被删或停用：继续往下走，但不能装作无事发生
  }

  if (accounts.length === 1) return { ok: true, account: accounts[0], source: 'only' };

  return {
    ok: false,
    message: [
      `这个工作区有 ${accounts.length} 个账号：${accounts.map(accountLine).join('、')}。`,
      '我不替你猜是哪个——发「/账号 名字」把本群固定到一个账号，或直接「/分析 名字」指定这一次。',
    ].join('\n'),
  };
}
