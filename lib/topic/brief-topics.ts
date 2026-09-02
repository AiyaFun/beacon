import { prisma } from '../db';
import type { BriefTopic } from './brief';

// 晨报取数（从 lib/jobs/handlers.ts 抽出来，2026-09-02）：机器人里说「给我今天的选题」也要用同一份。
//
// 不加 take——晨报要按队列分组，只取前 N 条会让「今日突击」这一队随机丢失，恰恰是最有时间压力的那一队。
// 条数上限由 brief.ts 按队列各自控制。
// 不按日期过滤是有意的：generateRecommendations 每轮会先清掉旧的 candidate/recommended 再写入，
// 库里 state='recommended' 的就是最新一轮的结果——而且容器跑在 UTC，
// 「北京 05:00 生成、09:00 推送」跨了 UTC 日界，按 UTC 自然日过滤反而会把当天的推荐全滤没。
export function briefTopicsFor(accountId: string): Promise<BriefTopic[]> {
  return prisma.topicIdea.findMany({
    where: { accountId, state: 'recommended' },
    orderBy: { totalScore: 'desc' },
    select: {
      title: true, totalScore: true, queue: true, angle: true,
      windowHint: true, sourceType: true, isExploration: true, mocked: true,
    },
  });
}
