import { readPersona, type PersonaCard } from '../../persona';
import { nicheWord } from './evergreen';
import type { Candidate } from '../scoring';

// 候选源：可预测热点日历。
//
// 【为什么腰部创作者更需要这个】突发热点是拼手速的游戏，头部账号有团队、有存稿、有分发量，
// 普通创作者抢不过。但节点性热点不一样——618 一定会来、开学季一定会来，**赢的方式是提前量**。
// 提前 10 天准备好的内容，和当天临时起意的内容，不在一个水平上。
// 这也是唯一一个对「零数据新用户」立刻生效的候选源：不需要热榜、不需要竞对、不需要历史作品。
//
// 【零依赖】纯日期计算 + 一张人工维护的表。无网络、无 LLM、无数据库。
//
// 【队列固定 week，绝不进今日突击】日历节点的全部价值就是提前量。
// 一个还有 10 天才到的节点被塞进「今天不做就没了」，等于亲手毁掉这个源的定位。

// ── 日期解析 ──

// 公历固定日（月/日）
type FixedRule = { kind: 'fixed'; month: number; day: number };
// 第 n 个星期几（如母亲节 = 5 月第 2 个周日）
type NthRule = { kind: 'nth'; month: number; weekday: number; nth: number };
// 农历/节气：**必须查表**。这类日期没有简洁准确的公式，硬算不如硬写。
type TableRule = { kind: 'table' };

type DateRule = FixedRule | NthRule | TableRule;

// 农历节日与节气的逐年日期表（人工维护）。
//
// 这张表**每年年底必须续期**。tests/topic/calendar.test.ts 里有一条用例会在覆盖不足时变红，
// 那不是测试写错了，是在提醒你续表。表里没有的年份 → 该节点当年**整个跳过**（不猜、不外推）：
// 一个日期错了的「节点提醒」比没有提醒更糟——用户会按它排产。
export const LUNAR_TABLE_YEARS = [2026, 2027] as const;
const LUNAR_TABLE: Record<string, Record<number, [number, number]>> = {
  // key: [月, 日]
  cny: { 2026: [2, 17], 2027: [2, 6] }, // 春节（正月初一）
  lantern: { 2026: [3, 3], 2027: [2, 20] }, // 元宵（正月十五）
  qingming: { 2026: [4, 5], 2027: [4, 5] }, // 清明（节气，法定假日）
  dragonboat: { 2026: [6, 19], 2027: [6, 9] }, // 端午（五月初五）
  qixi: { 2026: [8, 19], 2027: [8, 8] }, // 七夕（七月初七）
  midautumn: { 2026: [9, 25], 2027: [9, 15] }, // 中秋（八月十五）
  chongyang: { 2026: [10, 18], 2027: [10, 8] }, // 重阳（九月初九）
  dongzhi: { 2026: [12, 22], 2027: [12, 22] }, // 冬至（节气）
};

export type CalendarNode = {
  key: string;
  name: string;
  rule: DateRule;
  // 提前多少天开始推。大制作节点（春节/618/双11）给足准备期，小节点短一些。
  leadDays: number;
  // 节点体量评级 0-1：**这不是实时热度，是「这个节点每年确定带来多大流量」的人工评级**，
  // 与热榜的 heat 不是同一种东西。之所以需要它，是因为不给的话（heat=0）日历候选
  // 在粗排里永远输给任意一条热榜候选，这个源等于白做。
  // 评级偏保守并在 candidate 里封顶（见 IMPORTANCE_CAP），真热点仍能压过它。
  importance: number;
  // 该节点的内容切题方式。{n} 会替换成账号赛道词；不含 {n} 的则是赛道无关的通用表述。
  // 与常青题同一套思路：**题目由可 review 的模板出，LLM 只负责差异化角度和评分**。
  topic: string;
  // 给精排和用户看的「为什么这个节点值得做」
  why: string;
};

