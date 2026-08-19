import { describe, it, expect } from 'vitest';
import { buildCoverPrompt, onImageText, cleanCoverText } from '@/lib/cover/prompt';
import { COVER_STYLES, coverStyle, DEFAULT_COVER_STYLE, styleDescription, COVER_FONTS, COVER_DECORS } from '@/lib/cover/styles';
import { COVER_SPECS } from '@/lib/cover/specs';
import { COVER_EXTRA_HARD_MAX } from '@/lib/cover/rules';

// 封面提示词的纯函数守卫：拼装口径 + 会被红线检的“上图文字”口径 + 风格回落 + 比例由规格驱动。
// 这几条是零依赖纯函数，值一个便宜的静态用例把契约钉死。

describe('onImageText（会画到图上、要过红线的文字）', () => {
  it('只含主标题与副标题', () => {
    expect(onImageText({ mainTitle: '主', subTitle: '副' })).toBe('主 副');
    expect(onImageText({ mainTitle: '主' })).toBe('主');
  });
});

describe('cleanCoverText', () => {
  it('去空白、压缩空白、截上限；非字符串 → 空串', () => {
    expect(cleanCoverText('  a   b  ', 10)).toBe('a b');
    expect(cleanCoverText('一二三四五', 3)).toBe('一二三');
    expect(cleanCoverText(123, 10)).toBe('');
  });
});

describe('buildCoverPrompt', () => {
  it('带上主标题、风格描述与默认 3:4', () => {
    const p = buildCoverPrompt({ meta: { mainTitle: '三天瘦五斤', subTitle: '亲测' }, styleKey: 'magazine' });
    expect(p).toContain('三天瘦五斤');
    expect(p).toContain('亲测');
    expect(p).toContain('3:4');
    expect(p).toContain('小红书');
    expect(p).toContain(coverStyle('magazine').layout.slice(0, 8));
  });

  it('比例跟着规格走：传 spec key 后首行写的是该比例，且不再是 3:4', () => {
    const p = buildCoverPrompt({ meta: { mainTitle: 'x' }, spec: 'douyin-9-16' });
    expect(p).toContain('9:16');
    expect(p).toContain('抖音');
    expect(p.split('\n')[0]).not.toContain('3:4');
  });

  it('主体参考图 → 加「主体保真」；背景参考图 → 加「背景取材」并写张数', () => {
    const p = buildCoverPrompt({ meta: { mainTitle: 'x' }, subjectCount: 1, backgroundCount: 2 });
    expect(p).toContain('主体保真');
    expect(p).toContain('背景取材');
    expect(p).toContain('2 张');
  });

  it('旧口径 hasReference → 视为主体保真', () => {
    const p = buildCoverPrompt({ meta: { mainTitle: 'x' }, hasReference: true });
    expect(p).toContain('主体保真');
    expect(p).not.toContain('背景取材');
  });

  it('无参考图 → 两段都不出现', () => {
    const p = buildCoverPrompt({ meta: { mainTitle: 'x' } });
    expect(p).not.toContain('主体保真');
    expect(p).not.toContain('背景取材');
  });

  it('留白版 → 明确不上字、且不写主标题与字体倾向指令', () => {
    const p = buildCoverPrompt({ meta: { mainTitle: 'x' }, textless: true, fontKey: 'bold-hei' });
    expect(p).toContain('不要在图上写任何文字');
    expect(p).not.toContain('【主标题】');
    expect(p).not.toContain('【字体倾向】');
  });

  it('字体倾向 / 装饰 / 备注都进提示词；auto 字体不出现字体段', () => {
    const p = buildCoverPrompt({
      meta: { mainTitle: 'x' },
      fontKey: 'handwrite',
      decors: ['stickers', 'nope'],
      extra: '背景要有咖啡馆',
    });
    expect(p).toContain('【字体倾向】');
    expect(p).toContain(COVER_FONTS.find((f) => f.key === 'handwrite')!.prompt.slice(0, 6));
    expect(p).toContain('【装饰】');
    expect(p).toContain(COVER_DECORS.find((d) => d.key === 'stickers')!.prompt.slice(0, 6));
    expect(p).toContain('【补充要求】背景要有咖啡馆');
    const q = buildCoverPrompt({ meta: { mainTitle: 'x' }, fontKey: 'auto' });
    expect(q).not.toContain('【字体倾向】');
  });

  it('备注截到硬上限', () => {
    const long = '很'.repeat(COVER_EXTRA_HARD_MAX + 50);
    const p = buildCoverPrompt({ meta: { mainTitle: 'x' }, extra: long });
    expect(p).toContain('很'.repeat(COVER_EXTRA_HARD_MAX));
    expect(p).not.toContain('很'.repeat(COVER_EXTRA_HARD_MAX + 1));
  });
});

describe('风格清单', () => {
  it('未知/缺省 key → 默认第一档', () => {
    expect(coverStyle('nope').key).toBe(COVER_STYLES[0].key);
    expect(coverStyle(undefined).key).toBe(DEFAULT_COVER_STYLE);
  });

  it('key 唯一、每档五块描述与推荐关键词齐全（风格是数据，漏一块 UI/提示词就缺一角）', () => {
    const keys = new Set(COVER_STYLES.map((s) => s.key));
    expect(keys.size).toBe(COVER_STYLES.length);
    expect(COVER_STYLES.length).toBeGreaterThanOrEqual(12);
    for (const s of COVER_STYLES) {
      expect(s.hint.length).toBeGreaterThan(4);
      expect(s.layout.length).toBeGreaterThan(8);
      expect(s.text.length).toBeGreaterThan(4);
      expect(s.effect.length).toBeGreaterThan(4);
      expect(s.mood.length).toBeGreaterThan(2);
      expect(s.recommendFor.length).toBeGreaterThan(0);
      const d = styleDescription(s);
      expect(d).toContain('【布局】');
      expect(d).toContain('【文字样式】');
    }
  });
});

describe('规格清单', () => {
  it('每档 size 是 宽x高 且宽高比与 aspect 一致（±2%）', () => {
    for (const s of COVER_SPECS) {
      const m = /^(\d+)x(\d+)$/.exec(s.size);
      expect(m, `${s.key} size 不是 宽x高`).toBeTruthy();
      const w = Number(m![1]);
      const h = Number(m![2]);
      expect(Math.abs(w / h - s.aspect) / s.aspect).toBeLessThan(0.02);
    }
  });
});
