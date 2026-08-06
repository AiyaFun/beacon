// 系统级参考数据（敏感词库 + 平台算法规则 + 内置内容技能）——**唯一真相源**。
//
// 拆出来是因为它有两个消费者，各自的写入语义完全不同：
//   - `prisma/seed.ts`：开发/全新环境初始化，先 wipe 再全量写。**绝不能在生产跑**。
//   - `scripts/sync-system-data.ts`：生产增量同步，零 delete、按自然键 upsert、默认 dry-run。
// 数据放在任一脚本里，另一个就得抄一份 —— 抄本必然漂移，届时生产的词库和开发的对不上，
// 而这种漂移在测试里看不见（测试用的是 seed 那份）。

export const WORDLIST_VERSION = '2026.07';

export type SystemWord = {
  word: string;
  tier: string;
  platform?: string;
  action: string;
  suggestion?: string;
  category: string;
};

export type SystemRule = {
  platform: string;
  signal: string;
  weight: number;
  advice: string;
  contentType: string;
  confidence: string;
  source?: string;
};

// ── 敏感词库（四级中的全局三级：法律/平台/行业；自定义级 custom 由各租户自建）──
//
// 版本化：整库按月度发版，WORDLIST_VERSION 写入每行的 version 字段。
// 更新流程与商业审核 API 兜底方案见 docs/合规词库运营.md。
//
// 【选词与建表的两条硬约束，改词前必读】
// 1) DFA（lib/compliance/engine.ts scan）从**每个下标**重新起跳，且在匹配路径上
//    每经过一个 end 节点就命中一次。因此只要「A 是 B 的子串」（不限于前缀），
//    含 B 的文本就会同时命中 A 和 B（如 稳赚/稳赚不赔、带单/老师带单）。
//    同一检测集（legal + industry + 该平台 platform）内**禁止出现互为子串的词**，
//    一律只保留较短的那个——短词天然覆盖长变体，且只产生一次命中。
//    ⚠️ 注意 legal 与 industry 恒在同一检测集内，跨 tier 也会撞（本轮实测揪出 2 例）。
// 2) DFA 逐字符精确比较，**大小写敏感**且不做全半角/拼音变体归一化。
//    英文词一律小写录入（大写变体漏检是已知缺口，见 docs 的「缺口」章节）。
//
// 涉政类词库**刻意不收录**：自列既不完整也不专业，且漏一个的代价远高于全部漏掉。
// 该类目走商业审核服务（阿里云内容安全 / 腾讯天御）兜底，接入点见 docs。
export const SYSTEM_WORDS: SystemWord[] = [
  // ══════════ 法律级 L1：广告法第九条绝对化用语 ══════════
  // 第九条明文列举的只有「国家级/最高级/最佳」三个，故只有这三个 + 语义等价写法定 block；
  // 其余为市场监管执法口径中的扩展词，且多有日常口语用法（「最好先看看」「唯一的办法」），
  // 一律定 warn——block 会触发 hasRedline 的「禁止导出」硬闸，误伤代价太大。
  { word: '国家级', tier: 'legal', action: 'block', suggestion: '（专业级 / 高规格）', category: '极限词·法定' },
  { word: '最高级', tier: 'legal', action: 'block', suggestion: '（高规格）', category: '极限词·法定' },
  { word: '最佳', tier: 'legal', action: 'block', suggestion: '（合适的 / 推荐的）', category: '极限词·法定' },
  { word: '国家免检', tier: 'legal', action: 'block', suggestion: '（已通过质检）', category: '极限词·法定' },
  { word: '驰名商标', tier: 'legal', action: 'block', suggestion: '（知名品牌）', category: '极限词·法定' },
  { word: '国家认证', tier: 'legal', action: 'block', suggestion: '（已获得 XX 认证，注明具体机构）', category: '极限词·法定' },
  { word: '国家推荐', tier: 'legal', action: 'block', suggestion: '（注明具体推荐主体）', category: '极限词·法定' },
  { word: '政府推荐', tier: 'legal', action: 'block', suggestion: '（注明具体推荐主体）', category: '极限词·法定' },
  { word: '政府指定', tier: 'legal', action: 'block', suggestion: '（注明具体采购/合作关系）', category: '极限词·法定' },
  { word: '特供', tier: 'legal', action: 'block', suggestion: '（定制款）', category: '极限词·法定' },

  // 最X 家族（互不为前缀；「最好」保留但降级为 warn）
  { word: '最好', tier: 'legal', action: 'warn', suggestion: '（更优选择之一 / 建议）', category: '极限词' },
  { word: '最优', tier: 'legal', action: 'warn', suggestion: '（较优的）', category: '极限词' },
  { word: '最强', tier: 'legal', action: 'warn', suggestion: '（表现突出的）', category: '极限词' },
  { word: '最大', tier: 'legal', action: 'warn', suggestion: '（规模领先的）', category: '极限词' },
  { word: '最快', tier: 'legal', action: 'warn', suggestion: '（较快的）', category: '极限词' },
  { word: '最高端', tier: 'legal', action: 'warn', suggestion: '（高端的）', category: '极限词' },
  { word: '最先进', tier: 'legal', action: 'warn', suggestion: '（较为先进的）', category: '极限词' },
  { word: '最新科技', tier: 'legal', action: 'warn', suggestion: '（较新的技术方案）', category: '极限词' },
  { word: '最新技术', tier: 'legal', action: 'warn', suggestion: '（较新的技术方案）', category: '极限词' },
  { word: '最便宜', tier: 'legal', action: 'warn', suggestion: '（价格有优势）', category: '极限词' },
  { word: '最实惠', tier: 'legal', action: 'warn', suggestion: '（性价比不错）', category: '极限词' },
  { word: '最划算', tier: 'legal', action: 'warn', suggestion: '（性价比不错）', category: '极限词' },
  { word: '最省钱', tier: 'legal', action: 'warn', suggestion: '（更省成本）', category: '极限词' },
  { word: '最赚钱', tier: 'legal', action: 'warn', suggestion: '（收益较好的）', category: '极限词' },
  { word: '最畅销', tier: 'legal', action: 'warn', suggestion: '（销量较好，附统计口径）', category: '极限词' },
  { word: '最热销', tier: 'legal', action: 'warn', suggestion: '（近期热度较高）', category: '极限词' },
  { word: '最受欢迎', tier: 'legal', action: 'warn', suggestion: '（口碑较好）', category: '极限词' },
  { word: '最领先', tier: 'legal', action: 'warn', suggestion: '（处于领先位置）', category: '极限词' },
  { word: '最权威', tier: 'legal', action: 'warn', suggestion: '（较为专业的）', category: '极限词' },
  { word: '最专业', tier: 'legal', action: 'warn', suggestion: '（较为专业的）', category: '极限词' },
  { word: '最有效', tier: 'legal', action: 'warn', suggestion: '（较为有效的）', category: '极限词' },
  { word: '最安全', tier: 'legal', action: 'warn', suggestion: '（安全性较好）', category: '极限词' },
  { word: '最便捷', tier: 'legal', action: 'warn', suggestion: '（比较方便）', category: '极限词' },
  { word: '最舒适', tier: 'legal', action: 'warn', suggestion: '（体感不错）', category: '极限词' },
  { word: '最耐用', tier: 'legal', action: 'warn', suggestion: '（耐用性较好）', category: '极限词' },
  { word: '最流行', tier: 'legal', action: 'warn', suggestion: '（近期比较流行）', category: '极限词' },
  { word: '最火爆', tier: 'legal', action: 'warn', suggestion: '（近期热度高）', category: '极限词' },

  // 第X / 唯一性家族
  // 注意：不收录裸词「第一」——「第一次/第一步/第一时间」会爆量误报，改用具体宣称形式。
  { word: '第一品牌', tier: 'legal', action: 'warn', suggestion: '（知名品牌之一）', category: '极限词' },
  { word: '第一名', tier: 'legal', action: 'warn', suggestion: '（名列前茅，附榜单出处）', category: '极限词' },
  { word: '全国第一', tier: 'legal', action: 'warn', suggestion: '（全国范围内领先，附数据来源）', category: '极限词' },
  { word: '行业第一', tier: 'legal', action: 'warn', suggestion: '（行业领先，附数据来源）', category: '极限词' },
  { word: '销量第一', tier: 'legal', action: 'warn', suggestion: '（销量领先，附统计口径与周期）', category: '极限词' },
  { word: '排名第一', tier: 'legal', action: 'warn', suggestion: '（排名靠前，附榜单出处）', category: '极限词' },
  { word: '销量冠军', tier: 'legal', action: 'warn', suggestion: '（销量表现好，附统计口径）', category: '极限词' },
  { word: '唯一', tier: 'legal', action: 'warn', suggestion: '（少见的 / 目前已知的）', category: '极限词' },
  { word: '独一无二', tier: 'legal', action: 'warn', suggestion: '（有特色的）', category: '极限词' },
  { word: '举世无双', tier: 'legal', action: 'warn', suggestion: '（很有特色的）', category: '极限词' },
  { word: '绝无仅有', tier: 'legal', action: 'warn', suggestion: '（少见的）', category: '极限词' },
  { word: '独家', tier: 'legal', action: 'warn', suggestion: '（自有的 / 原创的）', category: '极限词' },
  { word: '首个', tier: 'legal', action: 'warn', suggestion: '（较早的一批）', category: '极限词' },
  { word: '史无前例', tier: 'legal', action: 'warn', suggestion: '（少见的）', category: '极限词' },
  { word: '前无古人', tier: 'legal', action: 'warn', suggestion: '（少见的）', category: '极限词' },
  { word: '空前绝后', tier: 'legal', action: 'warn', suggestion: '（少见的）', category: '极限词' },
  { word: '填补空白', tier: 'legal', action: 'warn', suggestion: '（较少人做的方向）', category: '极限词' },

  // 权威/荣誉/等级宣称
  { word: '顶级', tier: 'legal', action: 'warn', suggestion: '（高水准）', category: '极限词' },
  { word: '世界级', tier: 'legal', action: 'warn', suggestion: '（国际水准）', category: '极限词' },
  { word: '世界领先', tier: 'legal', action: 'warn', suggestion: '（国际上较为领先）', category: '极限词' },
  { word: '全球领先', tier: 'legal', action: 'warn', suggestion: '（国际上较为领先）', category: '极限词' },
  { word: '国际领先', tier: 'legal', action: 'warn', suggestion: '（国际上较为领先）', category: '极限词' },
  { word: '行业领先', tier: 'legal', action: 'suggest', suggestion: '（行业中表现较好，建议附依据）', category: '极限词' },
  { word: '领导品牌', tier: 'legal', action: 'warn', suggestion: '（行业内知名品牌）', category: '极限词' },
  { word: '领军品牌', tier: 'legal', action: 'warn', suggestion: '（行业内知名品牌）', category: '极限词' },
  { word: '无与伦比', tier: 'legal', action: 'warn', suggestion: '（很出色的）', category: '极限词' },
  { word: '无可比拟', tier: 'legal', action: 'warn', suggestion: '（有明显优势的）', category: '极限词' },
  { word: '无可挑剔', tier: 'legal', action: 'warn', suggestion: '（完成度很高）', category: '极限词' },
  { word: '登峰造极', tier: 'legal', action: 'warn', suggestion: '（水准很高）', category: '极限词' },
  { word: '至尊', tier: 'legal', action: 'warn', suggestion: '（高配版）', category: '极限词' },
  { word: '王中王', tier: 'legal', action: 'warn', suggestion: '（旗舰款）', category: '极限词' },
  { word: '之王', tier: 'legal', action: 'warn', suggestion: '（表现突出的）', category: '极限词' },
  { word: '之最', tier: 'legal', action: 'warn', suggestion: '（比较突出的）', category: '极限词' },
  { word: '国宴', tier: 'legal', action: 'warn', suggestion: '（宴请场景适用）', category: '极限词' },
  { word: '专供', tier: 'legal', action: 'warn', suggestion: '（定向款）', category: '极限词' },
  { word: '军用', tier: 'legal', action: 'warn', suggestion: '（高强度场景适用）', category: '极限词' },
  { word: '央视上榜', tier: 'legal', action: 'warn', suggestion: '（附具体节目与时间）', category: '极限词' },
  { word: '免检产品', tier: 'legal', action: 'warn', suggestion: '（已通过质检）', category: '极限词' },
  { word: '老字号', tier: 'legal', action: 'warn', suggestion: '（有年头的老店，「中华老字号」须持有认定）', category: '极限词' },
  { word: '权威认证', tier: 'legal', action: 'warn', suggestion: '（已通过 XX 认证，注明机构名）', category: '极限词' },
  { word: '万能', tier: 'legal', action: 'warn', suggestion: '（适用场景较广）', category: '极限词' },
  { word: '永久', tier: 'legal', action: 'warn', suggestion: '（长期）', category: '极限词' },
  { word: '绝对', tier: 'legal', action: 'warn', suggestion: '（通常 / 基本上）', category: '极限词' },
  { word: '百分百', tier: 'legal', action: 'warn', suggestion: '（绝大多数情况下）', category: '极限词' },

  // ══════════ 法律级 L1：虚假承诺 / 保证类 ══════════
  { word: '100%有效', tier: 'legal', action: 'block', suggestion: '（多数人反馈有帮助）', category: '虚假承诺' },
  { word: '保证有效', tier: 'legal', action: 'block', suggestion: '（多数人反馈有帮助）', category: '虚假承诺' },
  { word: '包过', tier: 'legal', action: 'block', suggestion: '（提供备考陪跑，通过率见公示）', category: '虚假承诺' },
  { word: '包就业', tier: 'legal', action: 'block', suggestion: '（提供就业推荐服务）', category: '虚假承诺' },
  { word: '保证就业', tier: 'legal', action: 'block', suggestion: '（提供就业推荐服务）', category: '虚假承诺' },
  { word: '保分', tier: 'legal', action: 'block', suggestion: '（提供提分方案，效果因人而异）', category: '虚假承诺' },
  { word: '零失败', tier: 'legal', action: 'warn', suggestion: '（失败率较低）', category: '虚假承诺' },
  { word: '零投诉', tier: 'legal', action: 'warn', suggestion: '（口碑良好）', category: '虚假承诺' },
  { word: '从未失败', tier: 'legal', action: 'warn', suggestion: '（成功率较高）', category: '虚假承诺' },
  { word: '万无一失', tier: 'legal', action: 'warn', suggestion: '（比较稳妥）', category: '虚假承诺' },
  { word: '十拿九稳', tier: 'legal', action: 'warn', suggestion: '（把握较大）', category: '虚假承诺' },
  { word: '一劳永逸', tier: 'legal', action: 'warn', suggestion: '（可长期复用）', category: '虚假承诺' },
  { word: '无条件', tier: 'legal', action: 'warn', suggestion: '（满足 XX 条件即可，写清条件）', category: '虚假承诺' },
  { word: '终身免费', tier: 'legal', action: 'warn', suggestion: '（当前版本免费，以公告为准）', category: '虚假承诺' },
  { word: '完全免费', tier: 'legal', action: 'suggest', suggestion: '（基础功能免费）', category: '虚假承诺' },
  { word: '一步到位', tier: 'legal', action: 'suggest', suggestion: '（流程较为完整）', category: '虚假承诺' },
  { word: '轻松搞定', tier: 'legal', action: 'suggest', suggestion: '（上手门槛较低）', category: '虚假承诺' },
  { word: '零基础也能', tier: 'legal', action: 'suggest', suggestion: '（新手友好，仍需投入练习）', category: '虚假承诺' },
  { word: '人人都能', tier: 'legal', action: 'suggest', suggestion: '（多数人可以尝试）', category: '虚假承诺' },
  { word: '秒变', tier: 'legal', action: 'suggest', suggestion: '（快速改善）', category: '虚假承诺' },

  // ══════════ 法律级 L1：医疗健康违规（《广告法》第十六/十七条、《医疗广告管理办法》）══════════
  // 「特效」不收录裸词——短视频语境「加个特效」会爆量误报，改用「特效药」。
  { word: '包治百病', tier: 'legal', action: 'block', suggestion: '（可能有助于缓解，具体请遵医嘱）', category: '医疗违规' },
  { word: '根治', tier: 'legal', action: 'block', suggestion: '（有助于改善，具体请遵医嘱）', category: '医疗违规' },
  { word: '特效药', tier: 'legal', action: 'block', suggestion: '（对症药物，请遵医嘱）', category: '医疗违规' },
  { word: '药到病除', tier: 'legal', action: 'block', suggestion: '（用药后多数人反馈有改善）', category: '医疗违规' },
  { word: '无副作用', tier: 'legal', action: 'block', suggestion: '（存在个体差异，请阅读说明书并遵医嘱）', category: '医疗违规' },
  { word: '零副作用', tier: 'legal', action: 'block', suggestion: '（存在个体差异，请阅读说明书并遵医嘱）', category: '医疗违规' },
  { word: '疗效显著', tier: 'legal', action: 'block', suggestion: '（个体反应不同，请遵医嘱）', category: '医疗违规' },
  { word: '疗效确切', tier: 'legal', action: 'block', suggestion: '（个体反应不同，请遵医嘱）', category: '医疗违规' },
  { word: '永不复发', tier: 'legal', action: 'block', suggestion: '（复发率较低，仍需遵医嘱随访）', category: '医疗违规' },
  { word: '消除肿瘤', tier: 'legal', action: 'block', suggestion: '（请以临床诊疗方案为准）', category: '医疗违规' },
  { word: '返老还童', tier: 'legal', action: 'block', suggestion: '（有助于状态改善）', category: '医疗违规' },
  { word: '包瘦', tier: 'legal', action: 'block', suggestion: '（配合饮食与运动，效果因人而异）', category: '医疗违规' },
  { word: '治癌', tier: 'legal', action: 'block', suggestion: '（请以临床诊疗方案为准）', category: '医疗违规' },
  { word: '根除', tier: 'legal', action: 'warn', suggestion: '（有助于改善）', category: '医疗违规' },
  { word: '快速见效', tier: 'legal', action: 'warn', suggestion: '（起效较快，因人而异）', category: '医疗违规' },
  { word: '立即见效', tier: 'legal', action: 'warn', suggestion: '（起效较快，因人而异）', category: '医疗违规' },
  { word: '立竿见影', tier: 'legal', action: 'warn', suggestion: '（反馈较快，因人而异）', category: '医疗违规' },
  { word: '三天见效', tier: 'legal', action: 'warn', suggestion: '（多数人短期内有反馈，因人而异）', category: '医疗违规' },
  { word: '七天见效', tier: 'legal', action: 'warn', suggestion: '（多数人短期内有反馈，因人而异）', category: '医疗违规' },
  { word: '医院推荐', tier: 'legal', action: 'warn', suggestion: '（注明具体机构，且不得用于处方药广告）', category: '医疗违规' },
  { word: '医生推荐', tier: 'legal', action: 'warn', suggestion: '（不得以医务人员名义推荐，改为客观介绍）', category: '医疗违规' },
  { word: '专家推荐', tier: 'legal', action: 'warn', suggestion: '（改为客观介绍或注明具体署名与资质）', category: '医疗违规' },
  { word: '临床验证', tier: 'legal', action: 'warn', suggestion: '（附具体研究出处）', category: '医疗违规' },

  // ══════════ 法律级 L1：金融理财违规（资管新规禁止承诺保本保收益）══════════
  // 「稳赚」覆盖「稳赚不赔/稳赚不亏」；「保本」覆盖「保本保息/保本理财」——只收短词，避免重复命中。
  { word: '保本', tier: 'legal', action: 'block', suggestion: '（本金存在波动风险）', category: '金融违规' },
  { word: '承诺收益', tier: 'legal', action: 'block', suggestion: '（历史业绩不代表未来表现）', category: '金融违规' },
  { word: '收益保证', tier: 'legal', action: 'block', suggestion: '（收益存在波动）', category: '金融违规' },
  { word: '稳赚', tier: 'legal', action: 'block', suggestion: '（存在风险，请谨慎判断）', category: '金融违规' },
  { word: '稳赢', tier: 'legal', action: 'block', suggestion: '（存在风险，请谨慎判断）', category: '金融违规' },
  { word: '只赚不赔', tier: 'legal', action: 'block', suggestion: '（盈亏自负，存在风险）', category: '金融违规' },
  { word: '包赚', tier: 'legal', action: 'block', suggestion: '（存在风险，请谨慎判断）', category: '金融违规' },
  { word: '保赚', tier: 'legal', action: 'block', suggestion: '（存在风险，请谨慎判断）', category: '金融违规' },
  { word: '必赚', tier: 'legal', action: 'block', suggestion: '（存在风险，请谨慎判断）', category: '金融违规' },
  { word: '必涨', tier: 'legal', action: 'block', suggestion: '（走势存在不确定性）', category: '金融违规' },
  { word: '必赢', tier: 'legal', action: 'block', suggestion: '（存在风险，请谨慎判断）', category: '金融违规' },
  { word: '刚性兑付', tier: 'legal', action: 'block', suggestion: '（不承诺兑付，风险自担）', category: '金融违规' },
  { word: '高收益低风险', tier: 'legal', action: 'block', suggestion: '（收益与风险正相关）', category: '金融违规' },
  // 「老师带单」不单列：与行业级「带单」构成子串关系会重复命中，「带单」已覆盖。
  { word: '无风险', tier: 'legal', action: 'warn', suggestion: '（风险较低，但非无风险）', category: '金融违规' },
  { word: '旱涝保收', tier: 'legal', action: 'warn', suggestion: '（收益存在波动）', category: '金融违规' },
  { word: '稳定盈利', tier: 'legal', action: 'warn', suggestion: '（盈利存在波动）', category: '金融违规' },
  { word: '资金安全', tier: 'legal', action: 'warn', suggestion: '（资金存在市场风险）', category: '金融违规' },
  { word: '一本万利', tier: 'legal', action: 'warn', suggestion: '（投入产出比较好）', category: '金融违规' },
  { word: '空手套白狼', tier: 'legal', action: 'warn', suggestion: '（低成本启动）', category: '金融违规' },
  { word: '无本创业', tier: 'legal', action: 'warn', suggestion: '（轻资产启动，仍有成本）', category: '金融违规' },
  { word: '零成本创业', tier: 'legal', action: 'warn', suggestion: '（低成本启动，仍有投入）', category: '金融违规' },
  { word: '躺赚', tier: 'legal', action: 'warn', suggestion: '（被动收入，前期需投入）', category: '金融违规' },
  { word: '躺平赚钱', tier: 'legal', action: 'warn', suggestion: '（被动收入，前期需投入）', category: '金融违规' },
  { word: '月入过万', tier: 'legal', action: 'warn', suggestion: '（收入因人而异，附真实样本）', category: '金融违规' },
  { word: '日入斗金', tier: 'legal', action: 'warn', suggestion: '（收入因人而异）', category: '金融违规' },
  { word: '睡后收入', tier: 'legal', action: 'suggest', suggestion: '（被动收入）', category: '金融违规' },
  { word: '财务自由', tier: 'legal', action: 'suggest', suggestion: '（收入结构优化）', category: '金融违规' },
  { word: '年化收益', tier: 'legal', action: 'suggest', suggestion: '（历史业绩不代表未来表现）', category: '金融违规' },
  { word: '稳健增值', tier: 'legal', action: 'suggest', suggestion: '（长期配置思路，仍有波动）', category: '金融违规' },
  { word: '割韭菜', tier: 'legal', action: 'suggest', suggestion: '（信息不对称下的亏损）', category: '金融违规' },

  // ══════════ 法律级 L1：价格与促销违规（《价格法》《禁止价格欺诈行为的规定》）══════════
  // 「虚构原价」不单列：与行业级「原价」构成子串关系会重复命中，且它是监管方的定性用语、
  // 创作者不会这么写；实际拦截由行业级「原价」(suggest，提示须有真实成交依据) 承担。
  { word: '史上最低', tier: 'legal', action: 'warn', suggestion: '（近期低价，附对比周期）', category: '价格违规' },
  { word: '全场最低', tier: 'legal', action: 'warn', suggestion: '（本场优惠力度较大）', category: '价格违规' },
  { word: '骨折价', tier: 'legal', action: 'warn', suggestion: '（大幅优惠）', category: '价格违规' },
  { word: '亏本甩卖', tier: 'legal', action: 'warn', suggestion: '（清仓优惠）', category: '价格违规' },
  { word: '内部价', tier: 'legal', action: 'warn', suggestion: '（专属优惠价）', category: '价格违规' },
  { word: '员工价', tier: 'legal', action: 'warn', suggestion: '（专属优惠价）', category: '价格违规' },
  { word: '老板跑路', tier: 'legal', action: 'warn', suggestion: '（清仓处理）', category: '价格违规' },
  { word: '错过再无', tier: 'legal', action: 'warn', suggestion: '（本轮优惠有截止时间）', category: '价格违规' },
  { word: '仅此一次', tier: 'legal', action: 'warn', suggestion: '（本轮活动限时）', category: '价格违规' },
  { word: '最后一天', tier: 'legal', action: 'warn', suggestion: '（活动临近结束，注明真实截止日）', category: '价格违规' },
  { word: '最后一批', tier: 'legal', action: 'warn', suggestion: '（库存有限，注明真实数量）', category: '价格违规' },
  { word: '0元购', tier: 'legal', action: 'warn', suggestion: '（限时免费领取，写清条件）', category: '价格违规' },
  { word: '假一赔十', tier: 'legal', action: 'warn', suggestion: '（假一赔三（按法定标准））', category: '价格违规' },
  { word: '假一罚十', tier: 'legal', action: 'warn', suggestion: '（假一赔三（按法定标准））', category: '价格违规' },
  { word: '官方指定', tier: 'legal', action: 'warn', suggestion: '（注明具体授权关系）', category: '价格违规' },
  { word: '正品保证', tier: 'legal', action: 'warn', suggestion: '（正规渠道进货，支持验货）', category: '价格违规' },
  { word: '划线价', tier: 'legal', action: 'suggest', suggestion: '（须有真实成交记录支撑）', category: '价格违规' },
  { word: '限时抢购', tier: 'legal', action: 'suggest', suggestion: '（限时优惠，注明真实截止时间）', category: '价格违规' },
  { word: '售完即止', tier: 'legal', action: 'suggest', suggestion: '（库存有限，注明真实数量）', category: '价格违规' },
  { word: '免费送', tier: 'legal', action: 'suggest', suggestion: '（限时赠送，写清领取条件）', category: '价格违规' },
  { word: '白菜价', tier: 'legal', action: 'suggest', suggestion: '（价格亲民）', category: '价格违规' },
  { word: '疯抢', tier: 'legal', action: 'suggest', suggestion: '（销量走高）', category: '价格违规' },

  // ══════════ 平台级 L2：抖音 ══════════
  { word: '微信', tier: 'platform', platform: 'douyin', action: 'warn', suggestion: '（私信我）', category: '导流' },
  { word: '加V', tier: 'platform', platform: 'douyin', action: 'warn', suggestion: '（私信我）', category: '导流' },
  { word: 'vx', tier: 'platform', platform: 'douyin', action: 'warn', suggestion: '（私信我）', category: '导流' },
  { word: 'V信', tier: 'platform', platform: 'douyin', action: 'warn', suggestion: '（私信我）', category: '导流' },
  { word: '威信', tier: 'platform', platform: 'douyin', action: 'warn', suggestion: '（私信我）', category: '导流·谐音变体' },
  { word: '薇信', tier: 'platform', platform: 'douyin', action: 'warn', suggestion: '（私信我）', category: '导流·谐音变体' },
  { word: '徽信', tier: 'platform', platform: 'douyin', action: 'warn', suggestion: '（私信我）', category: '导流·谐音变体' },
  { word: '扫码', tier: 'platform', platform: 'douyin', action: 'warn', suggestion: '（站内私信联系）', category: '导流' },
  { word: '公众号', tier: 'platform', platform: 'douyin', action: 'warn', suggestion: '（站内主页查看）', category: '导流' },
  { word: 'QQ', tier: 'platform', platform: 'douyin', action: 'warn', suggestion: '（站内私信联系）', category: '导流' },
  { word: '加好友', tier: 'platform', platform: 'douyin', action: 'warn', suggestion: '（点关注）', category: '导流' },
  { word: '加我好友', tier: 'platform', platform: 'douyin', action: 'warn', suggestion: '（点关注）', category: '导流' },
  { word: '联系方式', tier: 'platform', platform: 'douyin', action: 'warn', suggestion: '（站内私信联系）', category: '导流' },
  { word: '手机号', tier: 'platform', platform: 'douyin', action: 'warn', suggestion: '（站内私信联系）', category: '导流' },
  { word: '电话联系', tier: 'platform', platform: 'douyin', action: 'warn', suggestion: '（站内私信联系）', category: '导流' },
  { word: '加群', tier: 'platform', platform: 'douyin', action: 'warn', suggestion: '（加入粉丝群（站内））', category: '导流' },
  { word: '进群', tier: 'platform', platform: 'douyin', action: 'warn', suggestion: '（加入粉丝群（站内））', category: '导流' },
  { word: '淘口令', tier: 'platform', platform: 'douyin', action: 'warn', suggestion: '（走站内小黄车）', category: '导流' },
  { word: '站外', tier: 'platform', platform: 'douyin', action: 'warn', suggestion: '（站内购买链接）', category: '导流' },
  { word: '跳转链接', tier: 'platform', platform: 'douyin', action: 'warn', suggestion: '（站内购买链接）', category: '导流' },
  { word: '下方链接', tier: 'platform', platform: 'douyin', action: 'warn', suggestion: '（下方小黄车）', category: '导流' },
  { word: '主页链接', tier: 'platform', platform: 'douyin', action: 'warn', suggestion: '（主页橱窗）', category: '导流' },
  { word: '看简介', tier: 'platform', platform: 'douyin', action: 'warn', suggestion: '（主页查看）', category: '导流' },
  { word: '私聊', tier: 'platform', platform: 'douyin', action: 'suggest', suggestion: '（私信）', category: '导流' },
  { word: '私域', tier: 'platform', platform: 'douyin', action: 'suggest', suggestion: '（粉丝群）', category: '导流' },
  { word: '小红书', tier: 'platform', platform: 'douyin', action: 'warn', suggestion: '（删除跨平台指向）', category: '跨平台导流' },
  { word: '快手', tier: 'platform', platform: 'douyin', action: 'warn', suggestion: '（删除跨平台指向）', category: '跨平台导流' },
  { word: 'B站', tier: 'platform', platform: 'douyin', action: 'warn', suggestion: '（删除跨平台指向）', category: '跨平台导流' },
  { word: '淘宝', tier: 'platform', platform: 'douyin', action: 'warn', suggestion: '（站内小黄车）', category: '跨平台导流' },
  { word: '拼多多', tier: 'platform', platform: 'douyin', action: 'warn', suggestion: '（站内小黄车）', category: '跨平台导流' },
  { word: '京东', tier: 'platform', platform: 'douyin', action: 'warn', suggestion: '（站内小黄车）', category: '跨平台导流' },
  { word: '闲鱼', tier: 'platform', platform: 'douyin', action: 'warn', suggestion: '（站内小黄车）', category: '跨平台导流' },
  { word: '微店', tier: 'platform', platform: 'douyin', action: 'warn', suggestion: '（站内小黄车）', category: '跨平台导流' },
  { word: '有赞', tier: 'platform', platform: 'douyin', action: 'warn', suggestion: '（站内小黄车）', category: '跨平台导流' },
  { word: '刷单', tier: 'platform', platform: 'douyin', action: 'block', suggestion: '（删除——涉嫌虚假交易，平台重罚）', category: '虚假流量' },
  { word: '刷量', tier: 'platform', platform: 'douyin', action: 'block', suggestion: '（删除——涉嫌流量造假，平台重罚）', category: '虚假流量' },
  { word: '买赞', tier: 'platform', platform: 'douyin', action: 'block', suggestion: '（删除——涉嫌流量造假，平台重罚）', category: '虚假流量' },
  { word: '互赞', tier: 'platform', platform: 'douyin', action: 'warn', suggestion: '（删除——涉嫌互刷）', category: '虚假流量' },
  { word: '互粉', tier: 'platform', platform: 'douyin', action: 'warn', suggestion: '（删除——涉嫌互刷）', category: '虚假流量' },
  { word: '求关注', tier: 'platform', platform: 'douyin', action: 'suggest', suggestion: '（觉得有用可以关注）', category: '诱导互动' },
  { word: '双击666', tier: 'platform', platform: 'douyin', action: 'suggest', suggestion: '（认同的话点个赞）', category: '诱导互动' },
  { word: '点击右上角', tier: 'platform', platform: 'douyin', action: 'suggest', suggestion: '（可以收藏起来）', category: '诱导互动' },
  { word: '抽奖', tier: 'platform', platform: 'douyin', action: 'warn', suggestion: '（走平台官方活动组件）', category: '诱导互动' },
  { word: '免费领取', tier: 'platform', platform: 'douyin', action: 'warn', suggestion: '（走平台官方福袋/活动）', category: '诱导互动' },
  { word: '招代理', tier: 'platform', platform: 'douyin', action: 'warn', suggestion: '（走平台官方招商渠道）', category: '导流' },

  // ══════════ 平台级 L2：小红书 ══════════
  { word: '外链', tier: 'platform', platform: 'xiaohongshu', action: 'warn', suggestion: '（站内商品笔记）', category: '导流' },
  { word: '私域', tier: 'platform', platform: 'xiaohongshu', action: 'suggest', suggestion: '（群聊）', category: '导流' },
  { word: '抖音', tier: 'platform', platform: 'xiaohongshu', action: 'warn', suggestion: '（删除跨平台指向）', category: '跨平台导流' },
  { word: '淘宝', tier: 'platform', platform: 'xiaohongshu', action: 'warn', suggestion: '（站内商品链接）', category: '跨平台导流' },
  { word: '微信', tier: 'platform', platform: 'xiaohongshu', action: 'warn', suggestion: '（私信我）', category: '导流' },
  { word: 'vx', tier: 'platform', platform: 'xiaohongshu', action: 'warn', suggestion: '（私信我）', category: '导流' },
  { word: 'V信', tier: 'platform', platform: 'xiaohongshu', action: 'warn', suggestion: '（私信我）', category: '导流' },
  { word: '加V', tier: 'platform', platform: 'xiaohongshu', action: 'warn', suggestion: '（私信我）', category: '导流' },
  { word: '薇信', tier: 'platform', platform: 'xiaohongshu', action: 'warn', suggestion: '（私信我）', category: '导流·谐音变体' },
  { word: '公众号', tier: 'platform', platform: 'xiaohongshu', action: 'warn', suggestion: '（站内主页查看）', category: '跨平台导流' },
  { word: '淘口令', tier: 'platform', platform: 'xiaohongshu', action: 'warn', suggestion: '（站内商品链接）', category: '导流' },
  { word: '拼多多', tier: 'platform', platform: 'xiaohongshu', action: 'warn', suggestion: '（站内商品链接）', category: '跨平台导流' },
  { word: '京东', tier: 'platform', platform: 'xiaohongshu', action: 'warn', suggestion: '（站内商品链接）', category: '跨平台导流' },
  { word: '快手', tier: 'platform', platform: 'xiaohongshu', action: 'warn', suggestion: '（删除跨平台指向）', category: '跨平台导流' },
  { word: 'B站', tier: 'platform', platform: 'xiaohongshu', action: 'warn', suggestion: '（删除跨平台指向）', category: '跨平台导流' },
  { word: '视频号', tier: 'platform', platform: 'xiaohongshu', action: 'warn', suggestion: '（删除跨平台指向）', category: '跨平台导流' },
  { word: '闲鱼', tier: 'platform', platform: 'xiaohongshu', action: 'warn', suggestion: '（站内商品链接）', category: '跨平台导流' },
  { word: '微商', tier: 'platform', platform: 'xiaohongshu', action: 'warn', suggestion: '（品牌合作）', category: '导流' },
  { word: '代购', tier: 'platform', platform: 'xiaohongshu', action: 'warn', suggestion: '（正规渠道购买）', category: '导流' },
  { word: '招商', tier: 'platform', platform: 'xiaohongshu', action: 'warn', suggestion: '（走蒲公英平台合作）', category: '导流' },
  { word: '引流', tier: 'platform', platform: 'xiaohongshu', action: 'warn', suggestion: '（涨粉 / 获客）', category: '导流' },
  { word: '主页简介', tier: 'platform', platform: 'xiaohongshu', action: 'warn', suggestion: '（主页查看）', category: '导流' },
  { word: '简介自取', tier: 'platform', platform: 'xiaohongshu', action: 'warn', suggestion: '（评论区交流）', category: '导流' },
  { word: '广告', tier: 'platform', platform: 'xiaohongshu', action: 'suggest', suggestion: '（标注「合作」并走蒲公英报备）', category: '商业化合规' },
  { word: '恰饭', tier: 'platform', platform: 'xiaohongshu', action: 'suggest', suggestion: '（品牌合作（需报备））', category: '商业化合规' },
  { word: '好物推荐', tier: 'platform', platform: 'xiaohongshu', action: 'suggest', suggestion: '（真实体验分享）', category: '商业化合规' },
  { word: '三无产品', tier: 'platform', platform: 'xiaohongshu', action: 'warn', suggestion: '（请核实资质后再推荐）', category: '商品违规' },
  { word: '医美', tier: 'platform', platform: 'xiaohongshu', action: 'warn', suggestion: '（医美内容须持证并遵守平台专项规范）', category: '商品违规' },
  { word: '处方药', tier: 'platform', platform: 'xiaohongshu', action: 'block', suggestion: '（删除——处方药禁止面向公众推广）', category: '商品违规' },

  // ══════════ 平台级 L2：微信公众号 ══════════
  { word: '点击链接', tier: 'platform', platform: 'wechat', action: 'suggest', suggestion: '（阅读原文）', category: '诱导' },
  { word: '关注我', tier: 'platform', platform: 'wechat', action: 'suggest', suggestion: '（欢迎订阅）', category: '诱导' },
  { word: '转发', tier: 'platform', platform: 'wechat', action: 'suggest', suggestion: '（分享给需要的朋友）', category: '诱导' },
  { word: '诱导分享', tier: 'platform', platform: 'wechat', action: 'block', suggestion: '（删除——违反《微信外部链接内容管理规范》）', category: '诱导分享' },
  { word: '分享到朋友圈', tier: 'platform', platform: 'wechat', action: 'warn', suggestion: '（觉得有用可以分享）', category: '诱导分享' },
  { word: '集赞', tier: 'platform', platform: 'wechat', action: 'block', suggestion: '（删除——平台明令禁止集赞类诱导）', category: '诱导分享' },
  { word: '点赞领取', tier: 'platform', platform: 'wechat', action: 'block', suggestion: '（删除——平台明令禁止利益诱导互动）', category: '诱导分享' },
  { word: '关注领取', tier: 'platform', platform: 'wechat', action: 'block', suggestion: '（删除——平台明令禁止利益诱导关注）', category: '诱导分享' },
  { word: '助力', tier: 'platform', platform: 'wechat', action: 'warn', suggestion: '（删除——涉嫌诱导分享）', category: '诱导分享' },
  { word: '砍价', tier: 'platform', platform: 'wechat', action: 'warn', suggestion: '（删除——涉嫌诱导分享）', category: '诱导分享' },
  { word: '拼团', tier: 'platform', platform: 'wechat', action: 'suggest', suggestion: '（走微信小商店官方组件）', category: '诱导分享' },
  { word: '二维码', tier: 'platform', platform: 'wechat', action: 'warn', suggestion: '（文末公众号名片）', category: '导流' },
  { word: '长按识别', tier: 'platform', platform: 'wechat', action: 'warn', suggestion: '（文末公众号名片）', category: '导流' },
  { word: '外部链接', tier: 'platform', platform: 'wechat', action: 'warn', suggestion: '（阅读原文 / 小程序跳转）', category: '导流' },
  { word: '抖音', tier: 'platform', platform: 'wechat', action: 'warn', suggestion: '（视频号）', category: '跨平台导流' },
  { word: '小红书', tier: 'platform', platform: 'wechat', action: 'warn', suggestion: '（删除跨平台指向）', category: '跨平台导流' },
  { word: '淘宝', tier: 'platform', platform: 'wechat', action: 'warn', suggestion: '（微信小商店）', category: '跨平台导流' },
  { word: '红包', tier: 'platform', platform: 'wechat', action: 'warn', suggestion: '（走官方活动组件，勿用现金诱导）', category: '诱导分享' },
  { word: '提现', tier: 'platform', platform: 'wechat', action: 'warn', suggestion: '（走官方结算流程）', category: '诱导分享' },
  { word: '分销', tier: 'platform', platform: 'wechat', action: 'warn', suggestion: '（删除——多级分销涉嫌违规）', category: '诱导分享' },
  { word: '阅读原文', tier: 'platform', platform: 'wechat', action: 'suggest', suggestion: '（合规，注意落地页须为已备案站点）', category: '诱导' },
  { word: '星标', tier: 'platform', platform: 'wechat', action: 'suggest', suggestion: '（设为星标不迷路）', category: '诱导' },
  { word: '在看', tier: 'platform', platform: 'wechat', action: 'suggest', suggestion: '（觉得有用点个「在看」）', category: '诱导' },

  // ══════════ 平台级 L2：微信视频号 ══════════
  // 与公众号同属微信生态、共用《微信外部链接内容管理规范》的诱导分享红线，但**不能直接复用
  // wechat 那份**：视频号是短视频场景，没有「阅读原文/在看/星标」，多的是「引导私加微信」
  // 与「跨平台导流到抖音」。故单独一份，措辞按视频号场景改写。
  // 分档依据：明令禁止的利益诱导 → block；规范里写了但按情节处置的 → warn；只是表达更稳妥 → suggest。
  { word: '诱导分享', tier: 'platform', platform: 'shipinhao', action: 'block', suggestion: '（删除——违反《微信外部链接内容管理规范》）', category: '诱导分享' },
  { word: '集赞', tier: 'platform', platform: 'shipinhao', action: 'block', suggestion: '（删除——平台明令禁止集赞类诱导）', category: '诱导分享' },
  { word: '点赞领取', tier: 'platform', platform: 'shipinhao', action: 'block', suggestion: '（删除——平台明令禁止利益诱导互动）', category: '诱导分享' },
  { word: '关注领取', tier: 'platform', platform: 'shipinhao', action: 'block', suggestion: '（删除——平台明令禁止利益诱导关注）', category: '诱导分享' },
  { word: '转发抽奖', tier: 'platform', platform: 'shipinhao', action: 'block', suggestion: '（删除——转发类抽奖属明令禁止的诱导分享）', category: '诱导分享' },
  { word: '助力', tier: 'platform', platform: 'shipinhao', action: 'warn', suggestion: '（删除——涉嫌诱导分享）', category: '诱导分享' },
  { word: '砍价', tier: 'platform', platform: 'shipinhao', action: 'warn', suggestion: '（删除——涉嫌诱导分享）', category: '诱导分享' },
  { word: '分享到朋友圈', tier: 'platform', platform: 'shipinhao', action: 'warn', suggestion: '（觉得有用可以转给朋友）', category: '诱导分享' },
  { word: '红包', tier: 'platform', platform: 'shipinhao', action: 'warn', suggestion: '（走官方活动组件，勿用现金诱导）', category: '诱导分享' },
  { word: '分销', tier: 'platform', platform: 'shipinhao', action: 'warn', suggestion: '（删除——多级分销涉嫌违规）', category: '诱导分享' },
  // 导流：视频号最常见的违规是把公域流量引去私加微信
  { word: '加微信', tier: 'platform', platform: 'shipinhao', action: 'warn', suggestion: '（主页看联系方式 / 走官方私信）', category: '导流' },
  { word: '加V', tier: 'platform', platform: 'shipinhao', action: 'warn', suggestion: '（主页看联系方式 / 走官方私信）', category: '导流' },
  { word: 'vx', tier: 'platform', platform: 'shipinhao', action: 'warn', suggestion: '（主页看联系方式 / 走官方私信）', category: '导流' },
  { word: '威信', tier: 'platform', platform: 'shipinhao', action: 'warn', suggestion: '（主页看联系方式 / 走官方私信）', category: '导流·谐音变体' },
  { word: '薇信', tier: 'platform', platform: 'shipinhao', action: 'warn', suggestion: '（主页看联系方式 / 走官方私信）', category: '导流·谐音变体' },
  { word: '扫码', tier: 'platform', platform: 'shipinhao', action: 'warn', suggestion: '（走视频号主页 / 官方小店组件）', category: '导流' },
  { word: '二维码', tier: 'platform', platform: 'shipinhao', action: 'warn', suggestion: '（走视频号主页 / 官方小店组件）', category: '导流' },
  { word: '私域', tier: 'platform', platform: 'shipinhao', action: 'warn', suggestion: '（删除——公域引私域是重点治理对象）', category: '导流' },
  { word: '进群', tier: 'platform', platform: 'shipinhao', action: 'warn', suggestion: '（走官方社群/直播间入口）', category: '导流' },
  // 跨平台导流：视频号里提竞品平台，与公众号同样受限（建议指向自己的视频号主页/小店）
  { word: '抖音', tier: 'platform', platform: 'shipinhao', action: 'warn', suggestion: '（删除跨平台指向）', category: '跨平台导流' },
  { word: '小红书', tier: 'platform', platform: 'shipinhao', action: 'warn', suggestion: '（删除跨平台指向）', category: '跨平台导流' },
  { word: '淘宝', tier: 'platform', platform: 'shipinhao', action: 'warn', suggestion: '（微信小店）', category: '跨平台导流' },
  // 表达优化（不违规，只是更稳妥）
  { word: '关注我', tier: 'platform', platform: 'shipinhao', action: 'suggest', suggestion: '（欢迎关注）', category: '诱导' },
  { word: '转发', tier: 'platform', platform: 'shipinhao', action: 'suggest', suggestion: '（分享给需要的朋友）', category: '诱导' },
  { word: '拼团', tier: 'platform', platform: 'shipinhao', action: 'suggest', suggestion: '（走微信小店官方组件）', category: '诱导分享' },

  // ══════════ 平台级 L2：B站 ══════════
  { word: '一键三连', tier: 'platform', platform: 'bilibili', action: 'suggest', suggestion: '（有帮助的话可以三连支持）', category: '诱导互动' },
  { word: '投币', tier: 'platform', platform: 'bilibili', action: 'suggest', suggestion: '（合规，勿承诺对价）', category: '诱导互动' },
  { word: '充电', tier: 'platform', platform: 'bilibili', action: 'suggest', suggestion: '（走官方充电计划）', category: '诱导互动' },
  { word: '求点赞', tier: 'platform', platform: 'bilibili', action: 'suggest', suggestion: '（认同的话点个赞）', category: '诱导互动' },
  { word: '求收藏', tier: 'platform', platform: 'bilibili', action: 'suggest', suggestion: '（可以收藏备用）', category: '诱导互动' },
  { word: '抽奖', tier: 'platform', platform: 'bilibili', action: 'warn', suggestion: '（走官方互动抽奖组件）', category: '诱导互动' },
  { word: '微信', tier: 'platform', platform: 'bilibili', action: 'warn', suggestion: '（私信我）', category: '导流' },
  { word: '淘宝', tier: 'platform', platform: 'bilibili', action: 'warn', suggestion: '（走会员购/悬赏计划）', category: '跨平台导流' },
  { word: '粉丝群', tier: 'platform', platform: 'bilibili', action: 'warn', suggestion: '（站内粉丝群）', category: '导流' },
  { word: '简介链接', tier: 'platform', platform: 'bilibili', action: 'warn', suggestion: '（走官方悬赏计划链接）', category: '导流' },
  { word: '评论区置顶', tier: 'platform', platform: 'bilibili', action: 'warn', suggestion: '（置顶内容勿含站外链接）', category: '导流' },
  { word: '恰饭', tier: 'platform', platform: 'bilibili', action: 'suggest', suggestion: '（商业推广（需在「花火」报备））', category: '商业化合规' },
  { word: '搬运', tier: 'platform', platform: 'bilibili', action: 'warn', suggestion: '（转载须获授权并标注来源）', category: '版权' },
  { word: '未授权转载', tier: 'platform', platform: 'bilibili', action: 'block', suggestion: '（删除——涉嫌侵权）', category: '版权' },

  // ══════════ 平台级 L2：X（注意 DFA 大小写敏感，统一小写录入）══════════
  { word: 'link in bio', tier: 'platform', platform: 'x', action: 'suggest', suggestion: '（外链会降低触达，考虑放在回复里）', category: '导流' },
  { word: 'giveaway', tier: 'platform', platform: 'x', action: 'warn', suggestion: '（须符合平台促销规则并披露）', category: '诱导互动' },
  { word: 'follow for follow', tier: 'platform', platform: 'x', action: 'warn', suggestion: '（删除——涉嫌互关刷量）', category: '虚假流量' },
  { word: 'f4f', tier: 'platform', platform: 'x', action: 'warn', suggestion: '（删除——涉嫌互关刷量）', category: '虚假流量' },
  { word: 'retweet to win', tier: 'platform', platform: 'x', action: 'warn', suggestion: '（须符合平台促销规则并披露）', category: '诱导互动' },
  { word: 'rt to win', tier: 'platform', platform: 'x', action: 'warn', suggestion: '（须符合平台促销规则并披露）', category: '诱导互动' },
  { word: 'dm me', tier: 'platform', platform: 'x', action: 'suggest', suggestion: '（reply here）', category: '导流' },
  { word: 'check my bio', tier: 'platform', platform: 'x', action: 'suggest', suggestion: '（外链会降低触达）', category: '导流' },
  { word: 'click the link', tier: 'platform', platform: 'x', action: 'warn', suggestion: '（外链会降低触达）', category: '导流' },
  { word: 'limited offer', tier: 'platform', platform: 'x', action: 'warn', suggestion: '（注明真实截止时间）', category: '诱导' },
  { word: 'airdrop', tier: 'platform', platform: 'x', action: 'warn', suggestion: '（加密资产推广须披露风险）', category: '金融风险' },
  { word: 'guaranteed returns', tier: 'platform', platform: 'x', action: 'block', suggestion: '（returns are not guaranteed）', category: '金融风险' },
  { word: 'guaranteed profit', tier: 'platform', platform: 'x', action: 'block', suggestion: '（profits are not guaranteed）', category: '金融风险' },
  { word: 'get rich quick', tier: 'platform', platform: 'x', action: 'warn', suggestion: '（删除——涉嫌虚假收益承诺）', category: '金融风险' },
  { word: '100x', tier: 'platform', platform: 'x', action: 'warn', suggestion: '（删除——涉嫌虚假收益承诺）', category: '金融风险' },
  { word: 'onlyfans', tier: 'platform', platform: 'x', action: 'warn', suggestion: '（成人内容导流须符合平台分级规则）', category: '内容分级' },
  { word: 'telegram', tier: 'platform', platform: 'x', action: 'suggest', suggestion: '（站外群组导流易被限流）', category: '导流' },
  { word: 'whatsapp', tier: 'platform', platform: 'x', action: 'suggest', suggestion: '（站外群组导流易被限流）', category: '导流' },

  // ══════════ 平台级 L2：YouTube ══════════
  { word: 'subscribe now', tier: 'platform', platform: 'youtube', action: 'suggest', suggestion: '（if this helped, consider subscribing）', category: '诱导互动' },
  { word: 'click here', tier: 'platform', platform: 'youtube', action: 'suggest', suggestion: '（link in description）', category: '导流' },
  { word: 'smash the like button', tier: 'platform', platform: 'youtube', action: 'suggest', suggestion: '（a like helps the channel）', category: '诱导互动' },
  { word: 'hit the bell', tier: 'platform', platform: 'youtube', action: 'suggest', suggestion: '（turn on notifications if useful）', category: '诱导互动' },
  { word: 'like and subscribe', tier: 'platform', platform: 'youtube', action: 'suggest', suggestion: '（if this helped, consider subscribing）', category: '诱导互动' },
  { word: 'sub4sub', tier: 'platform', platform: 'youtube', action: 'block', suggestion: '（删除——违反平台虚假互动政策）', category: '虚假流量' },
  { word: 'watch till the end', tier: 'platform', platform: 'youtube', action: 'suggest', suggestion: '（结尾给真实增量，别空头承诺）', category: '诱导互动' },
  { word: 'first 100 people', tier: 'platform', platform: 'youtube', action: 'warn', suggestion: '（注明真实名额与截止时间）', category: '诱导' },
  { word: 'free gift card', tier: 'platform', platform: 'youtube', action: 'block', suggestion: '（删除——高危诈骗特征，账号会被处罚）', category: '诈骗特征' },
  { word: 'miracle cure', tier: 'platform', platform: 'youtube', action: 'block', suggestion: '（删除——违反医疗误导信息政策）', category: '医疗误导' },
  { word: 'lose weight fast', tier: 'platform', platform: 'youtube', action: 'warn', suggestion: '（results vary by individual）', category: '医疗误导' },
  { word: 'giveaway', tier: 'platform', platform: 'youtube', action: 'warn', suggestion: '（须符合平台促销规则并披露）', category: '诱导互动' },

  // ══════════ 平台级 L2：TikTok ══════════
  // TikTok 社区规范里最容易踩的几类：站外导流、诱导互动（follow for follow）、
  // 未披露的带货/推广、医疗与金融的绝对化承诺。全部只做「建议/警告」，
  // 只有明确违反社区准则的（互赞互粉、诈骗特征）才 block。
  { word: 'link in bio', tier: 'platform', platform: 'tiktok', action: 'suggest', suggestion: '（站外导流会降低分发，改成站内可闭环的引导）', category: '导流' },
  { word: 'follow for follow', tier: 'platform', platform: 'tiktok', action: 'block', suggestion: '（删除——违反平台虚假互动政策）', category: '虚假流量' },
  { word: 'f4f', tier: 'platform', platform: 'tiktok', action: 'block', suggestion: '（删除——违反平台虚假互动政策）', category: '虚假流量' },
  { word: 'like and follow', tier: 'platform', platform: 'tiktok', action: 'suggest', suggestion: '（换成一句让人想转发的话，分享权重高于关注引导）', category: '诱导互动' },
  { word: 'comment below', tier: 'platform', platform: 'tiktok', action: 'suggest', suggestion: '（换成一个具体的二选一问题，泛泛的号召无效）', category: '诱导互动' },
  { word: 'dm me', tier: 'platform', platform: 'tiktok', action: 'warn', suggestion: '（引导私聊易被判为站外导流/诈骗特征）', category: '导流' },
  { word: 'telegram', tier: 'platform', platform: 'tiktok', action: 'warn', suggestion: '（站外群组导流易被限流）', category: '导流' },
  { word: 'whatsapp', tier: 'platform', platform: 'tiktok', action: 'warn', suggestion: '（站外群组导流易被限流）', category: '导流' },
  { word: 'free gift card', tier: 'platform', platform: 'tiktok', action: 'block', suggestion: '（删除——高危诈骗特征，账号会被处罚）', category: '诈骗特征' },
  { word: 'guaranteed income', tier: 'platform', platform: 'tiktok', action: 'block', suggestion: '（income is not guaranteed）', category: '金融风险' },
  { word: 'miracle cure', tier: 'platform', platform: 'tiktok', action: 'block', suggestion: '（删除——违反医疗误导信息政策）', category: '医疗误导' },
  { word: 'lose weight fast', tier: 'platform', platform: 'tiktok', action: 'warn', suggestion: '（results vary by individual）', category: '医疗误导' },
  // 带货/推广未披露是 TikTok 罚得最狠的一类，且很多创作者不知道要标
  { word: 'sponsored', tier: 'platform', platform: 'tiktok', action: 'suggest', suggestion: '（务必同时打开「品牌内容」开关，仅正文写明不算披露）', category: '广告披露' },
  { word: 'paid partnership', tier: 'platform', platform: 'tiktok', action: 'suggest', suggestion: '（务必同时打开「品牌内容」开关，仅正文写明不算披露）', category: '广告披露' },

  // ══════════ 行业级 L3：医疗健康 ══════════
  { word: '治愈', tier: 'industry', action: 'warn', suggestion: '（改善 / 缓解）', category: '医疗' },
  { word: '抗癌', tier: 'industry', action: 'warn', suggestion: '（相关研究方向，勿作疗效宣称）', category: '医疗' },
  { word: '防癌', tier: 'industry', action: 'warn', suggestion: '（相关研究方向，勿作疗效宣称）', category: '医疗' },
  { word: '抑制肿瘤', tier: 'industry', action: 'warn', suggestion: '（请以临床研究结论为准）', category: '医疗' },
  { word: '降压', tier: 'industry', action: 'warn', suggestion: '（有助于血压管理，请遵医嘱）', category: '医疗' },
  { word: '降糖', tier: 'industry', action: 'warn', suggestion: '（有助于血糖管理，请遵医嘱）', category: '医疗' },
  { word: '降脂', tier: 'industry', action: 'warn', suggestion: '（有助于血脂管理，请遵医嘱）', category: '医疗' },
  { word: '消炎', tier: 'industry', action: 'warn', suggestion: '（请遵医嘱用药）', category: '医疗' },
  { word: '镇痛', tier: 'industry', action: 'warn', suggestion: '（请遵医嘱用药）', category: '医疗' },
  { word: '助眠', tier: 'industry', action: 'warn', suggestion: '（有助于放松，请遵医嘱）', category: '医疗' },
  { word: '壮阳', tier: 'industry', action: 'warn', suggestion: '（请遵医嘱，勿作功效宣称）', category: '医疗' },
  { word: '丰胸', tier: 'industry', action: 'warn', suggestion: '（勿作功效宣称）', category: '医疗' },
  { word: '增高', tier: 'industry', action: 'warn', suggestion: '（勿作功效宣称）', category: '医疗' },
  { word: '生发', tier: 'industry', action: 'warn', suggestion: '（有助于头皮护理，勿作功效宣称）', category: '医疗' },
  { word: '祛痘', tier: 'industry', action: 'warn', suggestion: '（有助于改善肌肤状态）', category: '美妆' },
  { word: '祛斑', tier: 'industry', action: 'warn', suggestion: '（有助于改善肤色不均）', category: '美妆' },
  { word: '祛疤', tier: 'industry', action: 'warn', suggestion: '（有助于淡化痕迹）', category: '美妆' },
  { word: '抗衰老', tier: 'industry', action: 'warn', suggestion: '（有助于抗初老护理）', category: '美妆' },
  { word: '美白', tier: 'industry', action: 'suggest', suggestion: '（提亮肤色（特殊化妆品须持证））', category: '美妆' },
  { word: '排毒', tier: 'industry', action: 'warn', suggestion: '（有助于代谢（无医学「排毒」概念））', category: '医疗' },
  { word: '养肝', tier: 'industry', action: 'warn', suggestion: '（有助于肝脏健康管理，请遵医嘱）', category: '医疗' },
  { word: '护肝', tier: 'industry', action: 'warn', suggestion: '（有助于肝脏健康管理，请遵医嘱）', category: '医疗' },
  { word: '补肾', tier: 'industry', action: 'warn', suggestion: '（勿作功效宣称，请遵医嘱）', category: '医疗' },
  { word: '提高免疫力', tier: 'industry', action: 'warn', suggestion: '（有助于日常健康管理）', category: '医疗' },
  { word: '增强免疫力', tier: 'industry', action: 'warn', suggestion: '（有助于日常健康管理）', category: '医疗' },
  { word: '延年益寿', tier: 'industry', action: 'warn', suggestion: '（有助于健康生活方式）', category: '医疗' },
  { word: '偏方', tier: 'industry', action: 'warn', suggestion: '（民间做法，请以正规诊疗为准）', category: '医疗' },
  { word: '秘方', tier: 'industry', action: 'warn', suggestion: '（自研配方，勿作疗效宣称）', category: '医疗' },
  { word: '老中医', tier: 'industry', action: 'warn', suggestion: '（注明具体资质与执业机构）', category: '医疗' },
  { word: '保健品', tier: 'industry', action: 'suggest', suggestion: '（保健食品不能替代药物，须标注警示语）', category: '医疗' },
  { word: '医疗器械', tier: 'industry', action: 'suggest', suggestion: '（须持械字号并按规定发布）', category: '医疗' },
  { word: '减肥', tier: 'industry', action: 'suggest', suggestion: '（体重管理（效果因人而异））', category: '医疗' },
  { word: '瘦身', tier: 'industry', action: 'suggest', suggestion: '（体态管理（效果因人而异））', category: '医疗' },

  // ══════════ 行业级 L3：金融理财 ══════════
  { word: '零风险', tier: 'industry', action: 'warn', suggestion: '（低风险，但非零风险）', category: '金融' },
  { word: '暴富', tier: 'industry', action: 'warn', suggestion: '（收入增长（因人而异））', category: '金融' },
  { word: '内幕', tier: 'industry', action: 'warn', suggestion: '（公开信息分析（内幕交易违法））', category: '金融' },
  { word: '荐股', tier: 'industry', action: 'warn', suggestion: '（删除——荐股须持牌）', category: '金融' },
  { word: '牛股', tier: 'industry', action: 'warn', suggestion: '（删除——涉嫌荐股）', category: '金融' },
  { word: '涨停', tier: 'industry', action: 'warn', suggestion: '（删除个股指向）', category: '金融' },
  { word: '带单', tier: 'industry', action: 'warn', suggestion: '（删除——高危诈骗特征）', category: '金融' },
  { word: '跟单', tier: 'industry', action: 'warn', suggestion: '（删除——高危诈骗特征）', category: '金融' },
  { word: '配资', tier: 'industry', action: 'warn', suggestion: '（删除——场外配资违法）', category: '金融' },
  { word: '原始股', tier: 'industry', action: 'warn', suggestion: '（删除——涉嫌非法证券活动）', category: '金融' },
  { word: '高利贷', tier: 'industry', action: 'warn', suggestion: '（删除——超出法定利率保护上限）', category: '金融' },
  { word: '套现', tier: 'industry', action: 'warn', suggestion: '（删除——涉嫌违规）', category: '金融' },
  { word: '虚拟货币', tier: 'industry', action: 'warn', suggestion: '（境内相关业务活动属非法金融活动）', category: '金融' },
  { word: '挖矿', tier: 'industry', action: 'warn', suggestion: '（境内已被列为淘汰类产业）', category: '金融' },
  { word: '空气币', tier: 'industry', action: 'warn', suggestion: '（删除——涉嫌欺诈）', category: '金融' },
  { word: '传销币', tier: 'industry', action: 'block', suggestion: '（删除——涉嫌组织传销）', category: '金融' },
  { word: '资金盘', tier: 'industry', action: 'block', suggestion: '（删除——涉嫌非法集资）', category: '金融' },
  { word: '洗钱', tier: 'industry', action: 'block', suggestion: '（删除——涉嫌犯罪）', category: '金融' },
  { word: '庞氏', tier: 'industry', action: 'warn', suggestion: '（仅作风险科普时保留）', category: '金融' },
  { word: '拉人头', tier: 'industry', action: 'warn', suggestion: '（删除——涉嫌传销特征）', category: '金融' },
  { word: '发展下线', tier: 'industry', action: 'warn', suggestion: '（删除——涉嫌传销特征）', category: '金融' },
  { word: '返利', tier: 'industry', action: 'warn', suggestion: '（优惠（避免多级返利结构））', category: '金融' },
  { word: '杠杆', tier: 'industry', action: 'suggest', suggestion: '（放大收益同时放大风险）', category: '金融' },
  { word: '私募', tier: 'industry', action: 'suggest', suggestion: '（不得向不特定对象公开推介）', category: '金融' },

  // ══════════ 行业级 L3：电商 / 商品 ══════════
  { word: '原价', tier: 'industry', action: 'suggest', suggestion: '（划线价，需真实成交依据）', category: '电商' },
  { word: '全网最低', tier: 'industry', action: 'warn', suggestion: '（价格有优势（须可举证））', category: '电商' },
  { word: '底价', tier: 'industry', action: 'warn', suggestion: '（优惠价）', category: '电商' },
  { word: '高仿', tier: 'industry', action: 'block', suggestion: '（删除——涉嫌销售假冒商品）', category: '电商' },
  { word: 'A货', tier: 'industry', action: 'block', suggestion: '（删除——涉嫌销售假冒商品）', category: '电商' },
  { word: '山寨', tier: 'industry', action: 'warn', suggestion: '（平替（勿指向假冒商品））', category: '电商' },
  { word: '水货', tier: 'industry', action: 'warn', suggestion: '（平行进口（须说明保修差异））', category: '电商' },
  { word: '大牌平替', tier: 'industry', action: 'warn', suggestion: '（同类替代选择（勿碰瓷品牌））', category: '电商' },
  { word: '明星同款', tier: 'industry', action: 'warn', suggestion: '（相似款（未经授权不得使用明星形象））', category: '电商' },
  { word: '网红同款', tier: 'industry', action: 'suggest', suggestion: '（相似款）', category: '电商' },
  { word: '清仓', tier: 'industry', action: 'suggest', suggestion: '（库存优惠）', category: '电商' },
  { word: '秒杀', tier: 'industry', action: 'suggest', suggestion: '（限时特惠）', category: '电商' },
  { word: '爆款', tier: 'industry', action: 'suggest', suggestion: '（热门款）', category: '电商' },
  { word: '尾单', tier: 'industry', action: 'suggest', suggestion: '（余量库存）', category: '电商' },

  // ══════════ 行业级 L3：教育培训 ══════════
  { word: '内部指标', tier: 'industry', action: 'warn', suggestion: '（删除——涉嫌虚假承诺）', category: '教育' },
  { word: '押题', tier: 'industry', action: 'warn', suggestion: '（考点梳理）', category: '教育' },
  { word: '原题', tier: 'industry', action: 'warn', suggestion: '（同类题型（泄题违法））', category: '教育' },
  { word: '免考', tier: 'industry', action: 'warn', suggestion: '（删除——涉嫌违规）', category: '教育' },
  { word: '快速拿证', tier: 'industry', action: 'warn', suggestion: '（正规流程报考）', category: '教育' },
  { word: '名校保送', tier: 'industry', action: 'block', suggestion: '（删除——涉嫌虚假承诺/诈骗）', category: '教育' },
  { word: '提分', tier: 'industry', action: 'suggest', suggestion: '（成绩提升（因人而异））', category: '教育' },
  { word: '学历提升', tier: 'industry', action: 'suggest', suggestion: '（须为国家承认的正规学历途径）', category: '教育' },

  // ══════════ 行业级 L3：食品 ══════════
  { word: '无添加', tier: 'industry', action: 'warn', suggestion: '（未额外添加 XX（写明具体成分））', category: '食品' },
  { word: '零添加', tier: 'industry', action: 'warn', suggestion: '（未额外添加 XX（写明具体成分））', category: '食品' },
  { word: '纯天然', tier: 'industry', action: 'warn', suggestion: '（天然原料（「纯天然」无国标定义））', category: '食品' },
  { word: '农家自制', tier: 'industry', action: 'warn', suggestion: '（须具备食品生产经营资质）', category: '食品' },
  { word: '有机', tier: 'industry', action: 'suggest', suggestion: '（须持有有机产品认证方可宣称）', category: '食品' },
  { word: '绿色食品', tier: 'industry', action: 'suggest', suggestion: '（须持有绿色食品标志许可）', category: '食品' },
];

