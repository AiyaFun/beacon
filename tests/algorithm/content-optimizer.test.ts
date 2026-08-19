import { describe, it, expect } from 'vitest';
import { PLATFORMS } from '@/lib/constants';
import {
  analyzeContent,
  realNumberCount,
  stripNonEvidenceNumbers,
  scoreCovered,
  ARTICLE_MIN_CHARS,
  ARTICLE_MIN_SENTENCES,
  REAL_NUMBER_PER_1K_MIN,
  UNSCORED_NOTE,
  type ContentDiagnosis,
} from '@/lib/algorithm/content-optimizer';

const dims = (d: ContentDiagnosis) => d.findings.map((f) => f.dimension);
const pick = (d: ContentDiagnosis, dim: string) => d.findings.find((f) => f.dimension === dim);
/** 长文那三条判据的维度名，一处写死，下面全引用它 */
const ARTICLE_DIMS = ['自包含性', '量化论据', '定义与边界'] as const;

// ── 样本 ───────────────────────────────────────────────────────────────────
// 都按公众号（PLATFORMS.wechat.kind === 'article'）写，长度都过 ARTICLE_MIN_CHARS。

/** 12 句里 7 句以指代开头（这/那/该/其/它们），脱离上文单独读不成立 */
const ANAPHORA_HEAVY = [
  '双层缓存这套做法我们上线了三个月，先说结论：命中率从六成二涨到九成一。',
  '这个数字是按每天凌晨三点的全量对账算出来的，不是抽样估的。',
  '那次改造真正花时间的不是写代码，是把旧的失效逻辑一条条拆干净。',
  '该模块原来有七处直接写库的入口，有三处根本没人记得是谁加的。',
  '其中最麻烦的一处藏在导出任务里，跑一次要四十分钟，谁都不敢动。',
  '它们共用同一把锁，任何一处卡住，整条链路都要跟着等。',
  '我们最后把入口收敛成两个，一个读一个写，别的路径全部走这两个。',
  '上线当天回滚过一次，原因是灰度开关的默认值写反了。',
  '这次回滚只花了四分钟，因为开关和代码是分开发布的。',
  '第二次上线加了双写对账，连续跑了七天没有差异才把旧路径下掉。',
  '那七天里每天早上第一件事就是看对账报表，看到第五天才敢放心。',
  '现在这套东西每天扛住两千三百万次请求，尾延迟稳定在十几毫秒。',
].join('');

/** 五句以「其实/其次/那么」开头——形似指代，其实不指回上文，一句都不该算 */
const PSEUDO_ANAPHORA = [
  '双层缓存这套做法我们上线了三个月，命中率从六成二涨到九成一。',
  '其实一开始我并不觉得缓存是瓶颈，压测数据看着挺健康的。',
  '那么问题出在哪？出在凌晨的批量任务，它把连接池吃干净了。',
  '其次是失效策略，我们原来写的是定时清空，粗暴但省事。',
  '其实定时清空在流量平稳的时候看不出问题，一到活动就露馅。',
  '我们后来改成写入即失效，代价是每次写要多一次网络往返。',
  '压测跑了七轮，尾延迟从四十毫秒降到十八毫秒。',
  '其次要说的是监控，原来的面板只有命中率一条曲线，什么都看不出来。',
  '业务侧完全没有感知，客服工单也没有增加，运营那边一句话都没问过。',
  '成本上多出来的那点网络开销，一个月折合不到两百块钱。',
  '整件事花了我们两个人四周时间，其中一半时间在等灰度观察期。',
  '现在这套东西每天扛住两千三百万次请求，我们不再天天盯它了。',
].join('');

