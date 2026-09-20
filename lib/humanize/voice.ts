import type { PersonaCard } from '../persona';

// 账号的「说话方式」规格（2026-09-17，用户：「就地起稿，包括视角，语气，口吻等等
// 都要按照账号的记忆和方法出现」）。
//
// ─────────────── 为什么不是把人设卡再喂一遍 ───────────────
// 人设卡给模型的是**标签**：「语气风格：轻松幽默」。本项目在第八轮就写下过结论——
// 标签是有损压缩，模型只能回给你「它理解的平均幽默」，而那正是 AI 味的定义
// （见 lib/account-context.ts 里 exemplar 排在 fingerprint 之前的那段注释）。
// 原句样本是无损的，但它只解决「像不像」，不解决「照没照做」：没有任何一处检查
// 写出来的稿子到底是不是这个人的人称、这个人的称呼、这个人的标点习惯。
//
// 所以这里做两件确定性的事：
//   ① analyzeVoice：从他自己发过的正文里**量**出可执行的几条——用「我」还是「我们」、
//      管读者叫什么、一句话多长、爱不爱用感叹号和 emoji；
//   ② checkVoiceFit：拿这几条去**验**新稿子，对不上的交给成稿收口那一次调用改回来。
//
// ─────────────── 两条纪律 ───────────────
// ① **量不出来就不要装作量出来了**。样本不足时 source='persona'/'default'，
//    checkVoiceFit 一条都不报——拿默认值去纠正用户真实的写法，是帮倒忙。
// ② 口头禅只「可以用」，不「必须用」。逼模型每段塞一句口头禅，出来的是模仿秀不是本人。

export type VoicePerson = 'first' | 'first_plural' | 'none';

export type VoiceSpec = {
  /** 用「我」/「我们」/不出现人称 */
  person: VoicePerson;
  /** 管读者叫什么（你 / 你们 / 大家 / 姐妹们…）；量不出来为 null */
  readerAddress: string | null;
  /** 平均句长（字），量不出来为 null */
  sentenceLen: number | null;
  /** 感叹号习惯 */
  exclaim: 'many' | 'few' | null;
  /** 用不用 emoji */
  emoji: 'yes' | 'no' | null;
  /** 口头禅（语气资产，不是内容） */
  catchphrases: string[];
  /** 人设卡里写的语气 */
  tone: string;
  /** 这几条是从哪来的：真实样本 / 只有人设 / 什么都没有 */
  source: 'samples' | 'persona' | 'default';
  /** 学了几篇 */
  sampleCount: number;
  /** 样本总字数 */
  sampleChars: number;
};

const READER_WORDS = ['姐妹们', '宝子们', '家人们', '老铁们', '老铁', '朋友们', '各位', '大家', '你们', '你'];

const EMOJI_RE = /\p{Extended_Pictographic}/u;

/** 样本少于这个字数就别下结论：两句话量不出一个人的说话方式 */
export const MIN_VOICE_CHARS = 200;

function countOf(text: string, word: string): number {
  let n = 0;
  let from = 0;
  for (;;) {
    const i = text.indexOf(word, from);
    if (i < 0) break;
    n += 1;
    from = i + word.length;
  }
  return n;
}

/**
 * 从他自己写过的正文里量出说话方式。
 * samples 只能是**他自己的**文字（Material(type=sample) / PublishRecord / 人工终稿），
 * 剪藏的他人正文一条都不许进来（tests/clip/never-in-exemplar.test.ts 钉着这条）。
 */
export function analyzeVoice(samples: string[], persona?: PersonaCard | null, catchphrases: string[] = []): VoiceSpec {
  const texts = samples.map((s) => (s ?? '').trim()).filter(Boolean);
  const joined = texts.join('\n');
  const chars = joined.length;
  const tone = persona?.tone?.trim() ?? '';
  const base: VoiceSpec = {
    person: 'first',
    readerAddress: null,
    sentenceLen: null,
    exclaim: null,
    emoji: null,
    catchphrases: catchphrases.filter(Boolean).slice(0, 6),
    tone,
    source: tone ? 'persona' : 'default',
    sampleCount: texts.length,
    sampleChars: chars,
  };
  if (chars < MIN_VOICE_CHARS) return base;

  // ── 人称 ──「我们」要先数，再从「我」里扣掉，否则每个「我们」都会被算成一次「我」
  const we = countOf(joined, '我们');
  const me = countOf(joined, '我') - we;
  let person: VoicePerson = 'none';
  if (me >= 2 && me >= we * 2) person = 'first';
  else if (we >= 2 && we > me) person = 'first_plural';

  // ── 管读者叫什么 ──长词优先（「你们」先于「你」，「姐妹们」先于「们」）
  let readerAddress: string | null = null;
  let best = 1; // 至少出现两次才算习惯
  let rest = joined;
  for (const w of READER_WORDS) {
    const n = countOf(rest, w);
    if (n > best) { best = n; readerAddress = w; }
    if (n > 0) rest = rest.split(w).join(''); // 已经算过的不再被短词重复计数
  }

  const sentences = joined.split(/[。！？!?…；;\n]+/).map((x) => x.trim()).filter(Boolean);
  const sentenceLen = sentences.length >= 4
    ? Math.round(sentences.reduce((a, b) => a + b.length, 0) / sentences.length)
    : null;

  const bangs = (joined.match(/[！!]/g) ?? []).length;
  const exclaim: VoiceSpec['exclaim'] = bangs / chars >= 0.02 ? 'many' : bangs / chars <= 0.005 ? 'few' : null;
  const emoji: VoiceSpec['emoji'] = EMOJI_RE.test(joined) ? 'yes' : 'no';

  return { ...base, person, readerAddress, sentenceLen, exclaim, emoji, source: 'samples' };
}

