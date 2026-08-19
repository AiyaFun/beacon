import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  scanAiFlavor,
  aiFlavorBanBlock,
  AI_FLAVOR_LEXICON,
  JARGON_MAX_WORD_LEN,
} from '@/lib/humanize/lexicon';

describe('AI 味词库', () => {
  it('命中带位置，可用于编辑器高亮', () => {
    const text = '值得注意的是，这个方法很好用。';
    const hits = scanAiFlavor(text);
    expect(hits.length).toBe(1);
    expect(hits[0].word).toBe('值得注意的是');
    expect(text.slice(hits[0].start, hits[0].end)).toBe('值得注意的是');
  });

  it('长词优先：重叠区间只保留更长的那条，同一处不报两遍', () => {
    // 「随着社会的发展」含「随着」…若不去重会一处报两条，用户以为有两个问题
    const hits = scanAiFlavor('随着社会的发展，大家越来越忙。');
    expect(hits.map((h) => h.word)).toEqual(['随着社会的发展']);
  });

  it('多处命中按出现顺序返回', () => {
    const hits = scanAiFlavor('众所周知，A 很好。综上所述，B 更好。');
    expect(hits.map((h) => h.word)).toEqual(['众所周知', '综上所述']);
  });

  it('干净文本零命中', () => {
    expect(scanAiFlavor('昨天我把三个老客户砍了。就这么简单。')).toEqual([]);
  });

  it('空输入不炸', () => {
    expect(scanAiFlavor('')).toEqual([]);
  });

  it('禁用词表只收权重 ≥2 的词——权重 1 的词人也常用，写进禁令会把稿子改别扭', () => {
    const block = aiFlavorBanBlock();
    const weakWords = AI_FLAVOR_LEXICON.filter((e) => e.weight === 1).map((e) => e.word);
    // 「因此」是权重 1，不该出现在禁令里
    expect(weakWords).toContain('因此');
    const banned = block.split('\n')[1].split('、');
    expect(banned).not.toContain('因此');
    expect(banned).toContain('值得注意的是');
  });

  it('禁用词表有上限，不会把 prompt 撑爆', () => {
    const banned = aiFlavorBanBlock(10).split('\n')[1].split('、');
    expect(banned.length).toBe(10);
  });

  it('词库里没有平台真实用语（不许把真人天天说的话当 AI 腔）', () => {
    const words = AI_FLAVOR_LEXICON.map((e) => e.word);
    for (const real of ['码住', '建议收藏', '姐妹们', '家人们', '绝了']) {
      expect(words).not.toContain(real);
    }
  });
});

// ── 模糊量词（VAGUE_QUANTIFIER）──────────────────────────────────────────────
describe('模糊量词：说了等于没说、又没法核验的那一族', () => {
  it('命中并给出「给个数字」类建议', () => {
    const hits = scanAiFlavor('这次改版之后转化率有所提升，用户反馈效果很好。');
    expect(hits.map((h) => h.word)).toEqual(['有所提升', '效果很好']);
    for (const h of hits) {
      expect(h.category).toBe('jargon');
      expect(h.suggestion).toMatch(/数字|好在哪/);
    }
  });

  it('几条代表词都在库里，位置对得上', () => {
    const text = '不少用户反映加载慢，优化后一定程度上缓解了，投诉量大幅下降。';
    const hits = scanAiFlavor(text);
    expect(hits.map((h) => h.word)).toEqual(['不少用户', '一定程度上', '大幅下降']);
    for (const h of hits) expect(text.slice(h.start, h.end)).toBe(h.word);
  });

  it('这一族一律不给 weight 3——真人写周报也这么说，只是没给数字', () => {
    // 收词标准是「人很少这么说、但模型极爱这么写」；拿不准就往低了给。
    const vague = ['有所提升', '有所改善', '明显提升', '效果很好', '不少用户', '数不胜数', '某种程度上'];
    for (const w of vague) {
      const e = AI_FLAVOR_LEXICON.find((x) => x.word === w);
      expect(e, `${w} 不在词库里`).toBeTruthy();
      expect(e!.weight, `${w} 给到了 weight 3`).toBeLessThan(3);
    }
  });

  it('🔒 排在展平顺序最末：给 LLM 的禁用词表一个字都不该变', () => {
    // 禁用词表是「按数组顺序截前 60 条」的，而 weight≥2 的词一共 89 条。
    // 把这十几条插进 JARGON 后面，会把 CLOSING/OFFICIALESE 那批 weight 3 的词整体挤出去——
    // 那批是「几乎只有模型这么写」，比这批更该禁。
    const banned = aiFlavorBanBlock().split('\n')[1].split('、');
    for (const w of ['希望这篇文章对你有帮助', '未来可期', '值得每个人深思', '扎实推进', '保驾护航']) {
      expect(banned, `${w} 被挤出禁用词表了——检查 AI_FLAVOR_LEXICON 的展平顺序`).toContain(w);
    }
    // 模糊量词自己则落在 60 名之外，内联高亮和人味分照常吃到，只是不进 prompt
    for (const w of ['有所提升', '不少用户', '一定程度上']) {
      expect(banned).not.toContain(w);
    }
  });
});

