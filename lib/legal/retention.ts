import { prisma } from '../db';
import { expireStaleTasks } from '../browser-task';
import { purgeParserScreenshots } from '../ingest/parser-learn';
import { purgeExpiredCovers } from '../media/store';
import { purgeExpiredComments } from '../ingest/reader-comments';
import { pruneStaleQuestions } from '../ingest/comment-questions';
import { purgeRemovedAccountData, type PurgeResult } from './removal';

// 保留期的**兑现闸**：把散在各写入路径上的到期清理，收成一次全库扫描（由 purge_retention 定时跑）。
//
// 【为什么必须有它】原先每处清理都挂在自己的写入路径上——ingestReaderComments 末尾调
// purgeExpiredComments、ingestCommentQuestions 末尾调 pruneStaleQuestions。那等于把
// 「到期删除」绑在「你还在继续用」上：一个采过评论、之后就不再打开插件的工作区，
// 那批第三方评论正文会**永远**留在库里。而三份隐私政策写死的是
// 「已留存的评论正文**无需任何操作**也会到期消失：满 90 天自动物理删除」。
// 这是政策承诺与代码不符，属于合规缺口，不是清理不及时的性能问题。
//
// 【为什么是一个 job 扫多张表，而不是一张表一个 job】保留期是同一件事的几个面，拆成几条 cron
// 只会让「又加了一张带保留期的表、却忘了给它加 cron」原样重演。下面这份清单就是
// 「所有带保留期的数据」的唯一入口：加表时改这一处，漏了在这里一眼能看出来。
//
// 【不看自动化开关】这些开关（Workspace.automationConfig）管的是「要不要替我干活」，
// 而删除第三方到期数据是对**第三方**的承诺，不是对工作区主人的服务——用户无权替评论作者
// 决定「他的话再多留一年」。所以本文件一律不查 automationAllows，也不排除演示工作区。

/**
 * 注销后仍留着的生成日志（LlmCallLog.tenantId = null）还能留多久。
 *
 * 隐私政策承诺的是「AI 调用日志按《网络安全法》第二十一条留存不少于六个月，注销时即刻摘除与
 * 您账号的关联，**期限届满后删除**」。摘除归属那半句 lib/account/delete.ts 做了；
 * 「期限届满后删除」那半句在此之前没有任何代码兑现——孤儿日志会一直躺在库里。
 *
 * 取 190 天而不是 183（六个月）：法条要求是「不**少于**六个月」，早删一天是违法，
 * 晚删一周只是多留一会儿。两侧代价不对称时往长了取。
 */
export const ORPHANED_LLM_LOG_RETENTION_DAYS = 190;

/**
 * AI 执行 / 工作流的运行记录留多久。
 *
 * 【为什么要有】AgentRun 存的是整段对话（含工具返回的结构化数据），AgentStep 一步一行，
 * WorkflowRun 存每步日志。它们此前**没有任何清理路径**——只增不减。
 * 手动跑的时候增长还算温和；2026-08-19 加了定时智能体之后，一个工作区可以
 * 每天自动产生 5 条（MAX_RUNS_PER_DAY），一年就是 1800 多条，而且没人会回头看半年前的。
 *
 * 【为什么是 90 天而不是更短】运行中心与「最近运行」列表本身只看最近几条，
 * 但用户排查「上个月那次为什么失败」是真实需求。取与读者原声同一档（90 天），
 * 少一个需要记的数字。
 *
 * AgentStep 靠 AgentRun 的外键 Cascade 带走，不用单独扫。
 */
export const RUN_LOG_RETENTION_DAYS = 90;

export type RetentionSweep = {
  /** 到期物理删除的读者原声正文条数（ReaderComment） */
  readerComments: number;
  /** 到期物理删除的 AI 封面张数（MediaAsset kind=cover，用户钉住的不删） */
  covers: number;
  /** 读者提问：转归档 / 到期删除（InspirationItem，source=comment|rival-comment） */
  commentQuestions: { archived: number; deleted: number };
  /** 注销时摘了租户归属、且已过法定留存期的生成日志 */
  orphanedLlmLogs: number;
  /** 到期删除的运行记录（AI 执行 / 工作流；AgentStep 随外键级联） */
  runLogs: { agentRuns: number; workflowRuns: number; staleQueued: number };
  /** 浏览器任务：标记为过期的 / 到期清掉的 */
  browserTasks: { expired: number; purged: number };
  /** 解析自学习：清空的超期失败现场截图张数（只清 screenshot 列，事件与骨架保留） */
  parserScreenshots: number;
  /** 已核验移除申请的重扫：扫了几条申请，以及这一趟补删掉了什么 */
  removals: { swept: number; purged: PurgeResult };
  /**
   * 出错的步骤。**不吞**：一步失败不连坐其余步骤（它们删的是不同的表，没有先后依赖），
   * 但必须原样交给调用方——一次静默失败的合规清理，和没有这个任务是一回事。
   */
  errors: { step: string; message: string }[];
};

const EMPTY_PURGE: PurgeResult = {
  accounts: 0, posts: 0, watchlistItems: 0, runs: 0, commentQuestions: 0, readerComments: 0,
};

