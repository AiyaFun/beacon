import { TOPIC_QUEUES, TOPIC_SOURCE_LABEL } from '../constants';
import type { TopicQueue } from './queue';

// 选题晨报：把「今日推荐已生成」这条通知，从一个分数排行榜改写成一份可直接照着干的排产单。
//
// 【为什么值得单独做】daily_recommend 每天 05:00 已经在跑，机器人通道（飞书/企微/钉钉/TG/Slack）
// 也早就通了，此前推的却是「Top3 标题 + 分数」——用户看完还得打开网页才知道先做哪个、为什么推这条。
// 晨报把三件事一次说完：**按时间队列排好序**、**每条带切入角**、**有窗口的标出还剩多久**。
//
// 纯函数、无 IO：措辞是产品契约（用户每天只看这一条通知），必须能被单测钉死。

export type BriefTopic = {
  title: string;
  totalScore: number;
  queue: string;
  angle: string;
  windowHint?: string | null;
  sourceType: string;
  isExploration: boolean;
  mocked: boolean;
};

// 每队最多列几条。晨报是通知不是列表页——超过三条就没人读完了，剩下的引导到网页看。
const PER_QUEUE = 3;

export type DailyBrief = {
  title: string;
  lines: string[];
  // 站内信正文（纯文本，无 markdown）；机器人卡片用 lines
  summary: string;
};

function scoreTag(t: BriefTopic): string {
  return t.mocked ? '`示例分`' : `\`${Math.round(t.totalScore)} 分\``;
}

// 生成晨报。没有任何可推的选题时返回 null——宁可不推，也不推一条「今天没有推荐」的空通知
// （那是噪声：用户没法对它做任何事，只会训练他忽略这个渠道）。
export function buildDailyBrief(accountName: string, topics: BriefTopic[]): DailyBrief | null {
  if (topics.length === 0) return null;

  const lines: string[] = [];
  const counts: string[] = [];

  for (const q of TOPIC_QUEUES) {
    const list = topics
      .filter((t) => (t.queue || 'today') === q.key)
      .sort((a, b) => b.totalScore - a.totalScore);
    if (list.length === 0) continue;
    counts.push(`${q.name} ${list.length}`);
    lines.push(`${q.icon} **${q.name}**（${list.length} 条）`);
    for (const t of list.slice(0, PER_QUEUE)) {
      const source = TOPIC_SOURCE_LABEL[t.sourceType]?.name;
      const tags = [source, t.isExploration ? '探索位' : ''].filter(Boolean).join(' · ');
      lines.push(`　${t.title} ${scoreTag(t)}${tags ? `　${tags}` : ''}`);
      if (t.angle) lines.push(`　　切入角：${t.angle}`);
      // 窗口提示只在有硬时限的队列里说。给一条常青题标「还剩 N 小时」是假紧迫感，
      // 用户被骗一次之后，真正的抢跑提醒也会被他一并无视。
      if (t.windowHint && q.key !== 'evergreen') lines.push(`　　⏳ ${t.windowHint}`);
    }
    if (list.length > PER_QUEUE) lines.push(`　…另有 ${list.length - PER_QUEUE} 条，去网页看全部`);
  }

  if (lines.length === 0) return null;
  return {
    title: `📋 今日选题晨报 · ${accountName}`,
    lines,
    summary: `${counts.join('，')}。${topics[0].title}（${Math.round(topics[0].totalScore)} 分）等，点开看差异化切入角与推荐依据。`,
  };
}

// 队列计数（供 job 记账用，别让 detail 只说「推了 N 条」而不说推的是什么结构）
export function countByQueue(topics: BriefTopic[]): Record<TopicQueue, number> {
  const out: Record<TopicQueue, number> = { today: 0, week: 0, evergreen: 0 };
  for (const t of topics) {
    const q = (t.queue || 'today') as TopicQueue;
    if (q in out) out[q]++;
  }
  return out;
}
