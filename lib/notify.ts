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
}): Promise<void> {
  await prisma.notification
    .create({
      data: {
        workspaceId: params.workspaceId,
        accountId: params.accountId ?? null,
        kind: params.kind,
        refId: params.refId ?? null,
        title: params.title.slice(0, 120),
        body: (params.body ?? '').slice(0, 500),
        link: params.link ?? null,
      },
    })
    .catch(() => {});
}

export async function unreadNotificationCount(workspaceId: string): Promise<number> {
  return prisma.notification.count({ where: { workspaceId, read: false } });
}

export async function listNotifications(workspaceId: string, take = 12) {
  return prisma.notification.findMany({
    where: { workspaceId },
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