/** 满篇日期/版本号/章节序号，一个可核对的量化论据都没有 */
const NUM_POOR = [
  '这套内容流程我们从2026年6月开始试，到第3章讲的那个环节才算跑顺。',
  '当时用的还是v2.0的模板，功能少但稳定，团队上手很快，没人抱怨。',
  '6月18日那场活动是第一次全量跑，前后忙了整整一天，中午饭都没顾上吃。',
  '结果比预期要好，同事都说值得继续做下去，第二天就排了新的排期。',
  '后来我们把整个流程拆成三段，每段交给固定的人负责，交接点写清楚。',
  '交接文档写在共享盘里，谁都能改，改完在群里说一声，不用走审批。',
  '现在回头看，最该早做的其实是把口径先统一，而不是先上工具。',
  '工具解决不了口径问题，口径不统一，工具只会把错的东西算得更快。',
  '这一点我们付了不小的学费，希望你不要再走一遍同样的弯路。',
  '如果你也在推类似的事，先花两周把名词表拉出来，比什么都值。',
].join('');

/** 同一篇，末尾补一组真数字 */
const NUM_RICH = NUM_POOR + '补一组实测：改造后单篇平均阅读从87.3提升到142，完读率20%，退订率降了0.4个百分点。';

/** 四句超长句：字数够、句子数不够，自包含性这条不该出结论 */
const FEW_SENTENCES = [
  '这套双层缓存的做法我们前后折腾了三个月才算稳定下来，中间换过两版失效策略，也把凌晨批量任务的连接池单独隔了出来，现在回头看最值的一步其实是先把口径和边界写清楚。',
  '那段时间团队里最大的分歧在于要不要保留旧的直写路径，一派认为留着心里踏实，另一派认为留着就等于两套逻辑永远要同时维护，最后我们折中做了双写对账，跑满七天没有差异才把旧路径下掉。',
  '这中间还踩过一个很蠢的坑，灰度开关的默认值写反了，上线当天回滚了一次，好在开关和代码是分开发布的，四分钟就回来了，没有造成用户可见的故障。',
  '其中真正让我改变看法的是对账报表，它把我原来凭感觉判断的那些结论一条条推翻了，从那以后凡是要下结论的地方我都先问一句数据在哪。',
].join('');

const DEF_LINE = '先说清楚名词：所谓命中率，是指从缓存直接返回、没有回源查库的请求占全部请求的比例。';
const LIMIT_LINE = '最后交代适用范围：这套做法只对读多写少的场景成立，写入频繁的账务类数据不适用，请勿照搬。';

describe('长文判据（8a/8b/8c）：只对 kind === article 的平台生效', () => {
  it('公众号（kind=article）会跑这三条', () => {
    expect(PLATFORMS.wechat.kind).toBe('article');
    const d = analyzeContent(ANAPHORA_HEAVY, 'wechat');
    for (const dim of ARTICLE_DIMS) expect(dims(d)).toContain(dim);
  });

  it('🔒 抖音（kind=short_video）拿到同一篇长文，三条一条都不许出现', () => {
    // 判据量的是「长文形态」的属性，不是公众号这个平台的属性；反过来说，
    // 拿口播稿去量「有没有术语定义句」是错配，会给出一条用户没法执行的建议。
    expect(PLATFORMS.douyin.kind).not.toBe('article');
    const d = analyzeContent(ANAPHORA_HEAVY, 'douyin');
    for (const dim of ARTICLE_DIMS) expect(dims(d)).not.toContain(dim);
  });

  it('不认识的平台也不套长文判据', () => {
    const d = analyzeContent(ANAPHORA_HEAVY, 'zhihu');
    for (const dim of ARTICLE_DIMS) expect(dims(d)).not.toContain(dim);
  });
});