// 节点表。改这张表 = 改产品供给，属于要 review 的产品决策。
export const CALENDAR_NODES: CalendarNode[] = [
  // ── 大促（内容电商的确定性流量高峰）──
  { key: 'sales618', name: '618 大促', rule: { kind: 'fixed', month: 6, day: 18 }, leadDays: 21, importance: 0.9,
    topic: '618 期间，{n}相关的东西到底值不值得买', why: '年中最大消费决策窗口，带货与测评类内容的搜索量在前两周就开始爬升' },
  { key: 'sales1111', name: '双11', rule: { kind: 'fixed', month: 11, day: 11 }, leadDays: 24, importance: 0.95,
    topic: '双11 前，{n}怎么挑不踩坑', why: '全年最大消费决策窗口，比价与避坑类内容提前两三周就有流量' },
  { key: 'sales1212', name: '双12', rule: { kind: 'fixed', month: 12, day: 12 }, leadDays: 12, importance: 0.6,
    topic: '双12 补货清单：{n}这几样值得囤', why: '双11 漏买的补位窗口，决策周期短、转化快' },
  { key: 'newyeargoods', name: '年货节', rule: { kind: 'fixed', month: 1, day: 15 }, leadDays: 20, importance: 0.7,
    topic: '年货节，{n}相关的年货怎么备', why: '春节前的集中采购期，礼品与囤货类内容需求集中爆发' },

  // ── 学业与职业节点（人生阶段性刚需，搜索意图极明确）──
  { key: 'gaokao', name: '高考', rule: { kind: 'fixed', month: 6, day: 7 }, leadDays: 14, importance: 0.85,
    topic: '高考这几天，{n}这个角度想聊聊', why: '全民关注度最高的固定事件之一，几乎每个赛道都能找到关联切口' },
  { key: 'zhiyuan', name: '高考志愿填报', rule: { kind: 'fixed', month: 6, day: 25 }, leadDays: 10, importance: 0.8,
    topic: '报志愿这件事，{n}行业的真实情况是这样', why: '志愿季的行业科普有极强搜索意图，且能沉淀成长期被检索的内容' },
  { key: 'schoolstart', name: '秋季开学季', rule: { kind: 'fixed', month: 9, day: 1 }, leadDays: 14, importance: 0.7,
    topic: '开学季，刚入门{n}该准备什么', why: '新人集中涌入的时点，入门向内容的转粉效率全年最高' },
  { key: 'schoolstart2', name: '春季开学季', rule: { kind: 'fixed', month: 3, day: 1 }, leadDays: 10, importance: 0.5,
    topic: '新学期开始，{n}怎么重新起步', why: '规模小于秋季但同样是「重新开始」的心理节点' },
  { key: 'graduation', name: '毕业季', rule: { kind: 'fixed', month: 6, day: 20 }, leadDays: 21, importance: 0.7,
    topic: '毕业季，关于{n}我想对刚出校门的人说', why: '身份转换期的迷茫最强，建议类内容的收藏与转发率高' },
  { key: 'kaoyan', name: '考研', rule: { kind: 'fixed', month: 12, day: 21 }, leadDays: 14, importance: 0.6,
    topic: '考研前后，{n}这条路值不值得走', why: '选择焦虑集中期，「另一条路」类内容有天然受众' },
  { key: 'jinsanyinsi', name: '金三银四跳槽季', rule: { kind: 'fixed', month: 3, day: 5 }, leadDays: 14, importance: 0.7,
    topic: '跳槽季，{n}这行现在什么情况', why: '春季求职高峰，行业现状与面试类内容需求集中' },
  { key: 'jiujinshiyin', name: '金九银十跳槽季', rule: { kind: 'fixed', month: 9, day: 5 }, leadDays: 14, importance: 0.6,
    topic: '秋招季，{n}的机会在哪里', why: '秋季求职高峰，与春季同源但受众更偏应届' },

  // ── 季节性长窗口（补全年空档：不加这几个，7-8 月会有连续 38 天没有任何节点）──
  { key: 'summervacation', name: '暑假季', rule: { kind: 'fixed', month: 7, day: 10 }, leadDays: 21, importance: 0.65,
    topic: '暑假这两个月，{n}可以怎么安排', why: '学生与家庭在线时长全年峰值，长内容与系统性内容的最好窗口' },
  { key: 'summerpeak', name: '暑期档', rule: { kind: 'fixed', month: 8, day: 1 }, leadDays: 20, importance: 0.6,
    topic: '暑期档正热，{n}这个角度值得聊', why: '影视、出游、消费同时进入高峰，蹭势的切口最多' },
  { key: 'consumerday', name: '315 消费者权益日', rule: { kind: 'fixed', month: 3, day: 15 }, leadDays: 12, importance: 0.65,
    topic: '315 前后，{n}行业里那些坑该说清楚了', why: '维权与避坑话题的年度高峰，测评类内容公信力最容易建立' },
  { key: 'may20', name: '520', rule: { kind: 'fixed', month: 5, day: 20 }, leadDays: 10, importance: 0.5,
    topic: '520，{n}相关的送礼与心意', why: '网络情人节，礼品消费意图明确、决策周期短' },
  { key: 'halloween', name: '万圣节', rule: { kind: 'fixed', month: 10, day: 31 }, leadDays: 10, importance: 0.4,
    topic: '万圣节，{n}可以玩点不一样的', why: '年轻受众的年度玩梗窗口，妆造与创意形式容易出圈' },
  // 感恩节固定在 11 月第 4 个周四；黑五就是它次日，一个 leadDays 窗口能同时覆盖两者。
  // 刻意不给黑五单独建节点：「11 月第 4 个周五」在 11 月 1 日恰为周五的年份会算错一周。
  { key: 'thanksgiving', name: '感恩节 / 黑五购物季', rule: { kind: 'nth', month: 11, weekday: 4, nth: 4 }, leadDays: 14, importance: 0.5,
    topic: '黑五前后，{n}值得关注的几件事', why: '跨境与折扣季窗口，也是感恩向个人叙事的天然时点' },

  // ── 时间节点（复盘/计划的天然容器）──
  { key: 'yearend', name: '年终总结季', rule: { kind: 'fixed', month: 12, day: 25 }, leadDays: 18, importance: 0.75,
    topic: '今年在{n}上，我做对和做错的几件事', why: '年终复盘是全年互动率最高的内容形态之一，真实感强、争议小' },
  { key: 'newyearplan', name: '新年计划季', rule: { kind: 'fixed', month: 1, day: 1 }, leadDays: 10, importance: 0.7,
    topic: '新的一年，{n}我打算这么做', why: '「重新开始」的心理峰值，计划类与方法论内容承接力最强' },
  { key: 'midyear', name: '年中复盘', rule: { kind: 'fixed', month: 7, day: 1 }, leadDays: 7, importance: 0.4,
    topic: '半年过去了，{n}这半年的变化', why: '规模小于年终，但适合做「进度对账」型内容' },

  // ── 传统节日（查表）──
  { key: 'cny', name: '春节', rule: { kind: 'table' }, leadDays: 21, importance: 0.9,
    topic: '过年这几天，聊聊{n}绕不开的那些事', why: '全年最长的集中在线时段，家庭话题与年度总结都能挂靠' },
  { key: 'lantern', name: '元宵节', rule: { kind: 'table' }, leadDays: 7, importance: 0.4,
    topic: '元宵节，{n}这个角度的一点想法', why: '春节长尾的收口节点，轻量内容即可' },
  { key: 'qingming', name: '清明', rule: { kind: 'table' }, leadDays: 7, importance: 0.4,
    topic: '清明假期，{n}相关的安排', why: '短假期出行与怀旧话题，注意肃穆语境、避免娱乐化表达' },
  { key: 'dragonboat', name: '端午', rule: { kind: 'table' }, leadDays: 10, importance: 0.5,
    topic: '端午假期，{n}可以怎么安排', why: '年中第一个三天假，出行与休闲类内容有窗口' },
  { key: 'qixi', name: '七夕', rule: { kind: 'table' }, leadDays: 10, importance: 0.6,
    topic: '七夕，{n}相关的送礼与选择', why: '礼品与情感话题的集中消费窗口，转化意图明确' },
  { key: 'midautumn', name: '中秋', rule: { kind: 'table' }, leadDays: 14, importance: 0.6,
    topic: '中秋前后，{n}这件事想说说', why: '团圆与送礼双主题，礼品类与情感类内容都能挂靠' },
  { key: 'chongyang', name: '重阳', rule: { kind: 'table' }, leadDays: 7, importance: 0.35,
    topic: '重阳节，{n}与长辈有关的那部分', why: '银发话题的年度窗口，适合做代际视角内容' },
  { key: 'dongzhi', name: '冬至', rule: { kind: 'table' }, leadDays: 5, importance: 0.3,
    topic: '冬至了，{n}在这个季节的变化', why: '轻量民俗节点，适合做节气向的日常内容' },

  // ── 公历节日 ──
  { key: 'valentine', name: '情人节', rule: { kind: 'fixed', month: 2, day: 14 }, leadDays: 12, importance: 0.6,
    topic: '情人节，{n}相关的送礼思路', why: '礼品消费窗口，与七夕形成年度两次高峰' },
  { key: 'womensday', name: '三八节', rule: { kind: 'fixed', month: 3, day: 8 }, leadDays: 10, importance: 0.6,
    topic: '三八节，从{n}聊聊女性视角', why: '女性向消费与议题双热点，注意避免刻板表达' },
  { key: 'labour', name: '五一假期', rule: { kind: 'fixed', month: 5, day: 1 }, leadDays: 14, importance: 0.6,
    topic: '五一假期，{n}可以怎么安排', why: '上半年最长假期，出行与休闲内容的最大窗口' },
  { key: 'childrensday', name: '六一儿童节', rule: { kind: 'fixed', month: 6, day: 1 }, leadDays: 10, importance: 0.5,
    topic: '六一，从{n}的角度看童年这件事', why: '亲子与怀旧双入口，成人向账号也能借童年视角切入' },
  { key: 'teachersday', name: '教师节', rule: { kind: 'fixed', month: 9, day: 10 }, leadDays: 7, importance: 0.35,
    topic: '教师节，说说在{n}这条路上教过我的人', why: '感恩向叙事，适合做人物与个人故事型内容' },
  { key: 'nationalday', name: '国庆假期', rule: { kind: 'fixed', month: 10, day: 1 }, leadDays: 18, importance: 0.75,
    topic: '国庆长假，{n}这件事怎么安排', why: '全年最长假期之一，出行、囤内容、慢节奏话题都有空间' },
  { key: 'christmas', name: '圣诞', rule: { kind: 'fixed', month: 12, day: 25 }, leadDays: 10, importance: 0.45,
    topic: '圣诞季，{n}相关的礼物与仪式感', why: '年轻受众的送礼窗口，与年终总结季重叠可合并规划' },

  // ── 相对日期节日 ──
  { key: 'mothersday', name: '母亲节', rule: { kind: 'nth', month: 5, weekday: 0, nth: 2 }, leadDays: 10, importance: 0.6,
    topic: '母亲节，{n}这件事和妈妈有关的一面', why: '情感与送礼双窗口，真实家庭故事的传播效率极高' },
  { key: 'fathersday', name: '父亲节', rule: { kind: 'nth', month: 6, weekday: 0, nth: 3 }, leadDays: 10, importance: 0.45,
    topic: '父亲节，说说{n}这条路上父亲的影响', why: '规模小于母亲节，但个人叙事的差异化空间更大' },
];

