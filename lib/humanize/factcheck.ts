// 改写后的「事实漂移」检查：改完的稿子里冒出了原文没有的数字，多半是模型编的。
//
// 【这不是假想的风险，是真机上抓到的】「一键去 AI 味」会把用户自己写过的原句样本喂给模型
// 学语感。真跑一次就看到：模型把**样本里的**「只留五个客户」「涨了两成」「每周三个下午」
// 写进了一篇原本只讲客户结构的稿子。提示词里已经写了「不要抄样本内容」，但那是软约束——
// 模型在题材相近时照样会串。
//
// 所以再加一道**确定性的**兜底：把改写前后的数字对一遍，多出来的数字如实报给用户。
// 它不判断对错（模型也可能只是把「两成」写成「20%」），只回答一件事：
// **这几个数原文里没有，你自己核一下。** 宁可多问一句，也不能让编造的数字被当成事实发出去。

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

export type FactDrift = {
  /** 改写后新出现、原文里找不到的数字 */
  added: string[];
  /** 给用户看的一句话；无漂移时为空串 */
  warning: string;
};

export function checkFactDrift(before: string, after: string): FactDrift {
  const src = before ?? '';
  const beforeNums = new Set(extractNumbers(src));
  const added = extractNumbers(after).filter((n) => {
    if (beforeNums.has(n)) return false;
    // 「20%」在原文里以「20」出现过就不算新——只是换了个写法。
    // ⚠️ 只对**阿拉伯数字**做这种归一：中文数字这么做会把「三成」当成原文里的「三个通宵」，
    // 于是真正编出来的比例被放过（这条曾经真的漏掉过，单测里留着那一例）。
    if (!/^\d/.test(n)) return true;
    const bare = n.replace(/[%成倍个次年月天周小时分钟]+$/u, '');
    return !(bare && (beforeNums.has(bare) || src.includes(bare)));
  });
  if (added.length === 0) return { added: [], warning: '' };
  return {
    added,
    warning: `改写后出现了原文里没有的数字：${added.slice(0, 6).join('、')}。发之前请核对——模型有时会把参考样本里的数字带进来。`,
  };
}