describe('🔒 样本不足：不够长时三条都不出——而且不是出 good', () => {
  it(`短于 ARTICLE_MIN_CHARS（${ARTICLE_MIN_CHARS}）一条都不出`, () => {
    const short = NUM_RICH.slice(0, ARTICLE_MIN_CHARS - 1);
    expect(short.length).toBe(ARTICLE_MIN_CHARS - 1);
    const d = analyzeContent(short, 'wechat');
    for (const dim of ARTICLE_DIMS) {
      expect(dims(d), `${dim} 在样本不够时不该出现`).not.toContain(dim);
    }
    // 「没测」和「测过没问题」在用户眼里长得一样、含义完全相反：这三条一个 good 都不许有
    expect(d.findings.filter((f) => (ARTICLE_DIMS as readonly string[]).includes(f.dimension))).toEqual([]);
  });

  it('刚好到 ARTICLE_MIN_CHARS 就开始出', () => {
    const d = analyzeContent(NUM_RICH.slice(0, ARTICLE_MIN_CHARS), 'wechat');
    for (const dim of ARTICLE_DIMS) expect(dims(d)).toContain(dim);
  });

  it(`🔒 字数够但句子不足 ${ARTICLE_MIN_SENTENCES} 句：自包含性不出结论，另外两条照出`, () => {
    // 3 句里 1 句指代开头就是 33%，那是分母太小，不是问题。
    expect(FEW_SENTENCES.length).toBeGreaterThanOrEqual(ARTICLE_MIN_CHARS);
    const d = analyzeContent(FEW_SENTENCES, 'wechat');
    expect(dims(d)).not.toContain('自包含性');
    expect(dims(d)).toContain('量化论据');
    expect(dims(d)).toContain('定义与边界');
  });
});

describe('8a 自包含性', () => {
  it('指代开头占比过半 → warn，并指出第一处', () => {
    const f = pick(analyzeContent(ANAPHORA_HEAVY, 'wechat'), '自包含性')!;
    expect(f.severity).toBe('warn');
    expect(f.finding).toContain('以指代开头');
    expect(f.finding).toContain('这个数字'); // 第一处原文，方便用户定位
  });

  it('🔒「其实/其次/那么」形似指代但不指回上文，一句都不该算', () => {
    // 不排掉的话这篇 13 句里有 5 句被算成指代开头（38%），直接翻成 warn。
    // 一条恒亮的告警等于没有告警。
    const f = pick(analyzeContent(PSEUDO_ANAPHORA, 'wechat'), '自包含性')!;
    expect(f.severity).toBe('good');
    expect(f.finding).toContain('以指代开头的 0 句');
  });

  it('正常长文 → good', () => {
    const f = pick(analyzeContent(NUM_RICH, 'wechat'), '自包含性')!;
    expect(f.severity).toBe('good');
  });
});

describe('8b 量化论据：日期/版本号/章节序号不算论据', () => {
  it('剔除规则逐条对——这些都不是论据', () => {
    expect(realNumberCount('2026年6月')).toBe(0);
    expect(realNumberCount('2026-06-18')).toBe(0);
    expect(realNumberCount('2026/6/18')).toBe(0);
    expect(realNumberCount('6月18日')).toBe(0);
    expect(realNumberCount('6月18号')).toBe(0);
    expect(realNumberCount('v2.0')).toBe(0);
    expect(realNumberCount('V1.2.3')).toBe(0);
    expect(realNumberCount('1.2.3')).toBe(0);
    expect(realNumberCount('第3章')).toBe(0);
    expect(realNumberCount('第 2 步')).toBe(0);
  });

  it('这些是论据，一个都不许被剔掉', () => {
    expect(realNumberCount('87.3')).toBe(1); // 裸两段小数是真数字，不是版本号
    expect(realNumberCount('20%')).toBe(1);
    expect(realNumberCount('142')).toBe(1);
    expect(realNumberCount('0.4个百分点')).toBe(1);
    // 区间不许被 DATE_RE 整段吃掉（月/日后要数字边界就是为了这个）
    expect(realNumberCount('客单价在5000-8000之间')).toBe(2);
  });

  it('剔除只是替换成空格，不会把相邻的字粘起来', () => {
    expect(stripNonEvidenceNumbers('从2026年6月到第3章')).not.toMatch(/\d/);
    expect(stripNonEvidenceNumbers('涨到87.3分')).toContain('87.3');
  });

  it(`满篇日期版本号 → warn（每千字低于 ${REAL_NUMBER_PER_1K_MIN} 个）`, () => {
    const f = pick(analyzeContent(NUM_POOR, 'wechat'), '量化论据')!;
    expect(f.severity).toBe('warn');
    expect(f.finding).toContain('只剩 0 个数字');
  });

  it('补上真数字 → good', () => {
    const f = pick(analyzeContent(NUM_RICH, 'wechat'), '量化论据')!;
    expect(f.severity).toBe('good');
    expect(f.finding).toContain('4 个数字');
  });
});