// 日历只推算这么远：再往前推，用户既记不住也用不上，还会把本周窗口挤满。
const MAX_HORIZON_DAYS = 30;
// 节点体量评级映射到候选 heat 的上限。刻意低于 1：日历节点是**确定会来的流量**，
// 不是**此刻正在发生的流量**，不该在粗排里压过一条真热点。
const IMPORTANCE_CAP = 0.55;

function daysBetween(a: Date, b: Date): number {
  const d0 = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const d1 = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  return Math.round((d1 - d0) / 86_400_000);
}

// 某年该节点的日期；查表型节点在表外年份返回 null（跳过，不外推）
export function resolveNodeDate(node: CalendarNode, year: number): Date | null {
  const r = node.rule;
  if (r.kind === 'fixed') return new Date(Date.UTC(year, r.month - 1, r.day));
  if (r.kind === 'table') {
    const hit = LUNAR_TABLE[node.key]?.[year];
    return hit ? new Date(Date.UTC(year, hit[0] - 1, hit[1])) : null;
  }
  // nth：该月第 nth 个 weekday
  const first = new Date(Date.UTC(year, r.month - 1, 1));
  const shift = (r.weekday - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, r.month - 1, 1 + shift + (r.nth - 1) * 7));
}

export type UpcomingNode = { node: CalendarNode; date: Date; daysUntil: number };