/** 给模型的「怎么说」指令块。量出来的用量出来的，量不出来就如实说是按人设走。 */
export function voicePromptBlock(spec: VoiceSpec): string {
  const lines: string[] = [];
  if (spec.source === 'samples') {
    lines.push(`【这个账号的说话方式（从他自己写过的 ${spec.sampleCount} 篇里量出来的，照着说）】`);
    lines.push(
      spec.person === 'first'
        ? '- 视角：用「我」开口讲，不要「我们」「笔者」「小编」'
        : spec.person === 'first_plural'
          ? '- 视角：他习惯用「我们」，跟着用'
          : '- 视角：他基本不出现人称，就事论事地讲，别硬加「我」',
    );
    if (spec.readerAddress) lines.push(`- 管读者叫「${spec.readerAddress}」，别换成别的称呼`);
    if (spec.sentenceLen) lines.push(`- 句子平均 ${spec.sentenceLen} 字上下，但要长短交替，不要句句都是这个长度`);
    if (spec.exclaim === 'few') lines.push('- 他很少用感叹号，别整篇打鸡血');
    if (spec.exclaim === 'many') lines.push('- 他说话带劲，感叹号用得多，别写得太板正');
    if (spec.emoji === 'no') lines.push('- 他不用 emoji');
  } else {
    lines.push('【这个账号的说话方式】');
    if (spec.tone) lines.push(`- 人设卡里写的语气：${spec.tone}`);
    lines.push('- 他还没有可供学习的历史正文，所以：用「我」开口，管读者叫「你」，说人话，别端着');
  }
  if (spec.catchphrases.length) {
    lines.push(`- 他的口头禅：${spec.catchphrases.slice(0, 5).join('、')}（可以自然用上一两个，不要每段都塞）`);
  }
  lines.push('这是他**怎么说**，不是他说过什么：样本里的经历、数字、案例一个字都不许搬进这篇。');
  return lines.join('\n');
}

export type VoiceViolation = { code: string; severity: 'warn'; finding: string; fix: string };

/**
 * 验新稿子对不对得上这个说话方式。
 * **只在 source='samples' 时才判**——没量出来就没有判据，凭默认值去纠正用户真实的写法是帮倒忙。
 */
export function checkVoiceFit(text: string, spec: VoiceSpec | null | undefined): VoiceViolation[] {
  const body = (text ?? '').trim();
  if (!body || !spec || spec.source !== 'samples') return [];
  const out: VoiceViolation[] = [];

  const we = countOf(body, '我们');
  const me = countOf(body, '我') - we;
  if (spec.person === 'first' && we >= 2 && we > me) {
    out.push({ code: 'voice_person', severity: 'warn', finding: `这个账号一直用「我」，这篇却用了 ${we} 次「我们」`, fix: '把「我们」改回「我」，或者去掉人称。' });
  }
  if (spec.person === 'first_plural' && me >= 2 && me > we) {
    out.push({ code: 'voice_person', severity: 'warn', finding: `这个账号习惯用「我们」，这篇却通篇「我」`, fix: '按他的习惯改成「我们」。' });
  }

  if (spec.readerAddress) {
    const used = countOf(body, spec.readerAddress);
    const others = READER_WORDS.filter((w) => w !== spec.readerAddress && !spec.readerAddress!.includes(w) && !w.includes(spec.readerAddress!));
    const otherHit = others.map((w) => ({ w, n: countOf(body, w) })).filter((x) => x.n >= 2).sort((a, b) => b.n - a.n)[0];
    if (used === 0 && otherHit) {
      out.push({ code: 'voice_reader', severity: 'warn', finding: `他管读者叫「${spec.readerAddress}」，这篇叫的是「${otherHit.w}」`, fix: `把「${otherHit.w}」改成「${spec.readerAddress}」。` });
    }
  }

  if (spec.emoji === 'no' && EMOJI_RE.test(body)) {
    out.push({ code: 'voice_emoji', severity: 'warn', finding: '他自己写东西从不用 emoji，这篇用了', fix: '把 emoji 全部去掉。' });
  }

  return out;
}

/** 修复那一次调用要用的问题清单（没有问题返回空串） */
export function voiceProblemBlock(violations: VoiceViolation[]): string {
  if (violations.length === 0) return '';
  return ['【跟这个账号平时的说法对不上的地方】', ...violations.map((v) => `- ${v.finding} → ${v.fix}`)].join('\n');
}