describe('8c 定义与边界', () => {
  it('两样都没有 → warn，两样都点名', () => {
    const f = pick(analyzeContent(NUM_RICH, 'wechat'), '定义与边界')!;
    expect(f.severity).toBe('warn');
    expect(f.finding).toBe('全文既没有术语定义句，也没有适用边界/局限说明。');
  });

  it('两样都有 → good', () => {
    const f = pick(analyzeContent(DEF_LINE + NUM_RICH + LIMIT_LINE, 'wechat'), '定义与边界')!;
    expect(f.severity).toBe('good');
    expect(f.finding).toContain('既有');
  });

  // 「缺一样就报」曾经是这里的行为，收严两条构式之后改掉了：两条的真实命中率都只有一成上下，
  // 缺一样就报会让告警几乎恒亮；而且复盘/故事这类内容天然不需要术语定义，报它是误伤。
  it('只有定义句 → good，且如实说是哪一样', () => {
    const f = pick(analyzeContent(DEF_LINE + NUM_RICH, 'wechat'), '定义与边界')!;
    expect(f.severity).toBe('good');
    expect(f.finding).toContain('术语定义句');
    expect(f.finding).not.toContain('适用边界'); // 不许照抄「两样都有」的文案
  });

  it('只有边界说明 → good，且如实说是哪一样', () => {
    const f = pick(analyzeContent(NUM_RICH + LIMIT_LINE, 'wechat'), '定义与边界')!;
    expect(f.severity).toBe('good');
    expect(f.finding).toContain('适用边界');
    expect(f.finding).not.toContain('术语定义句');
  });

  it('定义句的判据是显式定义构式，「如何/怎么」不算', () => {
    // 收进来的话长文里几乎必然出现，这条判据就恒为真，等于没做。
    const q = NUM_RICH + '那么如何选？怎么判断值不值得做？';
    const f = pick(analyzeContent(q, 'wechat'), '定义与边界')!;
    expect(f.finding).toContain('术语定义句');
  });
});

describe('🔒 虚高分：规则表不全的平台不给分', () => {
  const TEXT = NUM_RICH;

  it('两张规则表都没有视频号——这就是这条判断真正拦住的那个平台', () => {
    expect(PLATFORMS.shipinhao).toBeTruthy(); // 不是拼错了平台 key
    expect(scoreCovered('shipinhao')).toBe(false);
    expect(scoreCovered('wechat')).toBe(true);
    expect(scoreCovered('zhihu')).toBe(false);
  });

  it('视频号：score 必须是 null，并且给出原因', () => {
    const d = analyzeContent(TEXT, 'shipinhao');
    expect(d.score).toBeNull();
    expect(d.scoreNote).toBe(UNSCORED_NOTE);
    expect(d.scoreNote).toBeTruthy();
  });

  it('空正文的视频号也不许破例给 20——null 只能有一种读法', () => {
    const d = analyzeContent('', 'shipinhao');
    expect(d.score).toBeNull();
    expect(d.scoreNote).toBe(UNSCORED_NOTE);
  });

  it('规则覆盖全的平台照常给数字分', () => {
    const d = analyzeContent(TEXT, 'wechat');
    expect(typeof d.score).toBe('number');
    expect(d.score).toBeGreaterThanOrEqual(20);
    expect(d.score).toBeLessThanOrEqual(100);
    expect(d.scoreNote).toBeNull();
    expect(analyzeContent('', 'wechat').score).toBe(20);
  });

  it('虚高是怎么来的：同一篇稿子，视频号被检查的项明显更少', () => {
    // 扣分制 + 查不到规则时静默跳过 = 不检查 = 不扣分 = 分更高。
    // 缺席在这里被当成了「满分通过」，是「缺席不许当 0」的反向踩坑。
    const warnsOf = (p: string) => analyzeContent(TEXT, p).findings.filter((f) => f.severity !== 'good').length;
    expect(warnsOf('shipinhao')).toBeLessThan(warnsOf('wechat'));
    expect(dims(analyzeContent(TEXT, 'shipinhao'))).not.toContain('篇幅适配');
    expect(dims(analyzeContent(TEXT, 'shipinhao')).join()).not.toContain('互动引导');
  });
});