// 即将到来且已进入准备窗口的节点。跨年时要看下一年（12 月看 1 月的年货节/元旦）。
export function upcomingNodes(now: Date = new Date(), horizonDays = MAX_HORIZON_DAYS): UpcomingNode[] {
  const year = now.getUTCFullYear();
  const out: UpcomingNode[] = [];
  for (const node of CALENDAR_NODES) {
    for (const y of [year, year + 1]) {
      const date = resolveNodeDate(node, y);
      if (!date) continue;
      const daysUntil = daysBetween(now, date);
      // 当天仍算数（daysUntil=0）：节点当天发内容依然成立；过了就不再提。
      if (daysUntil < 0 || daysUntil > Math.min(horizonDays, node.leadDays)) continue;
      out.push({ node, date, daysUntil });
      break; // 同一节点只取最近的那次
    }
  }
  // 越近越该先做
  out.sort((a, b) => a.daysUntil - b.daysUntil || b.node.importance - a.node.importance);
  return out;
}

function fmtDate(d: Date): string {
  return `${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日`;
}

// 紧迫度：刚进窗口时 0.6，临到跟前 1.0。让「还有 3 天」压过「还有 20 天」。
function urgency(u: UpcomingNode): number {
  const lead = Math.max(1, u.node.leadDays);
  return 0.6 + 0.4 * (1 - Math.min(1, u.daysUntil / lead));
}

