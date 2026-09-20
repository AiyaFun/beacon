// 结构性 AI 指纹（2026-09-17）。
//
// ─────────────── 为什么必须单开这一把尺子 ───────────────
// 人味分（score.ts）量的是**分布**（句长方差、段落方差、对仗密度）加一张词表。
// 2026-09-17 拿用户真机那份「### 📌【目标客群：谁会来？】+ 每段 emoji + 我亲自去体验了一下
// + 欢迎在评论区分享你的看法哦😊」的初稿去跑，得分 **90 分、judgeDraft 判「不需要改」**——
// 也就是说，自动去 AI 味这一道对**最典型的 AI 稿从来没有触发过**。
//
// 原因不是阈值松，是量错了东西：栏目化排版本身会把方差**拉高**（小标题一行、条目一行、
// 说明一长段），于是「越像模板，分布越不均匀，分越高」。词表那一侧同时失灵——
// 词条写的是整句「你怎么看？欢迎在评论区留言」，模型实际写的是「欢迎在评论区分享你的看法哦」，
// 字符串对不上就一处都不报。
//
// 所以这里量的是**排版与套路**，是人一眼认出 AI 的那一层：
// 栏目名、每段一个 emoji、「加粗词：解释」式分点、讨好式收尾、凭空的亲身经历、空转副词。
// 这些都是计数型指标，**短文本上一样成立**，不受 score.ts「不足 120 字不出分」的限制。
//
// ─────────────── 一条纪律（沿用 lexicon.ts）───────────────
// 不许把平台真实用语当 AI 味。小红书真人用 emoji、用序号、用感叹号，本文件只在
// 「整篇按栏目铺开」「每段开头都摆一个」这种**密度**上判，不在单次使用上判。

export type StructureSeverity = 'good' | 'warn' | 'bad';

export type StructureFinding = {
  dimension: string;
  severity: StructureSeverity;
  finding: string;
  advice: string;
};

export type StructureStats = {
  /** 【栏目名】式行数 */
  sectionLabels: number;
  /** 段首 emoji 的段落占比 */
  emojiLeadRatio: number;
  /** 「条目：解释」式分点条数 */
  definitionBullets: number;
  /** 讨好式收尾命中数 */
  pleaserEndings: number;
  /** 凭空亲历标记数 */
  personalClaims: number;
  /** 每千字空转副词（加权） */
  fillerAdverbPer1k: number;
  /** 每千字破折号 */
  dashPer1k: number;
  /** 提纲式路标词命中数 */
  signposts: number;
  /** 段首重复用词的最大重复次数 */
  repeatedParaOpener: number;
};

export type StructureReport = {
  findings: StructureFinding[];
  /** 扣分（上限 50：再糟也要给别的维度留出可分辨的空间） */
  penalty: number;
  stats: StructureStats;
};

const PENALTY_CAP = 50;

// emoji：Extended_Pictographic 覆盖 💤🤔📌 这类表情，也覆盖 ™©® 之类的符号字符。
// 这里只在「段首」和「每段一个」的密度上用它，不做逐个字符的清点。
const EMOJI_RE = /\p{Extended_Pictographic}/u;

/** 段首 emoji：允许 emoji 前面有空白，但不许隔着文字 */
const EMOJI_LEAD_RE = /^\s*(?:\p{Extended_Pictographic}|\uD83C[\uDDE6-\uDDFF])/u;

/**
 * 【栏目名】：整行被【】包住，或行首就是【】/「### 📌【…】」这种小标题壳。
 * 长度放到 40 字：模型给小红书写的标题常常就是 20 字以上的一整行【…】，
 * 卡在 20 字最典型的那种就漏网了（**第一行**不按栏目算，见 structureReport）。
 */
const SECTION_LABEL_RE = /^\s*(?:#{1,6}\s*)?(?:\p{Extended_Pictographic}️?\s*)?【[^】\n]{1,40}】\s*[:：]?\s*$/u;

/**
 * 行首的【栏目名】**后面还跟着正文**：「【开头钩子】你以为这件事很简单？」。
 * 这种比独占一行的更常见，也更露馅——它等于把提纲的标签念了出来。
 * 它不可能是标题（标题不会跟一段正文挤在同一行），所以**不吃第一行豁免**。
 */
const LEADING_LABEL_RE = /^\s*(?:\p{Extended_Pictographic}️?\s*)?【[^】\n]{1,20}】\s*\S/u;

/** 分点行：「- xx」「1. xx」「① xx」 */
const BULLET_RE = /^\s*(?:[-*•·]|\d+[.、)]|[①②③④⑤⑥⑦⑧⑨⑩])\s*\S/;