/** 全库到期清理。不接 workspaceId：它扫的正是「已经没人再写入」的那些工作区。 */
export async function sweepRetention(): Promise<RetentionSweep> {
  const errors: RetentionSweep['errors'] = [];
  const step = async <T>(name: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      errors.push({ step: name, message: (e as Error).message });
      return fallback;
    }
  };

  // ① 读者原声正文：满 COMMENT_TEXT_PURGE_DAYS 天物理删除。不传 workspaceId = 全库。
  const readerComments = await step('reader_comments', () => purgeExpiredComments(), 0);

  // ①.5 生成的 AI 封面：满 COVER_RETENTION_DAYS 天自动删（用户钉住的不删）。
  //     形象库（用户主动存的人像/背景）**不在这里清**——那是他自己的素材，保存到他删或注销为止。
  const covers = await step('covers', () => purgeExpiredCovers(), 0);

  // ② 读者提问：满 STALE_DAYS 转归档、满 PURGE_DAYS 删除。同样不传 workspaceId。
  const commentQuestions = await step(
    'comment_questions',
    () => pruneStaleQuestions(),
    { archived: 0, deleted: 0 },
  );

  // ③ 注销遗留的生成日志。**只删 tenantId 为空的**：有租户归属的那些是计费账本的事实来源
  //（lib/quota.ts 用 llmCallLog.count 重建当日/当月计数器），删一条就是把用户已用的额度凭空还回去。
  const orphanedLlmLogs = await step('orphaned_llm_logs', async () => {
    const cutoff = new Date(Date.now() - ORPHANED_LLM_LOG_RETENTION_DAYS * 86_400_000);
    const r = await prisma.llmCallLog.deleteMany({ where: { tenantId: null, createdAt: { lt: cutoff } } });
    return r.count;
  }, 0);

  // ③.5 运行记录到期清理。只增不减的表迟早会变成库里最大的那张——
  //      定时智能体让它从「用户点一次涨一条」变成「每天自动涨几条」。
  const runLogs = await step(
    'run_logs',
    async () => {
      const cutoff = new Date(Date.now() - RUN_LOG_RETENTION_DAYS * 86_400_000);
      // 只删**已经结束**的：running / awaiting_confirm 那些还等着用户回来点确认，
      // 按时间删会把一个还活着的会话从中间截断
      // 排太久没轮上的先取消掉（queued 不是终态，下面那句 deleteMany 碰不到它——
      // 一条排在别人后面、而前面那些又都挂了的运行会**永久**占着排队名额）。
      // 顺序要紧：先取消再删，这样刚被取消的那些下一轮就能被清掉。
      const { cancelStaleQueued } = await import('../agent/tick');
      const staleQueued = await cancelStaleQueued();

      const [a, w] = await Promise.all([
        prisma.agentRun.deleteMany({
          where: { updatedAt: { lt: cutoff }, status: { in: ['done', 'failed', 'cancelled'] } },
        }),
        prisma.workflowRun.deleteMany({
          where: { updatedAt: { lt: cutoff }, status: { in: ['done', 'failed', 'cancelled'] } },
        }),
      ]);
      return { agentRuns: a.count, workflowRuns: w.count, staleQueued };
    },
    { agentRuns: 0, workflowRuns: 0, staleQueued: 0 },
  );

  // ③.6 浏览器任务：过期的标 expired（不是删——用户要能看见「那次没跑成，因为插件一直没打开」），
  //      同时把留在库里过久的已结束任务按运行记录同一档清掉。
  const browserTasks = await step(
    'browser_tasks',
    async () => {
      const expired = await expireStaleTasks();
      const cutoff = new Date(Date.now() - RUN_LOG_RETENTION_DAYS * 86_400_000);
      const purged = await prisma.browserTask.deleteMany({
        where: { updatedAt: { lt: cutoff }, status: { in: ['done', 'failed', 'expired', 'cancelled'] } },
      });
      return { expired, purged: purged.count };
    },
    { expired: 0, purged: 0 },
  );

  // ③.7 解析自学习的失败现场截图：满 30 天清空（隐私政策写的就是这个期限）。
  //      只清 screenshot 列——事件与脱敏骨架留着，运维台还要靠它们看历史。
  const parserScreenshots = await step('parser_screenshots', () => purgeParserScreenshots(), 0);

  // ④ 已核验移除申请的重扫。resolveRemovalRequest 在流转那一刻已经删过一遍，这是**第二道**：
  //    停采闸只挂在两条竞对通道上（lib/pipeline.ts、lib/ingest/competitor.ts），
  //    评论回传那条（app/api/ingest/questions）没过闸，被移除账号作品下的评论正文仍可能重新写进来。
  //    「核验后其名下作品的评论正文与提问会一并删除」是对权利人的承诺，不能只在流转的那一秒成立。
  //    ⚠️ 只扫 verified/removed。pending 是「待核验**先停采**」，核验没过就动手删数据，
  //    等于让任何人靠一张表单删掉别人的档案——那是比漏删更坏的错误。
  const removals = await step('removal_resweep', async () => {
    const reqs = await prisma.dataRemovalRequest.findMany({
      where: { status: { in: ['verified', 'removed'] } },
      select: { id: true, platform: true, handle: true },
      orderBy: { createdAt: 'asc' },
    });
    const purged: PurgeResult = { ...EMPTY_PURGE };
    for (const req of reqs) {
      // 单条申请出错不该让其余申请这一轮也不执行（同 daily_recommend 的 per-tenant 隔离）
      try {
        const r = await purgeRemovedAccountData(req.platform, req.handle);
        for (const k of Object.keys(purged) as (keyof PurgeResult)[]) purged[k] += r[k];
      } catch (e) {
        errors.push({ step: `removal_resweep:${req.id}`, message: (e as Error).message });
      }
    }
    return { swept: reqs.length, purged };
  }, { swept: 0, purged: { ...EMPTY_PURGE } });

  return { readerComments, covers, commentQuestions, orphanedLlmLogs, runLogs, browserTasks, parserScreenshots, removals, errors };
}