// ── 8c 两条正则的宽严实测 ───────────────────────────────────────────────────
//
// 源码里对 DEFINITION_RE 写得很谨慎（「把如何/怎么也收进来的话这条判据就恒为真，等于没做」），
// 同一段代码的 LIMIT_RE 却收了「注意」「风险」这种极常见词。两者标准对不上，
// 所以这里用一批**真实口吻的长文样本**把命中率量出来，而不是凭印象下结论。
//
// 样本说明（读结论前先读这段）：8 篇都是照公众号常见体裁手写的人味稿（测评/复盘/行业观察/
// 教程/种草/育儿/科普/职场），长度 379–468 字，都过了 ARTICLE_MIN_CHARS。
// 它们不是抓来的线上语料，写的时候没有刻意塞入或回避任何判据词——但作者知道判据长什么样，
// 这个偏差没法完全消掉，所以下面的数字只当**量级参考**，真正的结论落在后面那几条确定性的误判用例上。
const ARTICLE_SAMPLES: Array<[string, string]> = [
  ['工具测评', `上周把三款 AI 写作工具排了个序，标准只有一个：初稿改完还剩多少是我自己的话。第一款生成速度最快，八百字大概十二秒，但通篇是「赋能」「闭环」，我逐句改下来花了四十分钟，比自己写还慢。第二款慢一些，二十多秒，好处是能吃我给的三篇旧稿当范例，语气对上了六成，改稿时间压到十五分钟。第三款主打长文，一次能出三千字，可惜结构死板，每一段都是「首先其次最后」，读起来像小学生作文。我最后留下了第二款，一个月三十九块。选工具别看官网的演示，把你自己最近写的三篇丢进去，看它模仿得像不像，二十分钟就能试出来。补充一点我踩过的坑：这三款都支持导入历史文章做风格学习，但导入的篇数太少没用，我一开始只传了两篇，出来的稿子跟没传一样。传到八篇以上才开始像。还有就是别指望它替你想选题，我试过让它列十个题目，八个是「盘点」「合集」这种通用壳子，剩下两个还得我自己改。它擅长的是把我脑子里那句话铺成三百字，不是从零给我一个想法。这一个月我一共发了十一篇，其中七篇是它起的稿，平均阅读比我自己硬写的那四篇高一点点，差距不大，但我每篇省下来的四十分钟是实打实的。`],
  ['离职复盘', `离职一年，账上少了三十七万，这是实话。去年七月我从一家做医疗器械的公司出来，当时手里有两个熟客，觉得撑半年没问题。结果第三个月熟客的项目黄了，第四个月开始翻通讯录，一天打二十通电话，成了两单。最难的是去年十二月，账上只剩八千块，房租三千五。我那时候每天六点起来写公众号，写了四十七篇，涨了两千粉，接到第一条商单是今年三月，报价四千。现在稳定在月入一万二左右，比上班时少一半。如果你也想走这条路，我的建议是先攒够十八个月的房租，不是六个月。为什么是十八个月？因为从零开始建立信任这件事，我实际用了十四个月。前六个月发出去的东西根本没人看，中间四个月有人看了但不找你，最后四个月才陆续有人来问价。这三段的心态完全不一样，第一段是自我怀疑，第二段是焦虑，第三段反而平静了。另外还有一笔账当时没算：社保和公积金断掉之后自己交，一个月两千三，一年就是两万七，这笔钱在我原来的预算表里压根没有出现过。`],
  ['行业观察', `我家楼下那条街，两年里开了九家咖啡店，现在还剩三家。第一家倒的是精品手冲，老板是从上海回来的，一杯拿铁卖三十八，撑了七个月。第二家是连锁加盟，装修花了二十六万，做了一年零两个月，转让费从八万降到两万都没人接。活下来的三家有个共同点：都在写字楼底商，中午卖简餐，咖啡只占营业额的四成。做餐饮的朋友跟我说过一句话，租金超过营业额的百分之十五就别开了。这条街的商铺租金去年涨了两成，日均客流反而降了。我后来专门去问了还开着的那三家老板，有两个给的答案一模一样：他们从第二年开始不做外卖了。平台抽成加满减，一杯十八块的美式到手不到十块，忙一中午等于给平台打工。停掉外卖之后单量少了三分之一，利润反而多了。第三家的老板做法不一样，他把二楼隔出来做自习室，两小时十五块，续杯免费，工作日下午几乎坐满。他说卖的不是咖啡，是座位。这条街上死掉的六家，我印象里有五家都在拼命降价，最后一杯拿铁卖到九块九，撑了不到三个月。`],
  ['工具教程', `很多人用了十年 Excel，还在用鼠标一格一格拖。今天说三个函数，学会能省一半时间。第一个 XLOOKUP，比 VLOOKUP 好用在它可以往左查，也不用数第几列，写法是查什么、在哪查、返回哪一列。第二个 TEXTSPLIT，一列地址拆成省市区，以前要分列向导点五步，现在一个公式。第三个 LET，可以在公式里起变量名，长公式改起来不用满屏找。这三个都要 365 版本，2019 及以下用不了。今晚花二十分钟，明天做报表就能快。我拿自己每周做的那张渠道报表算过账：以前从原始数据到成品要五十分钟，其中光是把三张表按订单号拼起来就占二十分钟，换成 XLOOKUP 之后这一步是三分钟。TEXTSPLIT 那一步省得更多，我们的地址字段是业务员手填的，逗号空格顿号混着来，以前分列每次都要重新点一遍分隔符，现在一个公式写死。LET 是三个里面最不起眼但最救命的，我有一条嵌套了七层的公式，去年交接给同事，他看了半小时没看懂，改成 LET 之后每一段有名字，他自己就能改。`],
  ['产品种草', `除螨仪到底是不是智商税，我买了三台自己测。第一台一百九，拆开看只有一个震动马达，吸力标称八千帕，实测拿纸巾试基本吸不动。第二台四百五，带紫外灯和加热，吸完床单能看到集尘盒里一层灰白色的粉末，说明书说是皮屑。第三台一千二，多了个尘螨传感器，会亮红灯，我拿刚洗过的被套试，它也亮红灯，这个功能我不太信。结论是四百到六百这一档最值，再贵多出来的都是灯效。另外提醒一句，除螨仪解决不了过敏源问题，真过敏还是得换防螨床罩，每两周洗一次。测的方法我也说一下，免得有人觉得我在拍脑袋。三台我都在同一张床上测，同一条床单，间隔一周，每次吸三分钟，吸完把集尘盒里的东西倒在白纸上称重。第一台称出来零点零一克，基本等于没有。第二台零点一八克。第三台零点二一克，比第二台多出来的那点，我觉得跟它多的那两百瓦关系不大，更可能是我第三次吸的时候手更慢。真要说体感差别，第二台和第三台我分不出来。`],
  ['育儿经验', `孩子写作业磨蹭，我试过所有办法，最后管用的只有一个。以前是坐旁边盯着，写错一道题我就说一句，一小时的作业写到十点半，两个人都上火。后来换了个做法：写之前一起把作业列成清单，语文抄写、数学十二道、英语听读，每项估个时间，写在纸上贴桌角。做完一项划掉一项。第一周还是拖，第二周开始，八点四十能收工。我后来想明白了，磨蹭不是态度问题，是他不知道还有多少、什么时候能结束。大人加班到半夜心态崩，也是同一个原因。这个方法我用了四个月，中间有两次失效。一次是期末前作业量翻倍，清单列出来九项，他看一眼就说做不完，直接躺地上。那次我把清单撕了一半，只留当天必交的四项，剩下的第二天早上做。另一次是我自己没忍住，他估数学十五分钟，实际写了四十分钟，我说了一句「你看你又超了」，第二天他就不肯估时间了。后来我改成只记录不评价，把每项实际用了多久写在旁边，两周之后他自己发现数学总是估少，开始往上加。`],
  ['财经科普', `可转债这东西，说复杂也复杂，说简单就一句：它是一张债券，但你可以按约定价格换成股票。到期公司还本付息，这是它的底；股价涨上去你就转股赚差价，这是它的上限。所以有人说它下有保底上不封顶。真操作起来没那么美。第一，保底的前提是公司不违约，二零二三年已经有过第一只实质违约的转债。第二，多数转债现在的价格在一百二以上，如果最后只能拿回一百块本金加两三个点的利息，那也是亏。我自己的做法是只买一百一以下、评级 AA 以上的，仓位不超过两成。再说两个新手最容易踩的坑。一个是强制赎回，很多人不知道股价连续三十个交易日里有十五天超过转股价的百分之一百三，公司就可以按一百零几块把你的债收走，你要是那天没看公告，一百四买的转债直接变一百零三。我身边有人这么亏过两万多。另一个是抢权配售，为了配一手转债提前买正股，结果配到的那点收益还不够正股跌掉的，去年这种情况我见过五六次。`],
  ['职场方法', `周报写得像流水账，领导看完没印象，你干的活就等于没干。我带团队三年，看过大概两千份周报，写得好的不到一成。差别在哪？差的周报写「本周完成了活动页开发」，好的周报写「活动页上线，首日转化百分之三点二，比上一版高零点八个点，问题出在第二屏的按钮位置，下周 A/B 测」。前者说的是你干了什么，后者说的是这件事现在怎么样了。领导要的是后者。还有一条，把没做成的事也写上，写清卡在哪、需要谁配合。藏着不说，下周还是要爆。我自己带人的时候会给一个模板，三段：这周结论、下周动作、需要你拍板的事。第三段最关键，很多人从来不写，于是每周都在等，等到项目延期才说「一直没人定」。写的时候把选项列出来，A 方案什么代价、B 方案什么代价、你倾向哪个，领导只要回一个字母。我们组用这个格式之后，平均决策等待时间从四天降到一天半，这个数是我从项目管理工具里导出来算的，不是我拍的。`],
];