// ── 平台算法规则库（多平台，含可信度分级）──
export const ALGORITHM_RULES: SystemRule[] = [
  { platform: 'douyin', signal: 'completion_rate', weight: 0.9, advice: '前3秒必须给出强钩子，视频时长控制在能让完播率最大化的区间', contentType: 'short_video', confidence: 'consensus', source: '行业普遍共识 + 官方创作者课程' },
  { platform: 'douyin', signal: 'interaction_5s', weight: 0.75, advice: '发布后1小时内引导评论互动，撬动初始流量池', contentType: 'short_video', confidence: 'consensus' },
  { platform: 'xiaohongshu', signal: 'ces_score', weight: 0.85, advice: '封面和标题决定点击，正文埋搜索关键词吃长尾搜索流量', contentType: 'image_text', confidence: 'consensus', source: '小红书官方 CES 机制说明' },
  { platform: 'xiaohongshu', signal: 'collect_rate', weight: 0.7, advice: '做"值得收藏"的干货清单，收藏率是重要加权项', contentType: 'image_text', confidence: 'consensus' },
  { platform: 'wechat', signal: 'read_completion', weight: 0.6, advice: '公众号改推荐流后，前50字和标题决定推荐量，正文完读率影响二次分发', contentType: 'article', confidence: 'consensus' },
  { platform: 'bilibili', signal: 'view_completion', weight: 0.8, advice: '播放完成度 + 三连是核心，进度条设计留住观众', contentType: 'long_video', confidence: 'consensus' },
  { platform: 'shipinhao', signal: 'share_fission', weight: 0.9, advice: '视频号的量级由社交关系链决定：内容要写出「值得转给谁」，观点能被一句话复述，避免只有圈内人懂的梗', contentType: 'short_video', confidence: 'consensus', source: '行业普遍共识（微信未披露具体权重）' },
  { platform: 'shipinhao', signal: 'completion_rate', weight: 0.7, advice: '完播卡的是第一层推荐：结论前置到第 1 句，砍掉自我介绍式开场，时长压到 1–3 分钟', contentType: 'short_video', confidence: 'consensus' },
  { platform: 'x', signal: 'reply_weight', weight: 0.75, advice: 'X 开源算法显示回复权重远高于点赞，用能引发讨论的观点收尾', contentType: 'short_text', confidence: 'opensource', source: 'twitter/the-algorithm 开源仓库' },
  { platform: 'youtube', signal: 'ctr_watchtime', weight: 0.9, advice: '缩略图CTR × 平均观看时长 × 会话时长共同决定推荐，做A/B缩略图', contentType: 'long_video', confidence: 'official', source: 'YouTube Creator 官方文档' },
  { platform: 'tiktok', signal: 'completion_rate', weight: 0.9, advice: '第 1 秒给视觉钩子（不是口播自我介绍），全片压到 21–34 秒这一档，结尾做无缝循环让人多看一遍', contentType: 'short_video', confidence: 'official', source: 'TikTok 官方「How TikTok recommends content」（列出观看完成度为最强信号之一）' },
  { platform: 'tiktok', signal: 'share_rate', weight: 0.8, advice: '分享才把内容送进新的兴趣圈层：给一个明确的「转给谁」的对象，或做成可被二创的模板/挑战', contentType: 'short_video', confidence: 'consensus', source: '行业普遍共识（官方只披露信号种类，未公布权重）' },
];


