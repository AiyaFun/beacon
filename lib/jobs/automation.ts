import { parseJson } from '../json';
import type { JobName } from './types';

// 自动化任务开关（按工作区）。控制平面：settings 页可关可调；批租户型定时任务据此门控。
// 缺省全部取「默认值」——多数为开，保证既有全自动行为不因引入开关而改变。
// 预警类默认关（opt-in，打扰型功能不主动开），是依赖健康度红线。

export type AutomationKey =
  | 'dailyRecommend'
  | 'autoBackfill'
  | 'autoReview'
  | 'weeklyReview'
  | 'alerts'
  | 'optimizeMemory'
  | 'pluginAutoSubscribe';

export type AutomationConfig = Record<AutomationKey, boolean>;

// 每个开关的元信息（UI 渲染 + 对应定时任务）。job=null 表示事件驱动、无「立即运行」（如预警）。
export const AUTOMATION_ITEMS: {
  key: AutomationKey;
  label: string;
  desc: string;
  job: JobName | null; // 「立即运行」对应的任务；null=事件驱动
  default: boolean;
  advanced?: boolean;
}[] = [
  { key: 'dailyRecommend', label: '每日选题推荐', desc: '每天清晨为账号生成今日选题推荐并推送', job: 'daily_recommend', default: true },
  { key: 'autoBackfill', label: '数据自动同步', desc: '按里程碑自动回流已发布内容前 7 天的真实表现（需商业数据源或插件）', job: 'backfill_metrics', default: true },
  { key: 'autoReview', label: '自动复盘', desc: '内容发布满 7 天、数据齐全时自动生成 AI 复盘', job: 'generate_reviews', default: true },
  { key: 'weeklyReview', label: '周度运营复盘', desc: '每周一自动生成本周运营复盘并推送', job: 'weekly_review', default: true },
  { key: 'alerts', label: '爆款/异常预警', desc: '发布后数据增速显著偏离基线时提醒（默认关，避免打扰）', job: null, default: false },
  { key: 'optimizeMemory', label: '记忆自动优化', desc: '定期对长期记忆去重、生效与遗忘', job: 'optimize_memory', default: true, advanced: true },
  // 插件「边逛边建档」。默认开＝保持既有行为（用户要的是「最傻瓜、全程不用太多操作」）。
  // 之所以要有这个开关：CompetitorAccount 是**全局共享表**，浏览即写入是个有产品影响的语义，
  // 以前它只写死在 zod 的 .default(true) 里，用户既看不见也关不掉。
  { key: 'pluginAutoSubscribe', label: '插件边逛边建档', desc: '用插件打开某个创作者主页时，自动把他建档并加入本工作区竞对监控（关掉后只补充已订阅对象的数据）', job: null, default: true, advanced: true },
];

const DEFAULTS: AutomationConfig = AUTOMATION_ITEMS.reduce(
  (acc, it) => ({ ...acc, [it.key]: it.default }),
  {} as AutomationConfig,
);

export function readAutomationConfig(raw: string | null | undefined): AutomationConfig {
  const parsed = parseJson<Partial<Record<AutomationKey, unknown>>>(raw ?? '{}', {});
  const out = { ...DEFAULTS };
  for (const it of AUTOMATION_ITEMS) {
    if (typeof parsed[it.key] === 'boolean') out[it.key] = parsed[it.key] as boolean;
  }
  return out;
}

// 该工作区是否允许某自动化项（缺省按默认，多数为开）
export function automationAllows(raw: string | null | undefined, key: AutomationKey): boolean {
  return readAutomationConfig(raw)[key];
}

// 清洗用户提交的开关（只认已知 key 的布尔值），合并进现有配置
export function sanitizeAutomationConfig(current: string | null | undefined, patch: Partial<Record<string, unknown>>): AutomationConfig {
  const merged = readAutomationConfig(current);
  for (const it of AUTOMATION_ITEMS) {
    if (typeof patch[it.key] === 'boolean') merged[it.key] = patch[it.key] as boolean;
  }
  return merged;
}