// ── 词级区间守卫 ────────────────────────────────────────────────────────────
//
// 编辑器的内联标注是「按起点贪心、互不重叠」合并的：一条能横跨整句的词条先占位，
// 同句里别的命中就再也画不出来——**包括 tier=block 的合规禁用词**。
// 那等于把内联合规标注这个功能本身推翻了：用户会以为这句没有合规问题。
describe('🔒 词条必须保持词级，不许长成句级', () => {
  it(`空心黑话/模糊量词不超过 JARGON_MAX_WORD_LEN（${JARGON_MAX_WORD_LEN}）个字`, () => {
    // 这一族出现在句子中段，跟合规词同区间的概率最高，卡得最严。
    for (const e of AI_FLAVOR_LEXICON) {
      if (e.category !== 'jargon') continue;
      expect(e.word.length, `「${e.word}」超出词级长度，会吃掉同句的合规标注`).toBeLessThanOrEqual(
        JARGON_MAX_WORD_LEN,
      );
    }
  });

  it('整库任何一条都不许长成半段话', () => {
    // 开场/结尾套话本来就是整句模板（目前最长 13 字：「你怎么看？欢迎在评论区留言」），
    // 它们贴着句首句尾出现，跟句中的合规词很少同区间，所以放宽到 14——
    // 只留一个字的余量：再长就不是模板而是半段话了，该拆成两条。
    const SENTENCE_TEMPLATE_MAX_LEN = 14;
    for (const e of AI_FLAVOR_LEXICON) {
      expect(e.word.length, `「${e.word}」已经是半段话了，拆开写`).toBeLessThanOrEqual(
        SENTENCE_TEMPLATE_MAX_LEN,
      );
    }
  });

  it('长度上限为什么是这个数：把编辑器的合并规则复刻一遍看后果', () => {
    // 复刻 app/(app)/studio/Rewriter.tsx 的 marks 合并（下一条测试盯着它没被改掉）
    type RawMark = { start: number; end: number; kind: 'block' | 'warn' | 'ai'; rank: number };
    const merge = (raw: RawMark[]) => {
      raw.sort((a, b) => a.start - b.start || a.rank - b.rank || b.end - a.end);
      const out: RawMark[] = [];
      let cursor = 0;
      for (const m of raw) {
        if (m.start < cursor) continue;
        out.push(m);
        cursor = m.end;
      }
      return out;
    };
    const block: RawMark = { start: 5, end: 8, kind: 'block', rank: 0 };

    // 句级套话（0–20）先占位 → 合规禁用词直接从标注里消失
    expect(merge([{ start: 0, end: 20, kind: 'ai', rank: 2 }, { ...block }]).map((m) => m.kind)).toEqual(['ai']);
    // 词级套话（0–4）→ 两条都画得出来
    expect(merge([{ start: 0, end: 4, kind: 'ai', rank: 2 }, { ...block }]).map((m) => m.kind)).toEqual([
      'ai',
      'block',
    ]);
  });

  it('编辑器那边仍然是「按起点贪心、互不重叠」——复刻才有意义', () => {
    const rewriter = readFileSync(resolve(process.cwd(), 'app/(app)/studio/Rewriter.tsx'), 'utf8');
    expect(rewriter).toContain('if (m.start < cursor) continue;');
    expect(rewriter).toMatch(/raw\.sort\(\(a, b\) => a\.start - b\.start/);
  });
});