// ── 内置内容技能（域14）：全租户可见（tenantId=null），固定 slug ──
//
// 【为什么它也搬来了这里】此前这份模板只躺在 `prisma/seed.ts` 里，而 seed 开头 deleteMany 全表、
// 生产永远不能跑 —— 结果是**内置技能的模板一旦改了，生产上的那份永远还是旧的**，
// 且没有任何地方会报错（技能照样能跑，只是跑的是老提示词）。搬进唯一真相源后，
// `scripts/sync-system-data.ts` 能按 slug 增量同步到生产，与词库/规则走同一条路。
//
// 模板是数据不是代码：占位符 {{content}}/{{title}}/{{persona}}/{{context}}/{{brief}}
// 只做字符串替换（lib/skills/render.ts），绝不 eval。
//
// ⚠️ 同步只碰 `tenantId = null AND isBuiltin = true` 的行 —— 租户自定义技能一行都不动。

export type SystemSkill = {
  slug: string;
  name: string;
  description: string;
  emoji: string;
  platform: string;
  category: string;
  outputKind: string;
  promptTemplate: string;
};

export const BUILTIN_SKILLS: SystemSkill[] = [
  {
    slug: 'wechat-format',
    name: '微信公众号一键排版',
    description: '把正文排成可直接粘贴进公众号编辑器的成品：导语 + 分节小标题、重点结论卡、引用块、清单，手机上读着舒服',
    emoji: '📰',
    platform: 'wechat',
    category: 'format',
    outputKind: 'html',
    promptTemplate: [
      '你要把一篇文章加工成可以直接粘贴进微信公众号编辑器的排版成品，读者在手机上滑动阅读。',
      '【素材】标题：{{title}}',
      '{{persona}}',
      '{{context}}',
      '{{brief}}',
      '正文：',
      '{{content}}',
      '【结构】',
      '- 开头写一句“导语”：用一两句话点出这篇解决什么问题、为什么值得读下去，独立成段、略加重；',
      '- 正文按逻辑切成 3~6 节，每节一个短小标题（12 字内），小标题加粗并配主题色 #07c160，可在标题前加序号或贴合语义的 emoji；',
      '- 每节只讲一件事；较长的并列信息改成有序或无序列表，一行一点，别堆成大段；',
      '- 出现关键数据或核心结论时做一个“重点卡”：用带浅底色和左边框的小块承载，一屏最多一处；',
      '- 金句 / 他人观点 / 案例放进带左边框的引用块，注明来源；',
      '- 结尾用一条居中分隔线收束，再加一句简短、不谄媚的关注引导。',
      '【排版细则】',
      '- 只用带内联 style 的 HTML 标签（section/p/strong/blockquote/ul/ol/li/hr 等），不写 class 和 id——公众号编辑器会把它们剥掉；',
      '- 面向手机：正文 15px 左右、行高 1.75、段间距 16px 以上，每段不超过 4 行；',
      '- 突出要克制：加色 / 加粗合计一屏不超过两处，颜色只用主题色系，别花；',
      '- 语感照上面的原文样本与口头禅来：句子长短要有起伏，别句句工整对仗；不要出现「值得注意的是 / 总而言之 / 让我们一起 / 在这个…的时代 / 希望对你有帮助」这类大模型套话；',
      '【输出约束】只输出 HTML 片段本身：不含 <html>/<head>/<body>，不加 markdown 代码围栏，不做任何解释。',
    ].join('\n'),
  },
  {
    slug: 'xhs-format',
    name: '小红书图文排版',
    description: '把正文改成小红书笔记：抓眼首句、每段配 emoji、结尾互动问题 + 话题标签 + 3 个备选标题',
    emoji: '📕',
    platform: 'xiaohongshu',
    category: 'format',
    outputKind: 'text',
    promptTemplate: [
      '把下面的素材改写成一篇小红书笔记。',
      '【素材】标题：{{title}}',
      '{{persona}}',
      '{{context}}',
      '{{brief}}',
      '正文：',
      '{{content}}',
      '【改写要求】',
      '- 第一句必须抓眼：用悬念、反差或直接甩结果，让人愿意点开；',
      '- 全文口语化，句子要短，一两句就换行，读起来不喘；',
      '- 每个自然段配 1 个贴合语义的 emoji（句首或句尾），不要堆砌；',
      '- 按「痛点 → 我的做法 → 效果/避坑点」组织内容，突出真实体验感；',
      '- 结尾抛一个互动问题，引导评论区聊起来；',
      '- 互动问题后另起一行，给 5-8 个 #话题标签，标签之间用空格分隔；',
      '- 最后以「备选标题：」开头另起三行，给 3 个各不超过 20 个字的备选标题。',
      '- 语感照上面的原文样本与口头禅来：句子长短要有起伏，别句句工整对仗；不要出现「值得注意的是 / 总而言之 / 让我们一起 / 在这个…的时代 / 希望对你有帮助」这类大模型套话；',
      '【输出约束】只输出笔记成品本身，不解释、不加其他说明。',
    ].join('\n'),
  },
  {
    // AI 生图封面。category=visual：不进自动预装，用户在技能中心按需安装（见 lib/skills/index.ts）。
    // outputKind=image：运行走 llmImage 而非文本，promptTemplate 在这里当“抽封面要素”的指令
    // （渲染后交给 deriveCoverMeta，见 lib/cover/prompt.ts）。
    slug: 'xhs-cover',
    name: '小红书封面（AI 生图）',
    description: '读你的正文自动出一张小红书竖版封面：可选风格、可上传人像/产品照「主体保真」，出图即可下载',
    emoji: '🎨',
    platform: 'xiaohongshu',
    category: 'visual',
    outputKind: 'image',
    promptTemplate: [
      '从下面这篇要发到小红书的内容里，提炼一张封面图要用的文案要素。',
      '标题：{{title}}',
      '{{context}}',
      '{{brief}}',
      '正文：',
      '{{content}}',
      '要求：主标题要抓眼、口语、有信息量或悬念；副标题作补充或点缀、可留空；再给一个配色倾向（可留空）。',
      '标题风格可参考上面账号的口头禅与原句样本，让它更像这个账号自己会写的。',
    ].join('\n'),
  },
  {
    slug: 'douyin-script',
    name: '抖音口播稿',
    description: '把正文改成 60 秒口播稿：前 3 秒钩子、一句一行、带 [停顿]/[重音] 标注，照着念就能拍',
    emoji: '🎬',
    platform: 'douyin',
    category: 'generate',
    outputKind: 'text',
    promptTemplate: [
      '把下面的素材改写成一条约 60 秒的抖音口播稿。',
      '【素材】主题：{{title}}',
      '{{persona}}',
      '{{context}}',
      '{{brief}}',
      '原始内容：',
      '{{content}}',
      '【改写要求】',
      '- 前 3 秒必须是强钩子：一句话说出最反常识或最有用的点，不绕弯；',
      '- 每句话不超过 15 个字，一句一行，方便照着念和上字幕；',
      '- 全程口语，像跟朋友说话，不用书面词；',
      '- 需要停顿的位置标 [停顿]，需要加重语气的词前标 [重音]；',
      '- 中段保持信息密度，每 3-4 句给一个小结论或转折，防止观众划走；',
      '- 结尾一句话引导关注，说清楚关注了能得到什么。',
      '- 语感照上面的原文样本与口头禅来：句子长短要有起伏，别句句工整对仗；不要出现「值得注意的是 / 总而言之 / 让我们一起 / 在这个…的时代 / 希望对你有帮助」这类大模型套话；',
      '【输出约束】只输出口播稿正文（含 [停顿]/[重音] 标注），不要解释，不要写分镜画面。',
    ].join('\n'),
  },
  {
    slug: 'shipinhao-script',
    name: '视频号脚本',
    description: '把正文改成中视频脚本：开场 hook、逐段「画面 / 台词」两行式分镜、每段时长估算、结尾转化引导',
    emoji: '🎥',
    platform: 'shipinhao',
    category: 'generate',
    outputKind: 'text',
    promptTemplate: [
      '把下面的素材改写成一条微信视频号中视频脚本（全片 2-5 分钟）。',
      '【素材】主题：{{title}}',
      '{{persona}}',
      '{{context}}',
      '{{brief}}',
      '原始内容：',
      '{{content}}',
      '【脚本要求】',
      '- 开场 10 秒内给出 hook：直接说观众看完能得到什么；',
      '- 正文按分镜分段，每段固定两行：「画面：」写镜头与画面建议，「台词：」写口播内容；',
      '- 每段末尾用括号标注预估时长（如：约 20 秒），全片加总控制在 2-5 分钟；',
      '- 台词口语化、有人味，贴合上面的人设语气；',
      '- 倒数第二段收束内容：用一句话总结核心观点；',
      '- 最后一段是转化引导：引导关注或转发给需要的朋友，并给一个具体理由。',
      '- 语感照上面的原文样本与口头禅来：句子长短要有起伏，别句句工整对仗；不要出现「值得注意的是 / 总而言之 / 让我们一起 / 在这个…的时代 / 希望对你有帮助」这类大模型套话；',
      '【输出约束】只输出脚本本身，按分镜分段，不要额外解释。',
    ].join('\n'),
  },
  {
    slug: 'zhihu-format',
    name: '知乎长文排版',
    description: '把正文整理成知乎风格长文：先给结论、分层小标题、关键句加粗、引用佐证、文末要点总结',
    emoji: '📘',
    platform: 'zhihu',
    category: 'format',
    outputKind: 'markdown',
    promptTemplate: [
      '把下面的素材整理成一篇知乎风格的长文，用 markdown 排版。',
      '【素材】标题：{{title}}',
      '{{persona}}',
      '{{context}}',
      '{{brief}}',
      '正文：',
      '{{content}}',
      '【排版要求】',
      '- 开头第一段先给结论：直接回答核心问题，不做铺垫；',
      '- 用 ## 与 ### 分层组织小标题，层级清晰，每节只讲一件事；',
      '- 每节的关键句用 **加粗** 标出，一节最多一两处；',
      '- 数据、案例或引用他人观点时放进 > 引用块，并注明来源或统计口径；',
      '- 语气理性克制，观点给依据，避免情绪化和绝对化表述；',
      '- 文末用「## 要点总结」收尾，用有序列表把全文核心要点列成 3-6 条。',
      '- 语感照上面的原文样本与口头禅来：句子长短要有起伏，别句句工整对仗；不要出现「值得注意的是 / 总而言之 / 让我们一起 / 在这个…的时代 / 希望对你有帮助」这类大模型套话；',
      '【输出约束】只输出 markdown 正文，不用代码围栏包裹，不做解释。',
    ].join('\n'),
  },
];