// 转候选。赛道词缺失时用不含 {n} 的降级表述——绝不产出「刚开始做，最容易踩的坑」式的缺主语标题。
export function calendarCandidates(input: {
  persona: PersonaCard;
  now?: Date;
  limit?: number;
  exclude?: Set<string>;
}): Candidate[] {
  const now = input.now ?? new Date();
  const niche = nicheWord(input.persona);
  const exclude = input.exclude ?? new Set<string>();
  const out: Candidate[] = [];
  for (const u of upcomingNodes(now)) {
    const title = niche
      ? u.node.topic.replace(/\{n\}/g, niche)
      : // 无赛道词：退回「节点 + 通用问法」，句子仍然成立，只是不够贴身
        `${u.node.name}前后，可以做点什么内容`;
    if (exclude.has(title)) continue;
    const when = u.daysUntil === 0 ? '就是今天' : `还有 ${u.daysUntil} 天（${fmtDate(u.date)}）`;
    out.push({
      title,
      heat: Math.min(IMPORTANCE_CAP, u.node.importance * urgency(u) * IMPORTANCE_CAP),
      sourceType: 'calendar',
      sourceRef: u.node.key,
      // 日历节点的价值就是提前量，进「今日突击」等于自毁定位（见文件头）
      queue: 'week',
      evidence: `${u.node.name}${when}。${u.node.why}。`,
      windowHint: `建议提前 ${Math.max(2, Math.round(u.node.leadDays / 3))} 天开始准备，节点当天前后发布`,
    });
    if (out.length >= (input.limit ?? 3)) break;
  }
  return out;
}

// 便捷入口：给定 personaCard 原文（库里存的 JSON 字符串）
export function calendarCandidatesFromCard(personaCard: string, now?: Date, limit?: number): Candidate[] {
  return calendarCandidates({ persona: readPersona(personaCard), now, limit });
}
