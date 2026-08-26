import { prisma } from './db';

// 站内通知：外部机器人推送的通用兜底（人人可见的红点），与 pushEvent 并行使用。
// 旁路增强，写入失败绝不打断主流程。

export type NotifyKind = 'performance_alert' | 'review_ready' | 'weekly_review' | 'daily_recommend' | 'plan_expiry' | 'system';

export async function notify(params: {
  workspaceId: string;
  accountId?: string | null;
  kind: NotifyKind;
  refId?: string | null;
  title: string;
  body?: string;
  link?: string;
  /**
   * 只给这个人看（不填 = 工作区里人人可见，旧行为）。
   *
   * 【什么时候该填】这件事**只有他推得动**的时候：AI 执行的「等你确认」只有发起人能点，
   * 推给别人就是让他看着一件自己做不了的事。
   */
  memberId?: string | null;
}): Promise<void> {
  await prisma.notification
    .create({
      data: {
        workspaceId: params.workspaceId,
        accountId: params.accountId ?? null,
        memberId: params.memberId ?? null,
        kind: params.kind,
        refId: params.refId ?? null,
        title: params.title.slice(0, 120),
        body: (params.body ?? '').slice(0, 500),
        link: params.link ?? null,
      },
    })
    .catch(() => {});
}

/**
 * 未读红点数。
 *
 * memberId 传了就**只数「人人可见的」+「点名给他的」**——
 * 不过滤的话，同事会为一条自己推不动的「等你确认」而看到红点。
 */
export async function unreadNotificationCount(workspaceId: string, memberId?: string): Promise<number> {
  return prisma.notification.count({
    where: {
      workspaceId,
      read: false,
      ...(memberId ? { OR: [{ memberId: null }, { memberId }] } : {}),
    },
  });
}

export async function listNotifications(workspaceId: string, take = 12, memberId?: string) {
  return prisma.notification.findMany({
    where: {
      workspaceId,
      ...(memberId ? { OR: [{ memberId: null }, { memberId }] } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take,
  });
}

export async function markNotificationsRead(workspaceId: string, id?: string): Promise<void> {
  await prisma.notification.updateMany({
    where: id ? { id, workspaceId } : { workspaceId, read: false },
    data: { read: true },
  });
}
