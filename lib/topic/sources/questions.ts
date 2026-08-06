import { textShingles } from '../scoring';

// 读者提问挖掘（评论区金矿）。
//
// ─────────────────── 为什么是「粘贴自有评论」而不是「采集竞对评论区」 ───────────────────
// 原方案里这一项叫「评论区金矿」，设想是让插件把竞对作品下的评论抓回来。那条路有两个问题：
//   1) 评论是**第三方写的 UGC**，作者是一个个真实的人。批量抓取并入库涉及个人信息与内容权属，
//      本项目「不碰灰色」的红线摆在那儿，必须先过合规评审——而那不是写代码能解决的。
//   2) 更要命的是它其实没那么有用：别人作品下的问题，未必是**你的**读者在问的。
//
// 改成现在这样：用户把**自己作品**的评论复制粘贴进来，系统只做一件事——**挑出疑问句**。
//   - 不存作者、不存昵称、不存无关正文，只留问题本身；
//   - 数据来自用户自己的评论区，他本来就每天在看；
//   - 信号质量反而更高：这是**你的**读者真正在问的东西，每条都被点赞投过票。
// 于是它既不需要那场合规评审，价值还更大。这是少数「退一步反而更对」的取舍。
//
// ─────────────────── 提问识别 ───────────────────
// 中文评论里问句的形态很杂：有问号的、没问号的、「求一个 XX 教程」这种祈使式请求。
// 判据故意写得保守——**宁可漏掉一些问题，也不要把陈述句当成问题**：
// 挖出来的每一条都会变成候选选题，混进陈述句等于往推荐池里灌噪声。

// 一条评论最长取这么多字：超长的多半是长篇分享而不是提问
const MAX_LEN = 60;
// 太短的（「为什么」三个字）没有信息量，成不了选题
const MIN_LEN = 5;
// 与全站一致的「同题」判据：共享 ≥2 个中文 2-gram
const MIN_OVERLAP = 2;

// 疑问标记分三类，因为确信度不同：
//   strong：出现即判定是问句
//   tail  ：句末语气助词。中文评论**经常不打问号**（「这个工具收费吗」是最常见的提问形态之一），
//           但「吗/呢」出现在句末时几乎必然是疑问，误判风险极低。这一类是实测补上的——
//           最初只有 strong + weak，把「收费吗」这类最典型的读者提问整类漏掉了。
//   weak  ：必须配问号才算（「怎么」在「不管怎么说」里就不是提问）
const STRONG = [
  '为什么', '为啥', '怎么办', '怎么弄', '怎么做', '如何', '是不是', '能不能', '可不可以',
  '有没有', '要不要', '值不值', '值得吗', '哪个好', '哪家好', '求推荐', '求教程', '求分享',
  '请问', '想问', '想知道', '有推荐吗', '多久', '多少钱', '贵不贵', '难不难', '靠谱吗',
];
const TAIL = ['吗', '呢'];
const WEAK = ['怎么', '哪个', '哪些', '什么时候', '在哪'];

// 评论里常见但对「问的是什么」零信息量的前缀噪声，剥掉能让同题归并更准。
// ⚠️ 昵称用 [^\s:：]+ 而不是 \S+：中文评论「回复 张三：正文」里冒号前后都没有空格，
// 贪婪的 \S+ 会把整句正文一起吃掉，剥完只剩空字符串（本文件踩过这个坑）。
const NOISE_PREFIX = /^[\s\d.、)）:：]*(?:回复\s*[^\s:：]+\s*[:：]?\s*|@[^\s]+\s*)?/;

function normalize(line: string): string {
  return line.replace(NOISE_PREFIX, '').trim();
}

// 是否是提问。保守判定，见文件头。
export function isQuestion(line: string): boolean {
  const t = normalize(line);
  if (t.length < MIN_LEN || t.length > MAX_LEN) return false;
  if (STRONG.some((w) => t.includes(w))) return true;
  // 句末语气助词：剥掉尾部标点后，最后一个字是「吗/呢」即判定为提问（见 TAIL 注释）
  const tail = t.replace(/[\s?？!！。,，~～、.]+$/u, '').slice(-1);
  if (TAIL.includes(tail)) return true;
  // 弱标记必须配问号——「不管怎么说」这类不该被当成提问
  if (!/[?？]/.test(t)) return false;
  return WEAK.some((w) => t.includes(w));
}

export type ExtractedQuestion = {
  text: string; // 代表句（该组里最短的那条——最短通常最接近问题本身，少夹带情绪与铺垫）
  count: number; // 同组问题数：被问的次数就是需求强度
  variants: string[]; // 同组其它问法（最多留 3 条，给用户看「大家都是怎么问的」）
};

// 从一整段粘贴的评论文本里挖出问题，按被问次数降序。
// 同义归并用的是全站同一把尺（共享 ≥2 个中文 2-gram），不引入新口径。
export function extractQuestions(raw: string, limit = 20): ExtractedQuestion[] {
  const lines = raw
    .split(/[\n\r]+/)
    .map(normalize)
    .filter(Boolean);

  const groups: { rep: string; grams: Set<string>; members: string[] }[] = [];
  for (const line of lines) {
    if (!isQuestion(line)) continue;
    const grams = textShingles(line);
    const hit = groups.find((g) => {
      let overlap = 0;
      for (const x of grams) {
        if (g.grams.has(x)) {
          overlap++;
          if (overlap >= MIN_OVERLAP) return true;
        }
      }
      return false;
    });
    if (hit) {
      // 完全一样的重复评论也算一次「被问到」——刷屏当然要去重，但同一个问题被两个人问就是两票。
      hit.members.push(line);
      // 代表句取最短：最短的那条通常最接近问题本身，长的多半夹带了情绪和铺垫
      if (line.length < hit.rep.length) hit.rep = line;
    } else {
      groups.push({ rep: line, grams, members: [line] });
    }
  }

  return groups
    .map((g) => ({
      text: g.rep,
      count: g.members.length,
      variants: [...new Set(g.members.filter((m) => m !== g.rep))].slice(0, 3),
    }))
    .sort((a, b) => b.count - a.count || a.text.length - b.text.length)
    .slice(0, limit);
}

// 问题 → 灵感条目的标题与备注。
// 复用 InspirationItem（source='comment'）而不是另立一张表：两者的生命周期完全一样
// ——都是「还没变成选题的原料」，都需要 待用/已转选题/已归档 三态，都要进同一条推荐管线。
// 为一个字段差异新建一张表，只会多出一套要各自维护的取数、清理与上限逻辑。
export function questionToInspiration(q: ExtractedQuestion): { title: string; note: string } {
  const asked = q.count > 1 ? `被问到 ${q.count} 次` : '读者提问';
  const variants = q.variants.length ? `；其它问法：${q.variants.join(' / ')}` : '';
  return {
    title: q.text,
    note: `${asked}${variants}`,
  };
}