/** 「**传统影院**：主要面向…」——分点 + 定义式冒号，是模型排比铺陈的标志 */
const DEFINITION_BULLET_RE = /^\s*(?:[-*•·]|\d+[.、)]|[①②③④⑤⑥⑦⑧⑨⑩])\s*(?:\*\*)?[^：:\n]{1,14}(?:\*\*)?\s*[：:]\s*\S/;

// 讨好式收尾：模型收尾的固定动作。只取「组合」形态，单说「评论区」不算——
// 「评论区见」「评论区告诉我」是真人天天在说的话。
const PLEASER_ENDING_RES: Array<{ re: RegExp; name: string }> = [
  { re: /欢迎[^。！？!?\n]{0,10}(评论区|留言|分享|讨论|交流)/, name: '欢迎在评论区…' },
  { re: /(你|你们|大家)(怎么看|有什么看法|的看法呢)/, name: '你怎么看' },
  { re: /(点赞|关注|收藏|转发)[^。！？!?\n]{0,6}(一下|支持|不迷路|走起)/, name: '点赞关注式收尾' },
  { re: /一键三连/, name: '一键三连' },
  { re: /(期待|欢迎)[^。！？!?\n]{0,8}(你的|大家的)(分享|故事|经历|想法)/, name: '期待你的分享' },
  { re: /那么问题来了/, name: '那么问题来了' },
];

// 凭空亲历：素材库里没有这段经历，模型却写成第一人称实测。
// 只报 warn——真去体验过的创作者也会这么写，判断权留给用户（与「链接漂移」同一处理口径）。
const PERSONAL_CLAIM_RES: Array<{ re: RegExp; name: string }> = [
  { re: /我(亲自|特意|专门|特地)(去)?(体验|试|测|跑|问)/g, name: '我亲自去…' },
  { re: /(亲测|实测下来|亲身体验下来|我体验了一下|我试了一下|我去试了)/g, name: '亲测/实测' },
  { re: /不得不说[^。！？!?\n]{0,12}(真的|确实)/g, name: '不得不说，真的…' },
];

// 空转副词：删掉之后句子的信息一点不少。加权是因为「真的/特别」真人也常用，
// 「简直/极其/相当/毫无疑问」几乎只在模型笔下扎堆。
const FILLER_ADVERBS: Array<{ word: string; weight: number }> = [
  { word: '简直', weight: 2 },
  { word: '极其', weight: 2 },
  { word: '相当', weight: 2 },
  { word: '十分', weight: 2 },
  { word: '毫无疑问', weight: 2 },
  { word: '无疑', weight: 2 },
  { word: '非常', weight: 1.5 },
  { word: '真的', weight: 1 },
  { word: '特别', weight: 1 },
  { word: '超级', weight: 1 },
  { word: '完全', weight: 1 },
];

// 路标词：「首先/其次/再者/最后」这一组连着出现，就是模型在念提纲。
// 单用一个不报——真人写「首先得把钱算清楚」是正常的；两个以上同时出现才是模板。
// 「说到这里」「再深入一点」「接下来」这类过场词同组计数。
const SIGNPOSTS = ['首先', '其次', '再者', '第三', '最后一点', '综上', '说到这里', '再深入一点', '接下来我们', '话说回来'];

function splitParagraphs(text: string): string[] {
  return text.split(/\n+/).map((p) => p.trim()).filter(Boolean);
}

function per1k(n: number, chars: number): number {
  return chars > 0 ? Math.round((n / chars) * 10000) / 10 : 0;
}

function countAll(text: string, re: RegExp): number {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  return (text.match(g) ?? []).length;
}

/**
 * 扫结构性 AI 指纹。零 LLM、确定性、对短文本一样有效。
 *
 * platform 只用来放宽 emoji 判定（小红书这类图文平台真人也用 emoji，
 * 但「每段开头都摆一个」在哪个平台都是模板感），不改变其余判据。
 */
