// F11 平台算法教练 · 规则化个性化诊断
// 依据 research-10 各平台第一权重信号 + 账号真实 ownPost.metrics 做「你的数据 vs 建议」对比。
// 纯确定性规则（零 LLM 成本）；页面另可叠加 LLM 渲染的个性化文案。

import { clickThroughRate, hasViews, sourceShare, type Metrics } from '@/lib/json';

export type Diagnosis = {
  signal: string; // 对应的算法信号中文名
  severity: 'good' | 'warn' | 'bad';
  finding: string; // 你的数据现状（含真实数值）
  advice: string; // 差异化建议
};

// 账号在该平台的聚合基线（供页面展示 + 诊断共用）
//
// ⚠️ 所有「以播放量为分母」的字段都是 `number | null`：**抖音这类平台的公开页面
//    根本没有播放量**，算不出来时必须是 null。给 0 的后果不是少一个数，
//    是页面上冒出「点赞率 0.0%」、诊断里冒出「收藏率偏低」这种凭空捏造的结论。
export type MetricBaseline = {
  sample: number;
  avgViews: number | null; // 均播；一条有播放量的样本都没有时为 null
  avgCompletion: number | null; // 完播/完读率 0-1，无则 null
  likeRate: number | null; // 点赞/播放
  commentRate: number | null; // 评论/播放
  shareRate: number | null; // 转发/播放
  collectRate: number | null; // 收藏/播放
  // ── 以下两项只有创作者后台数据才算得出来（公开作品页没有曝光量与来源分布）；无数据为 null ──
  avgCtr: number | null; // 曝光点击率 = 播放/曝光
  avgSearchShare: number | null; // 搜索流量占比 0-1
};

