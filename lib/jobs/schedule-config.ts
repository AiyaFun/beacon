import type { JobName } from './types';
import { PUSH_TICK_MINUTES } from '../bot/push-window';

// 所有 cron 的时区口径。**必须显式指定**：容器（node:20-slim）里没有 TZ，系统时间是 UTC，
// 不传 tz 的话下面每一行都会晚 8 小时打在北京时间上——「每日 05:00 生成推荐」实际是北京 13:00，
// 用户中午才收到晨报（2026-07-28 生产实况）。改这个常量前先读 docs/机器人集成.md 的时区那一节。
export const SCHEDULE_TZ = 'Asia/Shanghai';

// 三轨定时表（生产 worker 注册）。cron 语法：分 时 日 月 周，时区见 SCHEDULE_TZ（北京时间）。
export const SCHEDULES: { name: JobName; cron: string; note: string }[] = [
  // 广播型：热榜高频采集（成本不随租户涨）
  { name: 'ingest_hot', cron: '*/30 * * * *', note: '每 30 分钟采集 9 源热榜' },
  { name: 'cluster_topics', cron: '5,35 * * * *', note: '采集后 5 分钟做跨源聚类' },
  { name: 'crawl_competitors', cron: '0 */2 * * *', note: '每 2 小时采集竞对作品' },
  // 批租户型：夜间为所有活跃账号生成今日推荐
  { name: 'daily_recommend', cron: '0 5 * * *', note: '每日 05:00 生成今日推荐（06:00 前就绪）' },
  // 批租户型：晨报出站。**生成**在清晨固定跑，**推送**按每个机器人自己配的时刻走
  // （设置页「每日定时推送时间」，默认 09:00）——所以这里是每 10 分钟扫一遍到点的机器人，
  // 而不是把推送时刻写死在 cron 里。间隔必须与 PUSH_TICK_MINUTES 一致，见 push-window.ts。
  { name: 'push_daily_brief', cron: `*/${PUSH_TICK_MINUTES} * * * *`, note: '每 10 分钟扫到点的机器人，推今日选题晨报' },
  // 批租户型：常青储备补货。与今日推荐分开跑，因为它是**水位线触发**而非每日重来——
  // 储备够的账号一次 LLM 都不调用，只有低于水位线的才补。放在推荐之后，
  // 这样「今天热点断供 → 推荐很少」的账号，紧接着就能把常青储备补上。
  { name: 'replenish_evergreen', cron: '20 5 * * *', note: '每日 05:20 常青储备低于水位线时补货' },
  // 事件驱动（也挂一个兜底定时）：发布回流快照
  { name: 'backfill_metrics', cron: '0 */6 * * *', note: '每 6 小时回流已发布内容表现' },
  // 批租户型：记忆持续学习优化（回流之后跑，用最新绩效反哺）
  { name: 'optimize_memory', cron: '30 5 * * *', note: '每日 05:30 记忆去重/生效/遗忘 + 推学习小结' },
  // 批租户型：发布满 7 天自动生成 AI 复盘（回流之后跑，用逐日数据出复盘）
  { name: 'generate_reviews', cron: '0 9 * * *', note: '每日 09:00 为发布满 7 天且数据齐的内容自动复盘' },
  // 批租户型：每周一运营周报
  { name: 'weekly_review', cron: '0 8 * * 1', note: '每周一 08:00 生成上周运营复盘并推送' },
  // 批租户型：到期/续费提醒。放在 10:00——早于它的几条任务都在忙生成，
  // 而这条是要人看见并去付款的，白天推达率更高。
  { name: 'plan_expiry_notice', cron: '0 10 * * *', note: '每日 10:00 扫将到期/刚到期的套餐并提醒续费' },
];