export function structureReport(text: string, platform?: string): StructureReport {
  const body = (text ?? '').trim();
  const chars = body.length;
  const paragraphs = splitParagraphs(body);
  const lines = body.split('\n');
  const findings: StructureFinding[] = [];
  let penalty = 0;

  // ── 栏目化排版 ──
  // 第一行非空行不算栏目：在「第一行是标题」的平台上（小红书/公众号/知乎…），
  // 「【1.2 元睡 2.5 小时】」是标题本身，不是模板栏目。把它算进去会逼着修复那一次
  // 把标题也拆了——那是在改对的东西。
  const firstContentIdx = lines.findIndex((l) => l.trim().length > 0);
  const sectionLabels =
    lines.filter((l, i) => i !== firstContentIdx && SECTION_LABEL_RE.test(l)).length +
    lines.filter((l) => LEADING_LABEL_RE.test(l)).length;
  if (sectionLabels >= 2) {
    penalty += 22;
    findings.push({
      dimension: '栏目化排版',
      severity: 'bad',
      finding: `${sectionLabels} 行是「【栏目名】」式小标题，整篇被切成了表格`,
      advice: '把栏目名删掉，让内容自己连成一段话——读者要的是有人在讲一件事，不是一张对照表。',
    });
  } else if (sectionLabels === 1) {
    penalty += 6;
    findings.push({
      dimension: '栏目化排版',
      severity: 'warn',
      finding: '有一行是「【栏目名】」式小标题',
      advice: '删掉这个壳，把那句话直接说出来。',
    });
  }

  // ── 每段一个 emoji ──
  const emojiLead = paragraphs.filter((p) => EMOJI_LEAD_RE.test(p)).length;
  const emojiLeadRatio = paragraphs.length ? Math.round((emojiLead / paragraphs.length) * 100) / 100 : 0;
  if (paragraphs.length >= 3 && emojiLeadRatio >= 0.5) {
    penalty += 16;
    findings.push({
      dimension: '装饰性 emoji',
      severity: 'bad',
      finding: `${emojiLead}/${paragraphs.length} 段以 emoji 开头，像给每段贴了标签`,
      advice: '整篇最多留一两个 emoji，而且要用在断句或表情绪的地方，不要当段落图标。',
    });
  } else if (paragraphs.length >= 3 && emojiLeadRatio >= 0.3) {
    penalty += 7;
    findings.push({
      dimension: '装饰性 emoji',
      severity: 'warn',
      finding: `${emojiLead}/${paragraphs.length} 段以 emoji 开头`,
      advice: '去掉一半，emoji 只留在真有情绪的那一两处。',
    });
  }

  // ── 分点模板（「加粗词：解释」排比铺陈）──
  const bulletLines = lines.filter((l) => BULLET_RE.test(l));
  const definitionBullets = lines.filter((l) => DEFINITION_BULLET_RE.test(l)).length;
  if (definitionBullets >= 3) {
    penalty += 16;
    findings.push({
      dimension: '分点模板',
      severity: 'bad',
      finding: `${definitionBullets} 条「关键词：解释」式分点，是模型最典型的铺陈方式`,
      advice: '留一条最有信息量的，其余改成连着说的话；真要分点就只写要点，别每条都配一句定义。',
    });
  } else if (bulletLines.length >= 5) {
    const lens = bulletLines.map((l) => l.trim().length);
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
    const sd = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length);
    if (mean > 0 && sd / mean < 0.25) {
      penalty += 8;
      findings.push({
        dimension: '分点模板',
        severity: 'warn',
        finding: `${bulletLines.length} 条分点长度几乎一样（像填表填出来的）`,
        advice: '合并掉一半，或者让其中一两条只有半句话。',
      });
    }
  }

  // ── 讨好式收尾 ──（只看最后 120 字：开头出现「欢迎讨论」是另一回事）
  const tail = body.slice(-120);
  const pleaserNames = PLEASER_ENDING_RES.filter((p) => p.re.test(tail)).map((p) => p.name);
  if (pleaserNames.length >= 2) {
    penalty += 16;
    findings.push({
      dimension: '讨好式收尾',
      severity: 'bad',
      finding: `结尾连着用了 ${pleaserNames.length} 个模板式收束（${pleaserNames.join('、')}）`,
      // 不给示例句：这段 advice 会原样进修复提示词，写了句子模型就会抄（见 platform-format 顶部那条纪律）
      advice: '全删。换成一句立得住的判断，或一个问读者自身处境的问题——问的是他的情况，不是问他对这件事怎么看。',
    });
  } else if (pleaserNames.length === 1) {
    penalty += 9;
    findings.push({
      dimension: '讨好式收尾',
      severity: 'warn',
      finding: `结尾是模板式收束（${pleaserNames[0]}）`,
      advice: '换成一句只有你会说的话，或一个具体到能直接回答的问题。',
    });
  }

  // ── 凭空亲历 ──
  const personalClaims = PERSONAL_CLAIM_RES.reduce((n, p) => n + countAll(body, p.re), 0);
  if (personalClaims > 0) {
    penalty += 8;
    findings.push({
      dimension: '凭空亲历',
      severity: 'warn',
      finding: `有 ${personalClaims} 处第一人称实测口吻（「我亲自去体验了一下」这类）`,
      advice: '真去过就留着，并补上只有去过的人才说得出的细节；没去过就删掉——编出来的经历是这类稿子最容易翻车的地方。',
    });
  }

  // ── 空转副词 ──
  let filler = 0;
  for (const { word, weight } of FILLER_ADVERBS) {
    let from = 0;
    for (;;) {
      const i = body.indexOf(word, from);
      if (i < 0) break;
      filler += weight;
      from = i + word.length;
    }
  }
  const fillerAdverbPer1k = per1k(filler, chars);
  if (fillerAdverbPer1k >= 18) {
    penalty += 12;
    findings.push({
      dimension: '空转副词',
      severity: 'bad',
      finding: `每千字 ${fillerAdverbPer1k} 处「简直/真的/非常/超级」这类程度副词`,
      advice: '删掉八成。程度不是靠副词堆出来的，是靠一个具体的数字或场景。',
    });
  } else if (fillerAdverbPer1k >= 10) {
    penalty += 6;
    findings.push({
      dimension: '空转副词',
      severity: 'warn',
      finding: `每千字 ${fillerAdverbPer1k} 处程度副词`,
      advice: '挑一半删掉，换成具体的东西。',
    });
  }

  // ── 路标词 ──
  const signposts = SIGNPOSTS.filter((w) => body.includes(w));
  if (signposts.length >= 3) {
    penalty += 12;
    findings.push({
      dimension: '路标词',
      severity: 'bad',
      finding: `用了 ${signposts.length} 个提纲式路标词（${signposts.join('、')}）`,
      advice: '全删。段落顺序本身就是路标，说「首先」「其次」只是在念提纲；真要强调顺序就说「第一年…后来…」这种具体的时间。',
    });
  } else if (signposts.length === 2) {
    penalty += 7;
    findings.push({
      dimension: '路标词',
      severity: 'warn',
      finding: `用了两个提纲式路标词（${signposts.join('、')}）`,
      advice: '删掉一个，让句子自己接上。',
    });
  }

  // ── 破折号密度 ──（中文里的「——」是模型的口癖，真人一篇用一次就顶天了）
  // 次数与密度都要够：短稿子里出现一次「——」算 6.9/千字，但那只是一次正常用法。
  // 真机那份 139 字的种子稿就是这么被误报的。
  const dashCount = countAll(body, /——/g);
  const dashPer1k = per1k(dashCount, chars);
  if (dashCount >= 2 && dashPer1k >= 5) {
    penalty += 6;
    findings.push({
      dimension: '破折号口癖',
      severity: 'warn',
      finding: `每千字 ${dashPer1k} 个「——」`,
      advice: '留一个，其余改成句号或逗号——连着用会让整篇像同一个人在喘气。',
    });
  }

  // ── 段首重复 ──
  const openers = new Map<string, number>();
  for (const p of paragraphs) {
    const head = p.replace(/^\s*(?:\p{Extended_Pictographic}️?|[-*•·\d.、)①②③④⑤⑥⑦⑧⑨⑩\s])+/u, '').slice(0, 2);
    if (head.length === 2) openers.set(head, (openers.get(head) ?? 0) + 1);
  }
  const repeatedParaOpener = Math.max(0, ...openers.values());
  if (paragraphs.length >= 4 && repeatedParaOpener >= 3) {
    penalty += 6;
    const word = [...openers.entries()].find(([, n]) => n === repeatedParaOpener)?.[0] ?? '';
    findings.push({
      dimension: '段首重复',
      severity: 'warn',
      finding: `有 ${repeatedParaOpener} 段都以「${word}」开头`,
      advice: '换掉其中两段的起手，或把它们并进上一段。',
    });
  }

  const stats: StructureStats = {
    sectionLabels,
    emojiLeadRatio,
    definitionBullets,
    pleaserEndings: pleaserNames.length,
    personalClaims,
    fillerAdverbPer1k,
    dashPer1k,
    signposts: signposts.length,
    repeatedParaOpener: Number.isFinite(repeatedParaOpener) ? repeatedParaOpener : 0,
  };

  // platform 目前只影响一处：口播平台（抖音/视频号/快手/TikTok）念不出 emoji，
  // 段首 emoji 在那里连「装饰」都算不上，直接按 bad 计。
  if (platform && ['douyin', 'shipinhao', 'kuaishou', 'tiktok'].includes(platform) && emojiLead > 0) {
    const already = findings.find((f) => f.dimension === '装饰性 emoji');
    if (!already) {
      penalty += 8;
      findings.push({
        dimension: '装饰性 emoji',
        severity: 'warn',
        finding: `口播稿里有 ${emojiLead} 段以 emoji 开头，而 emoji 是念不出来的`,
        advice: '口播稿一个 emoji 都不要留。',
      });
    }
  }

  if (findings.length === 0 && chars > 0) {
    findings.push({
      dimension: '排版套路',
      severity: 'good',
      finding: '没有栏目名、分点模板、装饰 emoji 或讨好式收尾',
      advice: '保持——这一层是读者在读第一眼时就会下判断的地方。',
    });
  }

  return { findings, penalty: Math.min(PENALTY_CAP, penalty), stats };
}

/** emoji 存在性（格式检查也要用，避免两处各写一个正则） */
export function hasEmoji(text: string): boolean {
  return EMOJI_RE.test(text ?? '');
}