export function buildBaseline(list: Metrics[]): MetricBaseline {
  const n = list.length;
  const empty: MetricBaseline = {
    sample: n, avgViews: null, avgCompletion: null,
    likeRate: null, commentRate: null, shareRate: null, collectRate: null,
    avgCtr: null, avgSearchShare: null,
  };
  if (n === 0) return empty;

  let views = 0, viewCount = 0;
  let like = 0, comment = 0, share = 0, collect = 0;
  let compSum = 0, compCount = 0;
  let ctrSum = 0, ctrCount = 0;
  let searchSum = 0, searchCount = 0;
  for (const m of list) {
    // 只对**真的有播放量**的样本累计率。原来是不管有没有都除一遍（拿不到就当 0），
    // 于是混了几条抖音作品进来就能把点赞率整体腰斩，看起来像「这个号互动变差了」。
    // 这条纪律下面的 CTR/搜索占比早就在守，率这一组此前是漏网的。
    if (hasViews(m)) {
      const v = m.views as number;
      views += v;
      viewCount += 1;
      like += (m.likes ?? 0) / v;
      comment += (m.comments ?? 0) / v;
      share += (m.shares ?? 0) / v;
      collect += (m.collects ?? 0) / v;
    }
    if (typeof m.completion === 'number') {
      compSum += m.completion;
      compCount += 1;
    }
    // 只对**真的有这项数据**的样本求均值：拿不到的样本按 0 计会把均值系统性拉低，
    // 于是「大部分作品没接后台」看起来就像「CTR 很差」——那是编出来的结论
    const ctr = clickThroughRate(m);
    if (ctr !== null) { ctrSum += ctr; ctrCount += 1; }
    const search = sourceShare(m, '搜索', 'search');
    if (search !== null) { searchSum += search; searchCount += 1; }
  }
  return {
    sample: n, // 样本数照实说：用户问的是「看了几条」，不是「几条算得出率」
    avgViews: viewCount > 0 ? Math.round(views / viewCount) : null,
    avgCompletion: compCount > 0 ? compSum / compCount : null,
    likeRate: viewCount > 0 ? like / viewCount : null,
    commentRate: viewCount > 0 ? comment / viewCount : null,
    shareRate: viewCount > 0 ? share / viewCount : null,
    collectRate: viewCount > 0 ? collect / viewCount : null,
    avgCtr: ctrCount > 0 ? ctrSum / ctrCount : null,
    avgSearchShare: searchCount > 0 ? searchSum / searchCount : null,
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

// 「以播放量为分母」的那一组率。抖音这类平台的公开页面没有播放量，四个率全是 null。
//
// 这时**一条以率为依据的诊断都不许出**：算不出来不等于「表现差」。
// 此前小红书分支就踩了这个——collectRate=0、likeRate=0 让 `0 < 0` 为假，
// 直接走 else 报了一句「收藏率 0.0%，工具价值被认可」，对着零数据发了张好人卡。
type ViewRates = { likeRate: number; commentRate: number; shareRate: number; collectRate: number };
function viewRates(b: MetricBaseline): ViewRates | null {
  const { likeRate, commentRate, shareRate, collectRate } = b;
  if (likeRate === null || commentRate === null || shareRate === null || collectRate === null) return null;
  return { likeRate, commentRate, shareRate, collectRate };
}

// 没有播放量时给一条**说人话的替代诊断**：说明哪些看不出来、哪些照样准。
// 直接沉默会让用户以为「诊断坏了」，而报个 0.0% 又是撒谎。
const NO_VIEWS_DIAGNOSIS: Diagnosis = {
  signal: '播放量不可得',
  severity: 'warn',
  finding: '这个平台的公开页面不提供播放量（抖音等只在创作者后台可见），所以互动率、点赞率、收藏率这类「除以播放」的指标都算不出来。',
  advice: '点赞 / 评论 / 收藏 / 转发的绝对数是真实采到的，可以直接横向比作品。想要率类指标，在插件设置里接上创作者后台回填，播放量与曝光量就会补齐。',
};

// 平台第一权重信号 → 目标阈值（方向性，非官方承诺；来自 research-10 的定性结论）
// 说明：阈值是行业共识层面的「健康线」，仅用于给出方向，不代表平台真实晋级参数。
export function diagnose(platform: string, list: Metrics[]): Diagnosis[] {
  const b = buildBaseline(list);
  const out: Diagnosis[] = [];
  // r === null 表示这批样本一条播放量都没有（抖音等平台的公开页面就是这样）。
  // 下面每条以率为依据的诊断都必须 `r &&` 守住：算不出来时**一句都不说**，
  // 而不是拿 0 当观测值去比阈值——那会稳定地产出「xx 率 0.0%」这类假结论。
  const r = viewRates(b);

  if (b.sample === 0) {
    return [{
      signal: '样本不足',
      severity: 'warn',
      finding: '该平台还没有回流的历史作品数据。',
      advice: '先在「数据看板」登记几条已发布内容的表现，满 3-5 条后即可给出基于你自己基线的个性化诊断；当前请先照下方发布前 Checklist 执行。',
    }];
  }

  switch (platform) {
    case 'douyin': {
      // 第一信号：完播率（多目标行为概率之首）
      if (b.avgCompletion !== null) {
        if (b.avgCompletion < 0.4) {
          out.push({
            signal: '完播率',
            severity: 'bad',
            finding: `你近 ${b.sample} 条平均完播率 ${pct(b.avgCompletion)}，低于短视频健康线（约 40%）。`,
            advice: '内容能被推出去但留不住人，问题大概率在开头 3 秒与节奏：把结果/冲突前置到第 1 句，铺垫压到 5 秒内，时长控制在 30–60s。',
          });
        } else {
          out.push({
            signal: '完播率',
            severity: 'good',
            finding: `平均完播率 ${pct(b.avgCompletion)}，达到短视频健康区间。`,
            advice: '完播基本盘稳，接下来把杠杆放到评论互动上撬冷启动池。',
          });
        }
      }
      // 第二信号：评论互动（2025 官方口径更看重主动互动）
      if (r && r.commentRate < r.likeRate * 0.05) {
        out.push({
          signal: '评论互动率',
          severity: 'warn',
          finding: `评论/播放 ${pct(r.commentRate)}，明显低于点赞率（${pct(r.likeRate)}）。`,
          advice: '内容被认可但缺对话性。结尾加争议性提问或「你会选哪个」二选一，发布后 30–60 分钟内作者下场回评，拉评论深度。',
        });
      }
      break;
    }
    case 'xiaohongshu': {
      // 第一信号：CES 互动分，收藏是干货类核心加权项
      if (r && r.collectRate < r.likeRate * 0.3) {
        out.push({
          signal: '收藏率 (CES)',
          severity: 'bad',
          finding: `收藏/播放 ${pct(r.collectRate)}，相对点赞率（${pct(r.likeRate)}）偏低。`,
          advice: '内容有情绪价值但缺「留着有用」的工具价值，CES 结构偏弱还损失搜索长尾。正文改清单/步骤/表格结构，结尾加「收藏备用」提示，补 2-3 个长尾关键词。',
        });
      } else if (r) {
        out.push({
          signal: '收藏率 (CES)',
          severity: 'good',
          finding: `收藏率 ${pct(r.collectRate)}，工具价值被认可。`,
          advice: '收藏结构健康，继续用清单体承接搜索长尾，爆文后 48h 内跟同选题系列。',
        });
      }
      // 搜索流量占比：接了创作者后台就用真实数据下结论；没接才退回「这一项看不出来，去主动布局」的提醒。
      // 退化形态而不是伪装：没数据时明说没数据，不拿一个估算值冒充。
      if (b.avgSearchShare !== null) {
        const low = b.avgSearchShare < 0.3;
        out.push({
          signal: '搜索流量占比',
          severity: low ? 'bad' : 'good',
          finding: `你近 ${b.sample} 条的搜索流量占比 ${pct(b.avgSearchShare)}${low ? '，明显偏低' : '，搜索长尾已经吃到'}（小红书近 70% 月活有搜索行为，笔记流量约半壁来自搜索）。`,
          advice: low
            ? '推荐流是一次性的，搜索流量才是长期复利。标题必含 1–2 个搜索词（用下拉联想词验证），首段点题、正文自然重复关键词 2–3 次。'
            : '搜索结构健康，继续按搜索词布局选题，把跑出来的关键词做成系列吃透长尾。',
        });
      } else {
        out.push({
          signal: '搜索关键词',
          severity: 'warn',
          finding: '小红书近 70% 月活有搜索行为，笔记流量约半壁来自搜索。你的搜索流量占比暂无数据（需接入创作者后台回填）。',
          advice: '标题必含 1–2 个搜索词（用下拉联想词验证），首段点题、正文自然重复关键词 2–3 次。想看自己的真实搜索占比，去数据看板用插件从小红书创作者后台回填一次。',
        });
      }
      break;
    }
    case 'wechat': {
      // 第一信号：社交推荐（在看/朋友♡）+ 阅读完成率
      if (b.avgCompletion !== null && b.avgCompletion < 0.5) {
        out.push({
          signal: '阅读完成率',
          severity: 'bad',
          finding: `平均阅读完成率 ${pct(b.avgCompletion)}，低于推荐流健康线（约 50%）。`,
          advice: '完读率是推荐流核心信号。首屏 3 行内给出「读完能得到什么」，小标题+短段落+图表降低跳出。',
        });
      }
      if (r && r.shareRate < 0.01) {
        out.push({
          signal: '在看/社交推荐',
          severity: 'warn',
          finding: `转发/在看比例约 ${pct(r.shareRate)}，社交推荐入口偏弱。`,
          advice: '「在看」直接进入朋友♡社交推荐池——2025 年这是最大增量入口。增加观点性段落、给一句可转发的金句、文末直接请求「点在看/星标」。',
        });
      }
      break;
    }
    case 'bilibili': {
      // 第一信号：播放完成度，其次三连（投币最强）
      if (b.avgCompletion !== null && b.avgCompletion < 0.5) {
        out.push({
          signal: '播放完成度',
          severity: 'bad',
          finding: `平均完成度 ${pct(b.avgCompletion)}，中长视频留人不足。`,
          advice: '前 30 秒给「本片承诺」+目录锚点，避免长片头；用后台留存曲线找流失拐点，中段删注水，必要时把 15 分钟剪到 8–10 分钟。',
        });
      }
      // 三连率同样是「除以播放」，没播放量就算不出来——不能让 0+0 < 0.05 成立后
      // 报一句「三连信号偏弱」，那是拿没有的数据给用户定罪。
      const sanlian = r ? r.likeRate + r.collectRate : null;
      if (sanlian !== null && sanlian < 0.05) {
        out.push({
          signal: '三连率',
          severity: 'warn',
          finding: `点赞+收藏合计约 ${pct(sanlian)}，三连信号偏弱（投币是最强价值投票）。`,
          advice: '在信息密度最高点后口播「一键三连」（B站文化认可的合法引导），干货类补「收藏警告」，结尾预告下期催关注。',
        });
      }
      break;
    }
    case 'shipinhao': {
      // 第一信号：完播率 + 转发裂变。视频号的推荐盘子里「社交关系链」权重远高于其它短视频平台
      // ——一条内容能不能被推开，主要看有没有人愿意转发给朋友/转到朋友圈，其次才是完播。
      if (b.avgCompletion !== null) {
        if (b.avgCompletion < 0.4) {
          out.push({
            signal: '完播率',
            severity: 'bad',
            finding: `你近 ${b.sample} 条平均完播率 ${pct(b.avgCompletion)}，低于短视频健康线（约 40%）。`,
            advice: '完播不足会卡住第一层推荐。把结论前置到第 1 句，砍掉自我介绍式开场，时长压到 1–3 分钟。',
          });
        } else {
          out.push({
            signal: '完播率',
            severity: 'good',
            finding: `平均完播率 ${pct(b.avgCompletion)}，达到短视频健康区间。`,
            advice: '完播基本盘稳，接下来把杠杆压在转发上——视频号的量级由社交裂变决定，不是完播。',
          });
        }
      }
      // 第二信号：转发裂变（转发率是视频号区别于抖音的核心分野）
      if (r && r.shareRate < r.likeRate * 0.5) {
        out.push({
          signal: '转发裂变率',
          severity: 'bad',
          finding: `转发/播放 ${pct(r.shareRate)}，相对点赞率（${pct(r.likeRate)}）偏低。`,
          advice: '视频号靠熟人关系链推开：点赞只是自己认可，转发才把内容送进别人的推荐池。内容要给出「转给谁有用」的明确对象（转给爸妈/转给同事），观点写成可被复述的一句话，避免只有圈内人懂的梗。',
        });
      } else if (r) {
        out.push({
          signal: '转发裂变率',
          severity: 'good',
          finding: `转发率 ${pct(r.shareRate)}，社交裂变结构健康。`,
          advice: '裂变盘子已经跑通，保持「值得转给朋友」的选题密度，别为了流量转做纯情绪内容稀释它。',
        });
      }
      break;
    }
    case 'x': {
      // 第一信号：回复对话深度（开源权重：作者回复≈150×赞）
      if (r && r.commentRate < r.likeRate * 0.5) {
        out.push({
          signal: '回复率',
          severity: 'bad',
          finding: `回复/曝光 ${pct(r.commentRate)}，相对点赞率（${pct(r.likeRate)}）偏低。`,
          advice: '开源算法里 reply≈27×like、作者回复≈150×like。内容是「陈述句」而非「对话开启器」就吃亏：结尾改开放式提问，发帖后 30 分钟内回复每一条评论。',
        });
      } else if (r) {
        out.push({
          signal: '回复率',
          severity: 'good',
          finding: `回复率 ${pct(r.commentRate)}，对话性良好。`,
          advice: '对话链是 X 最大杠杆，保持发帖后黄金 30 分钟下场回评养对话。',
        });
      }
      out.push({
        signal: '外链降权',
        severity: 'warn',
        finding: '非 Premium 账号带外链帖普遍被降权（开源+大量实测）。',
        advice: '正文不放外链，链接移到首条回复；深度内容用 Thread 拉停留时长与 profile click。',
      });
      break;
    }
    case 'tiktok': {
      // 第一信号：完播率（TikTok 官方长期把 watch time / 看完比例列为最强推荐信号）；
      // 第二信号：分享率——把内容推出兴趣圈层靠的是被转发出去，而不是点赞。
      // 与抖音刻意分开写：同一批数字在两个平台的健康线与建议方向不同（抖音更吃评论互动，
      // TikTok 更吃分享与二创），共用一份诊断等于给出一半错的建议。
      if (b.avgCompletion !== null) {
        const low = b.avgCompletion < 0.4;
        out.push({
          signal: '完播率',
          severity: low ? 'bad' : 'good',
          finding: `你近 ${b.sample} 条平均完播率 ${pct(b.avgCompletion)}${low ? '，低于短视频健康线（约 40%）' : '，达到短视频健康区间'}。`,
          advice: low
            ? '完播不足会卡在第一层流量池。第 1 秒就要有视觉钩子（不是口播自我介绍），全片砍到 21–34 秒这一档，结尾做无缝循环让人多看一遍。'
            : '完播基本盘稳，接下来把杠杆压到分享上——TikTok 的量级由「被转出去多少次」决定。',
        });
      } else {
        out.push({
          signal: '完播率',
          severity: 'warn',
          finding: '完播率是 TikTok 的第一信号，但公开作品页不提供，你的数据里暂无这一项。',
          advice: '第 1 秒给视觉钩子、全片压到 21–34 秒、结尾做无缝循环。想看真实完播率，去 TikTok Studio 的 Analytics 里核对（烽火台目前从公开页只采得到播放/点赞/评论/分享/收藏）。',
        });
      }
      if (r && r.shareRate < r.likeRate * 0.1) {
        out.push({
          signal: '分享率',
          severity: 'bad',
          finding: `分享/播放 ${pct(r.shareRate)}，相对点赞率（${pct(r.likeRate)}）偏低。`,
          advice: '点赞只说明「我看了还行」，分享才把内容送进新的兴趣圈层。给一个明确的「转给谁」的对象，或做成可被二创的模板/挑战——TikTok 的破圈几乎都走这两条。',
        });
      } else if (r) {
        out.push({
          signal: '分享率',
          severity: 'good',
          finding: `分享率 ${pct(r.shareRate)}，破圈结构健康。`,
          advice: '保持可被二创/可被转述的形态，别为了追热点稀释掉这条。',
        });
      }
      break;
    }
    case 'youtube': {
      // 第一信号：CTR × 观看时长 × 满意度
      if (b.avgCompletion !== null && b.avgCompletion < 0.5) {
        out.push({
          signal: '平均观看时长占比',
          severity: 'bad',
          finding: `平均观看占比 ${pct(b.avgCompletion)}，低于健康线。`,
          advice: '若标题缩略图承诺过度会伤满意度信号（比低 CTR 更危险）。看留存曲线：30 秒内悬崖就重做开场承诺兑现，中段流失就删注水段落。',
        });
      }
      // CTR = 播放/曝光。拿到曝光量就能算，不必再说「无法反推」。
      if (b.avgCtr !== null) {
        const low = b.avgCtr < 0.04; // 行业常被引用的健康区间下沿，方向性参考
        out.push({
          signal: 'CTR（缩略图标题包）',
          severity: low ? 'bad' : 'good',
          finding: `你近 ${b.sample} 条的曝光点击率 ${pct(b.avgCtr)}${low ? '，低于常见健康区间（约 4-10%）' : '，处于健康区间'}。`,
          advice: low
            ? '曝光给到了但没人点，问题在「点击包」而不是内容：缩略图 ≤3 个视觉元素、高对比情绪脸，标题与缩略图不要重复同一句话。用官方 Test & Compare 做 A/B。'
            : '点击包有效，注意别让标题承诺超出内容——CTR 高但满意度低比低 CTR 更伤推荐。',
        });
      } else {
        out.push({
          signal: 'CTR（缩略图标题包）',
          severity: 'warn',
          finding: 'CTR 需要曝光量才算得出来，你的数据里暂无曝光量（公开视频页不提供，需从 Studio 回填）。',
          advice: '把标题+缩略图当一个「点击包」设计：缩略图 ≤3 个视觉元素、高对比情绪脸；用官方 Test & Compare 做缩略图 A/B。',
        });
      }
      break;
    }
    default:
      break;
  }

  if (r === null) {
    // 率类信号一条都没出，是因为**根本没有播放量这个分母**，不是「没有短板」。
    // 排在最前面：用户得先知道「为什么这里比别的平台少几项」，否则会以为功能坏了。
    out.unshift(NO_VIEWS_DIAGNOSIS);
  } else if (out.length === 0) {
    out.push({
      signal: '综合',
      severity: 'good',
      finding: `近 ${b.sample} 条数据在该平台各关键信号上未见明显短板。`,
      advice: '保持垂直度与发布节奏，对照下方 Checklist 逐条自查即可。',
    });
  }
  return out;
}
