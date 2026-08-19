// 改写后的「事实漂移」检查：改完的稿子里冒出了原文没有的数字、引语或来源，多半是模型编的。
//
// 【这不是假想的风险，是真机上抓到的】「一键去 AI 味」会把用户自己写过的原句样本喂给模型
// 学语感。真跑一次就看到：模型把**样本里的**「只留五个客户」「涨了两成」「每周三个下午」
// 写进了一篇原本只讲客户结构的稿子。提示词里已经写了「不要抄样本内容」，但那是软约束——
// 模型在题材相近时照样会串。
//
// 所以再加一道**确定性的**兜底：把改写前后对一遍，多出来的如实报给用户。
// 一共三类差分，口径统一是**新增的**而不是**存在的**——用户原文里本来就有的引语和数据
// 一个都不能拦，全靠 before/after 差分：
//   1. 数字（NUM_RE）
//   2. 引号引语（QUOTE_RES）——给一段话套上引号，等于凭空指认了一个说话人
//   3. 来源断言（URL_RE / SOURCE_PATTERNS）——把话推给一个外部信源
//
// 【为什么 2、3 比 1 严重，处置要分级】
// 数字对不上还可能只是换了写法（两成→20%），用户扫一眼就能判，所以维持提醒不阻断。
// 而「据艾瑞咨询数据显示，该品类增长 47%」是一个**完整的虚构归因**：信源、口径、结论
// 全是编的，用户照着发出去，虚假宣传的责任落在他自己头上，不在模型。所以这两类用更强的
// 措辞，并在返回结构里单列（addedQuotes / addedSources / level / attributionWarning），
// 让调用方能区别对待。
// ⚠️ 这道闸只负责**报**，不负责拦。是否阻断导出是产品决策，不在这个纯函数里偷偷改行为——
// 现有调用点全按 warning 消费，改成阻断会直接影响线上用户。

// 阿拉伯数字（含小数/百分号）与中文数字串。中文数字必须整串抓，
// 否则「三个通宵」会被拆成「三」而与「三成」误判为同一个数。
const NUM_RE = /\d+(?:\.\d+)?%?|[一二三四五六七八九十百千万亿两俩半]+(?:成|倍|个|次|年|月|天|周|小时|分钟|万|千|百)?/g;

// 太常见、单独出现时没有事实含量的词，不参与比对（「一下」「一直」「一些」里的「一」之类）
const NOISE = new Set(['一', '二', '三', '半', '两', '俩', '十', '百', '千', '万']);

export function extractNumbers(text: string): string[] {
  const out = new Set<string>();
  for (const m of (text ?? '').match(NUM_RE) ?? []) {
    const t = m.trim();
    if (!t || NOISE.has(t)) continue;
    out.add(t);
  }
  return [...out];
}

// ─────────────────────────── 引语 ───────────────────────────

/**
 * 引语短于这个长度不报（按剥掉引号和空白之后的字数算）。
 * 中文里「」还兼职强调号——「护城河」「私域」这种术语强调满篇都是，真按引语报，
 * 用户看三次就学会无视这条告警了，那这道闸等于没有。宁可漏掉短句，也要保住告警的可信度。
 */
export const MIN_QUOTE_CHARS = 6;

// 中英全形式。同形引号（"、'）靠成对匹配；单引号（'、’）同时兼任英文撇号，
// 所以额外要求两端不贴着**拉丁字母或数字**，否则 don't … it's 之间会被当成一处引语。
// 边界只卡拉丁字符不卡汉字：中文不写撇号，而「他说'算了'」这种紧挨着汉字的写法很常见，
// 卡汉字等于把中文里的单引号全漏掉。
const QUOTE_RES: readonly RegExp[] = [
  /「([^「」]{1,200})」/g,
  /『([^『』]{1,200})』/g,
  /“([^“”]{1,200})”/g,
  /‘([^‘’]{1,200})’(?![A-Za-z0-9])/g,
  /"([^"\n]{1,200})"/g,
  /(?<![A-Za-z0-9])'([^'\n]{1,200})'(?![A-Za-z0-9])/g,
];

