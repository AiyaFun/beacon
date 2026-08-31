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
  /**
   * 同一个 refId 只发一次。**默认关**。
   *
   * 【为什么是 opt-in 而不是默认行为】表现异常、爆款加速这些本来就该在情况变化时再响一次，
   * 默认去重会把它们一起掐掉。真正需要「只说一次」的调用点自己声明。
   *
   * 【为什么会有这个参数：三处注释都写着一个不存在的行为】
   * schema 里 `refId String? // …用于同一对象去重`、lib/scrape/recipe.ts:340 与 :458
   * 都写着「notify 内部按 refId 合并」——而这个函数从头到尾就是一个裸 create，
   * 从来没有合并过。于是：
   *   · noticeStaleRecipes 的 refId 特意带了天数「免得被合并」，实际同一天内
   *     每 6 小时那条 cron 跑 4 轮，就发 4 条一模一样的；
   *   · lib/skill/distill.ts 的 `procedure-suggest:<指纹>` **没有天数分量**，
   *     注释写「同一种做法只提醒一次」，实际由 optimize_memory 每天 05:30 发，
   *     只要用户不去存成技能就**永远天天发**，而且没有形态闸，SaaS 上照样发。
   * 而 tests/scrape/resilience.test.ts 里还有一条守卫把这个错误信念钉住了
   *（只断言 refId 字符串里有天数，断不出「合并有没有发生」）。
   */
  once?: boolean;
}): Promise<void> {
  // 【去重做在这里，与本库既有口径一致】lib/agent/notify-run.ts:105、lib/insight/alert.ts、
  // lib/jobs/handlers.ts 三处都是「先查 refId 再发」。定时任务单跑，不存在并发竞态。
  if (params.once && params.refId) {
    const dup = await prisma.notification
      .count({ where: { workspaceId: params.workspaceId, refId: params.refId } })
      .catch(() => 0);
    if (dup > 0) return;
  }
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
