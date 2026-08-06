import { describe, it, expect } from 'vitest';
import { buildCoverPrompt, onImageText } from '@/lib/cover/prompt';
import { COVER_STYLES, coverStyle, DEFAULT_COVER_STYLE } from '@/lib/cover/styles';

// 封面提示词的纯函数守卫：拼装口径 + 会被红线检的“上图文字”口径 + 风格回落。
// 这几条是零依赖纯函数，值一个便宜的静态用例把契约钉死。

describe('onImageText（会画到图上、要过红线的文字）', () => {
  it('只含主标题与副标题', () => {
    expect(onImageText({ mainTitle: '主', subTitle: '副' })).toBe('主 副');
    expect(onImageText({ mainTitle: '主' })).toBe('主');
  });
});

describe('buildCoverPrompt', () => {
  it('带上主标题、风格描述与 3:4 意图', () => {
    const p = buildCoverPrompt({ meta: { mainTitle: '三天瘦五斤', subTitle: '亲测' }, styleKey: 'magazine' });
    expect(p).toContain('三天瘦五斤');
    expect(p).toContain('亲测');
    expect(p).toContain('3:4');
    expect(p).toContain(coverStyle('magazine').prompt.slice(0, 8));
  });

  it('有参考图 → 加“主体保真”约束', () => {
    const p = buildCoverPrompt({ meta: { mainTitle: 'x' }, hasReference: true });
    expect(p).toContain('主体保真');
  });

  it('无参考图 → 不出现主体保真', () => {
    const p = buildCoverPrompt({ meta: { mainTitle: 'x' } });
    expect(p).not.toContain('主体保真');
  });

  it('留白版 → 明确不上字、且不写主标题指令', () => {
    const p = buildCoverPrompt({ meta: { mainTitle: 'x' }, textless: true });
    expect(p).toContain('不要在图上写任何文字');
    expect(p).not.toContain('【主标题】');
  });
});

describe('coverStyle 回落', () => {
  it('未知/缺省 key → 默认第一档', () => {
    expect(coverStyle('nope').key).toBe(COVER_STYLES[0].key);
    expect(coverStyle(undefined).key).toBe(DEFAULT_COVER_STYLE);
  });
});