const QUOTE_CHARS = /[「」『』“”‘’"']/g;

/**
 * 比对前先剥引号、去空白。这一步是「加引号不算造引语」的关键：
 * 模型把「他说效果不错」改成「他说：『效果不错』」只是加了标点，直接比带引号的字符串会误伤。
 */
function bare(s: string): string {
  return (s ?? '').replace(QUOTE_CHARS, '').replace(/\s+/g, '');
}

export function extractQuotes(text: string): string[] {
  const out = new Set<string>();
  for (const re of QUOTE_RES) {
    for (const m of (text ?? '').matchAll(re)) {
      const inner = m[1].trim();
      if (bare(inner).length < MIN_QUOTE_CHARS) continue;
      out.add(inner);
    }
  }
  return [...out];
}

// ─────────────────────────── 来源断言 ───────────────────────────

const URL_RE = /(?:https?:\/\/|www\.)[^\s，。；！？、「」『』“”"'）)\]】]+/gi;

// 每条至少要有一个「把话推给外部」的动作词，光有机构名不算。
// 第 1 组的裸「据」必须防止从「数据/占据/依据/证据」里切出来（真会切出「据数据」这种鬼东西），
// 所以加了负向后顾；「根据」走前一支，不受影响。
const SOURCE_PATTERNS: readonly RegExp[] = [
  /(?:根据|(?<![占依证收票数单凭契])据)\s*([^，。；：！？、\s「」『』“”"']{0,16}?)\s*(?:报道|披露|透露|统计|调研|调查|报告|数据|研究|白皮书|榜单|监测)(?:\s*(?:显示|表明|指出|称))?/g,
  /([^，。；：！？、\s「」『』“”"']{0,16}?)(?:数据|研究|报告|调查|调研|统计|白皮书|榜单)\s*(?:显示|表明|指出|证实|发现)/g,
  /(官方|权威|行业|业内|第三方)\s*(?:数据|统计|口径|报告|说法|消息)/g,
  /according to\s+([A-Za-z0-9][\w &'’-]{0,29})/gi,
  /(?:study|survey|report|poll|research)\s+(?:by|from)\s+([A-Za-z0-9][\w &'’-]{0,29})/gi,
  /(?:research|data|studies|statistics)\s+(?:shows?|showed|suggests?|indicates?|finds|found)/gi,
];

/**
 * 泛指词不能当「信源本来就在原文里」的凭据：原文随便哪里出现过「行业」两个字，
 * 就把新编的「据行业报告显示」放过去，这道闸就被邻近逻辑掩盖了。
 */
const GENERIC_SOURCE_ENTITY = new Set([
  '官方', '权威', '行业', '业内', '第三方', '相关', '有关', '最新', '不完全',
  '我', '我们', '他', '她', '他们', '公司', '平台', '后台',
]);

// kind 决定调用方能不能放行：url 类没有「换了个写法」的解释空间——模型拼出来的链接
// 不是「换句话说的同一个来源」，它指向一个具体的、可点击的地址，编的就是编的。
// phrase 类（据…报道）则真可能只是把原文里已有的信源改了句式，所以留给人判断。
// ⚠️ 别用 entity==='' 反推 kind：SOURCE_PATTERNS 第 3、6 组本来就抠不出机构名。
type SourceClaim = { text: string; entity: string; kind: 'url' | 'phrase' };

function scanSourceClaims(text: string): SourceClaim[] {
  const src = text ?? '';
  const seen = new Map<string, SourceClaim>();
  for (const m of src.matchAll(URL_RE)) {
    // URL 没有「机构名」可抠，整条当原文比，改一个字符就是另一个来源
    if (!seen.has(m[0])) seen.set(m[0], { text: m[0], entity: '', kind: 'url' });
  }
  for (const re of SOURCE_PATTERNS) {
    for (const m of src.matchAll(re)) {
      const t = m[0].trim();
      if (!t || seen.has(t)) continue;
      seen.set(t, { text: t, entity: (m[1] ?? '').trim(), kind: 'phrase' });
    }
  }
  return dropContained([...seen.values()], (c) => c.text);
}

export function extractSourceClaims(text: string): string[] {
  return scanSourceClaims(text).map((c) => c.text);
}

/** 同一处会被多条规则命中（「据艾瑞咨询数据显示」既是第 1 组也是第 2 组），短的那条是长的一部分，丢掉 */
function dropContained<T>(items: T[], key: (t: T) => string): T[] {
  return items.filter((a) => !items.some((b) => b !== a && key(b).includes(key(a))));
}

// ─────────────────────────── 差分 ───────────────────────────

/** none=没漂移；number=只有数字对不上；attribution=凭空造了信源（引语/来源），更严重 */
export type FactDriftLevel = 'none' | 'number' | 'attribution';

export type FactDrift = {
  /** 改写后新出现、原文里找不到的数字 */
  added: string[];
  /** 给用户看的一句话；无漂移时为空串。两类都有时，严重的那句排在前面 */
  warning: string;
  /** 改写后新出现的引语内容（已剥掉引号，只留话本身） */
  addedQuotes: string[];
  /** 改写后新出现的来源断言原文片段（URL，或「据…报道」这类句式） */
  addedSources: string[];
  /**
   * addedSources 里 **URL 那一类**（addedSources 的子集）。单列出来是因为它的处置更重：
   * 「据某某报告显示」还可能是把原文已有的信源换了个句式，而一条原文里没有的链接
   * 指向一个具体地址，没有「换了个说法」的解释空间——模型拼出来的就是编的。
   * 调用方拿它做阻断判据（当前：非空时「采纳为人工终稿」要先勾确认），
   * 其余类别一律只提示。**本模块自己仍然不做任何阻断。**
   */
  addedUrls: string[];
  /** 分级结果，供调用方决定用什么力度提示；本模块自己不做任何阻断 */
  level: FactDriftLevel;
  /** 只讲引语/来源的那一句，给想把两类分开渲染的调用方用；无则空串 */
  attributionWarning: string;
};

function clip(s: string, max = 24): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function checkFactDrift(before: string, after: string): FactDrift {
  const src = before ?? '';
  const dst = after ?? '';
  const srcBare = bare(src);

  const beforeNums = new Set(extractNumbers(src));
  const added = extractNumbers(dst).filter((n) => {
    if (beforeNums.has(n)) return false;
    // 「20%」在原文里以「20」出现过就不算新——只是换了个写法。
    // ⚠️ 只对**阿拉伯数字**做这种归一：中文数字这么做会把「三成」当成原文里的「三个通宵」，
    // 于是真正编出来的比例被放过（这条曾经真的漏掉过，单测里留着那一例）。
    if (!/^\d/.test(n)) return true;
    const bareNum = n.replace(/[%成倍个次年月天周小时分钟]+$/u, '');
    return !(bareNum && (beforeNums.has(bareNum) || src.includes(bareNum)));
  });

  // 引语：比的是**剥掉引号之后的内容**在不在原文里，所以「他说效果不错」→「他说：『效果不错』」
  // 只是加标点，不算造引语。
  const addedQuotes = dropContained(
    extractQuotes(dst).filter((q) => !srcBare.includes(bare(q))),
    (q) => q,
  );

  const addedClaims = scanSourceClaims(dst).filter((c) => {
    if (srcBare.includes(bare(c.text))) return false;
    // 机构名原文里就有，说明模型只是把「艾瑞咨询的报告」改成「据艾瑞咨询报告显示」，
    // 换了句式不算新信源。泛指词不吃这一条（见 GENERIC_SOURCE_ENTITY）。
    //
    // URL 天然不吃这条豁免：scanSourceClaims 给 url 的 entity 是空串，下面 e.length>=2 直接不成立。
    // 这是**故意的**，别顺手给 URL 抠个域名当 entity——那会让「域名在原文出现过」把新拼的路径
    // 放过去，而模型最常见的编法恰恰是拿一个真域名拼一个假路径。
    // （曾经在这里写过一行 `if (c.kind === 'url') return true;` 显式挡住，mutation 一验是死代码：
    //  删掉行为不变。留注释不留代码。）
    const e = bare(c.entity);
    if (e.length >= 2 && !GENERIC_SOURCE_ENTITY.has(e) && srcBare.includes(e)) return false;
    return true;
  });
  const addedSources = addedClaims.map((c) => c.text);
  const addedUrls = addedClaims.filter((c) => c.kind === 'url').map((c) => c.text);

  const numberWarning = added.length
    ? `改写后出现了原文里没有的数字：${added.slice(0, 6).join('、')}。发之前请核对——模型有时会把参考样本里的数字带进来。`
    : '';

  const bits: string[] = [];
  if (addedQuotes.length) bits.push(`引语「${addedQuotes.slice(0, 3).map((q) => clip(q)).join('」「')}」`);
  if (addedSources.length) bits.push(`来源「${addedSources.slice(0, 3).map((s) => clip(s)).join('」「')}」`);
  // 文案里不带图标：图标属于渲染层（同一句话要走站内提示条、SSE、server action 三个出口）
  const attributionWarning = bits.length
    ? `改写后凭空出现了原文里没有的${bits.join('、')}。这是一整套虚构的归因（谁说的、哪来的数据），核不到出处就删掉——发出去之后责任在你，不在模型。`
    : '';

  const level: FactDriftLevel = attributionWarning ? 'attribution' : added.length ? 'number' : 'none';
  if (level === 'none') {
    return { added: [], warning: '', addedQuotes: [], addedSources: [], addedUrls: [], level, attributionWarning: '' };
  }
  return {
    added,
    warning: [attributionWarning, numberWarning].filter(Boolean).join(' '),
    addedQuotes,
    addedSources,
    addedUrls,
    level,
    attributionWarning,
  };
}
