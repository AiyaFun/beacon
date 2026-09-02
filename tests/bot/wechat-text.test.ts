import { describe, it, expect } from 'vitest';
import { splitWechatText, WECHAT_TEXT_MAX, WECHAT_TEXT_MAX_PARTS } from '@/lib/bot/wechat-text';

// 微信侧超长回复拆段（2026-09-02）。此前两条通道都是 slice(0,600)——对话回复被截成半句话。

describe('splitWechatText', () => {
  it('短文本原样一段；空文本零段', () => {
    expect(splitWechatText('你好')).toEqual(['你好']);
    expect(splitWechatText('   ')).toEqual([]);
  });

  it('🔒 长文本拆成多段，每段不超上限，且**一个字不丢**（截断是这条守卫要拦的退化）', () => {
    const paras = Array.from({ length: 8 }, (_, i) => `第${i + 1}段。${'内容'.repeat(120)}`);
    const text = paras.join('\n\n');
    const parts = splitWechatText(text);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(WECHAT_TEXT_MAX);
    // 去掉空白后拼回去要等于原文（没有丢字、没有「后文略」）
    expect(parts.join('').replace(/\s/g, '')).toBe(text.replace(/\s/g, ''));
  });

  it('优先在段落边界切，不把一句话切成两半', () => {
    const a = `甲${'一'.repeat(400)}。`;
    const b = `乙${'二'.repeat(400)}。`;
    const parts = splitWechatText(`${a}\n\n${b}`);
    expect(parts).toEqual([a, b]);
  });

  it('段数封顶，最后一段标注「后文略」而不是无限刷屏', () => {
    const text = 'x'.repeat(WECHAT_TEXT_MAX * (WECHAT_TEXT_MAX_PARTS + 3));
    const parts = splitWechatText(text);
    expect(parts.length).toBe(WECHAT_TEXT_MAX_PARTS);
    expect(parts[parts.length - 1]).toMatch(/后文略/);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(WECHAT_TEXT_MAX);
  });
});