/** 通过公开 API 反推 8c 的两个布尔（正则本身没导出，也不该为测试导出）。 */
// 两条正则没有导出（也不该为了测试导出），所以从 finding 文案反推。
// ⚠️ 反推必须先看 severity 再看文案：warn 那句「全文既没有术语定义句，也没有适用边界…」
// 同时含这两个词，只按 includes 判会把「两样都缺」读成「两样都有」。
function defAndLimit(text: string): { hasDef: boolean; hasLimit: boolean } {
  const f = pick(analyzeContent(text, 'wechat'), '定义与边界');
  if (!f) throw new Error('样本没触发 8c，长度不够？');
  if (f.severity === 'warn') return { hasDef: false, hasLimit: false }; // warn 只在两样都缺时出
  return { hasDef: f.finding.includes('术语定义句'), hasLimit: f.finding.includes('适用边界') };
}

describe('8c 判据宽严实测：LIMIT_RE 到底有多容易命中', () => {
  it('样本本身合规：都够长、都能触发 8c', () => {
    for (const [name, t] of ARTICLE_SAMPLES) {
      expect(t.length, `${name} 太短`).toBeGreaterThanOrEqual(ARTICLE_MIN_CHARS);
    }
    expect(ARTICLE_SAMPLES.length).toBe(8);
  });

  it('人味长文语料上：两条构式都只在真写了的时候命中', () => {
    const limit = ARTICLE_SAMPLES.filter(([, t]) => defAndLimit(t).hasLimit).map(([n]) => n);
    const def = ARTICLE_SAMPLES.filter(([, t]) => defAndLimit(t).hasDef).map(([n]) => n);
    // 钉住具体是哪一篇：放宽任何一条正则，这里会变红，逼下一个人重新读一遍这段分析
    expect(limit).toEqual(['财经科普']); // 唯一命中来自「保底的前提是公司不违约」——真·边界句
    // 收严前这里是 ['离职复盘']，靠的是「为什么是十八个月」里的「什么是」——那是误判。
    // 八篇人味长文没有一篇真写了术语定义句，空数组才是这批语料的真实情况。
    expect(def).toEqual([]);
  });

  it('LIMIT_RE 不再把常见词当成边界说明（曾经的现状钉子，已修）', () => {
    // 三条都不含任何适用边界/局限说明，一条都不许让 hasLimit 变 true。
    // 第一条是这次收严的直接动因：「值得注意的是」是本库 AI 味词库里 weight 3 的套话
    // （lib/humanize/lexicon.ts 的 TRANSITION），而 analyzeContent 面对的正是 LLM 起的稿——
    // 同一个编辑器左边把它标成 AI 腔红字、右边拿它当「写了适用边界」放行，是自相矛盾的。
    const base = ARTICLE_SAMPLES[0][1];
    expect(defAndLimit(base).hasLimit).toBe(false);
    expect(defAndLimit(base + '值得注意的是，第二款的导入上限是十篇。').hasLimit).toBe(false);
    expect(defAndLimit(base + '读者的注意力只有三秒，开头必须给结果。').hasLimit).toBe(false);
    expect(defAndLimit(base + '这家公司拿过两轮风险投资，钱不是问题。').hasLimit).toBe(false);
    // 真·边界句仍要认出来，否则收严就成了「把这条判据关掉」
    expect(defAndLimit(base + '前提是你的号已经过了新手期，不适用于零粉起步。').hasLimit).toBe(true);
    expect(defAndLimit(base + '这套打法的局限性在于它吃素材量，效果因人而异。').hasLimit).toBe(true);
  });

  it('DEFINITION_RE 不再被子串误判（曾经的现状钉子，已修）', () => {
    // 「为什么是」里含「什么是」、「这是指标」里含「是指」，都是长文高频写法。
    const base = ARTICLE_SAMPLES[0][1];
    expect(defAndLimit(base).hasDef).toBe(false);
    expect(defAndLimit(base + '为什么是这三款而不是别的？因为别的我没花钱买。').hasDef).toBe(false);
    expect(defAndLimit(base + '我们团队看的这是指标体系里的第一档。').hasDef).toBe(false);
    expect(defAndLimit(base + '这不是指望它能一步到位。').hasDef).toBe(false);
    // 真·定义句照常认
    expect(defAndLimit(base + '什么是完播率？就是看完的人占点开的人的比例。').hasDef).toBe(true);
    expect(defAndLimit(base + 'CES 是指小红书那套互动加权分。').hasDef).toBe(true);
  });

  it('两样都缺才提示：只要写了其中一样就不再报 warn', () => {
    // 收严后两条构式的命中率都只有一成上下，「缺一样就报」会让告警几乎恒亮，
    // 而且对复盘/故事这类天然不需要术语定义的内容是误伤。
    const base = ARTICLE_SAMPLES[0][1];
    const dim = (t: string) =>
      analyzeContent(t, 'wechat').findings.find((f) => f.dimension === '定义与边界');

    expect(dim(base)?.severity).toBe('warn'); // 两样都没有
    expect(dim(base + '前提是你的号已经过了新手期。')?.severity).toBe('good'); // 只有边界
    expect(dim(base + '什么是完播率？看完的人占点开的人的比例。')?.severity).toBe('good'); // 只有定义
    // 只写了一样时，finding 要如实说是哪一样，不能照抄「两样都有」的文案
    expect(dim(base + '前提是你的号已经过了新手期。')?.finding).toContain('适用边界');
    expect(dim(base + '前提是你的号已经过了新手期。')?.finding).not.toContain('既有');
  });
});
