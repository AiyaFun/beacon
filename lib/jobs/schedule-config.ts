import type { JobName } from './types';
import { PUSH_TICK_MINUTES } from '../bot/push-window';

// 所有 cron 的时区口径。**必须显式指定**：容器（node:20-slim）里没有 TZ，系统时间是 UTC，
// 不传 tz 的话下面每一行都会晚 8 小时打在北京时间上——「每日 05:00 生成推荐」实际是北京 13:00，
// 用户中午才收到晨报（2026-07-28 生产实况）。改这个常量前先读 docs/机器人集成.md 的时区那一节。
export const SCHEDULE_TZ = 'Asia/Shanghai';

/**
 * 定时智能体的扫描间隔（分钟）。与 lib/workflow/schedule.ts 的窗口宽度是**同一个数**。
 * 必须定义在 SCHEDULES 之前：const 不提升，写在下面会在模块求值时抛 TDZ。
 */
export const AGENT_TICK_MINUTES = 10;

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
  // 广播型：保留期兑现闸。**这条不能删**——三份隐私政策写死了「已留存的评论正文无需任何操作
  // 也会到期消失：满 90 天自动物理删除」，而各处的到期清理原先只挂在自己的写入路径上，
  // 等于把「到期删除」绑在「你还在继续用」上。停止使用的工作区反而永久留着第三方数据。
  // 放在 04:00：夜间批量任务（05:00 起）之前跑完，删掉的行不会在同一轮里被别的任务读到一半。
  // 本机浏览器配方：每 6 小时一轮。**不敢更勤**——它在用户真实的 Chrome 里开标签，
  // 藏不住（CDP 没有后台标签，那是扩展才有的）。SaaS 上这条恒空转。
  { name: 'sweep_local_recipes', cron: '20 */6 * * *', note: '每 6 小时用本机浏览器把采集配方跑一遍（仅整机版且配了调试端点）' },
  { name: 'purge_retention', cron: '0 4 * * *', note: '每日 04:00 全库到期数据清理（评论正文/提问/AI 封面/孤儿日志/移除申请重扫）' },
  // 广播型：定时智能体。**间隔必须与 tickScheduledAgents 的 tickMinutes 一致**——
  // 那个函数用「到点后 tickMinutes 分钟内」当窗口，两者不一致要么漏跑要么一天跑两次。
  { name: 'run_scheduled_agents', cron: `*/${AGENT_TICK_MINUTES} * * * *`, note: `每 ${AGENT_TICK_MINUTES} 分钟扫到点的定时智能体` },
  // 广播型：AI 执行的兜底巡检。**与上面那条是两件事**——上面是「到点了发起新的」，
  // 这条是「已经在跑的那些卡住了没有」（等额度等到重置了、跑它的进程没了）。
  // 错开 5 分钟：0 点整那一下，定时智能体与额度重置恢复会一起涌上来。
  // **写成分钟列表而不是 `5-59/10`**：整机版的本地调度器（lib/jobs/local-scheduler.ts）
  // 不认 range-step 语法，写了它这条任务在整机版上永远不跑，且没有任何报错
  //（tests/jobs/local-scheduler.test.ts 就是为拦这个存在的，这次正是它抓到的）。
  { name: 'tick_agent_runs', cron: '5,15,25,35,45,55 * * * *', note: `每 ${AGENT_TICK_MINUTES} 分钟巡检卡住的 AI 执行（等额度到点的接着跑、跑飞的接手）` },
];
