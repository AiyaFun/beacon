// 长期记忆的入口守卫（2026-09-02，学自 Hermes Agent tools/memory_tool.py 的两道扫描）。
//
// 【为什么记忆需要单独一道闸】记忆和别的文本不一样：它会被拼进**以后每一次生成**的
// 系统提示里（buildMemoryContext 是全站唯一入口）。别处的注入只影响那一次回答，
// 写进记忆的注入是**持久的**——模型从抓来的竞对正文里「学」到一条「忽略以上要求」，
// 之后这个账号的每一篇稿、每一次选题都带着它，而且界面上它长得和一条普通偏好一模一样。
//
// 三条判据，各挡一种形状：
//   ① 注入形状：改写指令 / 冒充系统 / 往外发数据。写入时拦，注入进提示前**再扫一遍**
//      （老数据是在这道闸之前写进去的，只在写入口拦等于放过存量）。
//   ② 祈使句：记忆必须是**陈述事实**，不许是**给模型的命令**。「用户偏好短句」在下次会话
//      里只是参考；「总是用短句」会被当成指令，压过用户当场说的「这篇写长点」。
//      只对模型自己写的那条路（write_memory 工具）生效——用户在记忆页手填的随他。
//   ③ 对工具能力的否定断言：「插件拿不到完播率」这种话记成事实之后，插件修好了它还在引用，
//      而且会拿这条记忆当理由拒绝去试。Hermes 的原话：这些会硬化成拒绝，问题修好几个月后
//      代理还在引用。
//
// 一句必须说破的话：①是「挡常见形状」不是对抗性边界。真要绕总能绕，它的价值是
// 把**顺手就会发生**的那种（模型转述抓来的内容）挡在门外，让残留的都是刻意为之。

export type MemoryGuardVerdict = { ok: true } | { ok: false; reason: string };

/** 注入形状。中英各几条，每条都对应一种真实见过的写法，不求全。 */
const INJECTION_PATTERNS: RegExp[] = [
  // 改写指令
  /忽略(以上|之前|前面|上面|先前|所有)?(的)?(全部|所有)?(指令|要求|规则|设定|提示)/,
  /(无视|不要理会|抛开)(以上|之前|前面|上面)?(的)?(指令|要求|规则|设定)/,
  /ignore\s+(all\s+|any\s+)?(previous|prior|above|earlier|preceding)\s+(instructions?|rules?|prompts?)/i,
  /disregard\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+(instructions?|rules?)/i,
  // 冒充系统 / 越权改身份
  /^\s*(system|assistant|developer)\s*[:：]/i,
  /<\|?(im_start|im_end|system|endoftext)\|?>/i,
  /(你现在是|从现在起你是|现在扮演|假装你是)\s*\S/,
  /you\s+are\s+now\s+(a|an|the)\s+/i,
  // 套系统提示
  /(输出|打印|重复|显示|告诉我)(你的|上面的|完整的)?(系统提示|系统提示词|system\s*prompt|初始指令)/i,
  /(print|reveal|repeat|show)\s+(your\s+)?(system\s+prompt|initial\s+instructions)/i,
  // 往外发数据：记忆里出现「把…发到 某个地址」就是外泄形状，正常的记忆没有理由带 URL 指令
  /(发送|发到|上传|提交|post|send|upload)\s*(到|至|给|to)?\s*https?:\/\//i,
  /curl\s+(-[A-Za-z]+\s+)*https?:\/\//i,
];

/** 记忆里带着这种形状，写入与注入都拒绝。 */
export function memoryThreat(content: string): string | null {
  const s = content.normalize('NFKC');
  for (const re of INJECTION_PATTERNS) {
    if (re.test(s)) return `这段话长得像给模型的指令而不是关于账号的事实（命中「${re.source.slice(0, 40)}」）`;
  }
  return null;
}

/**
 * 祈使句开头。只看开头：陈述句里中段出现「必须」很正常（「粉丝必须先关注才能看」）。
 * 中文没有语法上的祈使标记，用「命令模型做事」的常见起手词近似。
 */
const IMPERATIVE_HEAD = /^\s*(?:总是|永远|一律|必须|务必|请|不要|别|绝不|从不|禁止|记得|应该|要|不许|不准|切勿)|^\s*(?:always|never|do not|don't|must|please|make sure|remember to)(?=\s|$)/i;

/** 是不是写成了给模型的命令。是的话返回改写建议。 */
export function imperativeMemory(content: string): string | null {
  if (!IMPERATIVE_HEAD.test(content)) return null;
  return '记忆要写成关于账号的**陈述句**，不要写成给你自己的命令：'
    + '「总是用短句」下次会被当成指令压过用户当场的要求，改成「用户偏好短句」就只是参考。';
}

/**
 * 对工具/系统能力的否定断言。要同时命中「做不到」和「某个能力主体」才算，
 * 免得误伤「粉丝不能接受硬广」这种关于受众的陈述。
 */
const CAPABILITY_NOUN = /(插件|工具|采集|服务端|接口|烽火台|系统|模型|后台|浏览器|回填|抓取|爬取|api)/i;
const NEGATION = /(拿不到|抓不到|采不到|取不到|读不到|不支持|无法|没法|不能|做不到|失败|不可用|坏了|用不了|cannot|can't|unable|not\s+supported|doesn't\s+work|fails?)/i;

export function toolNegativeAssertion(content: string): string | null {
  if (!(CAPABILITY_NOUN.test(content) && NEGATION.test(content))) return null;
  return '这是对工具或系统**能力**的否定判断，不记进长期记忆：'
    + '它修好之后你还会拿这条当理由拒绝再试。这类情况写在本次结果里说明即可。';
}

/**
 * 模型自己写记忆那条路的完整判定（写入前调）。
 * 顺序：注入 → 祈使 → 否定断言。第一条命中就返回，错误信息是给模型看的改写指引。
 */
export function guardModelMemory(content: string): MemoryGuardVerdict {
  const t = memoryThreat(content);
  if (t) return { ok: false, reason: t };
  const i = imperativeMemory(content);
  if (i) return { ok: false, reason: i };
  const n = toolNegativeAssertion(content);
  if (n) return { ok: false, reason: n };
  return { ok: true };
}
