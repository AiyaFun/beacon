import { describe, it, expect } from 'vitest';
import { renderSkillTemplate } from '@/lib/skills/render';

// 模板渲染是纯函数：占位符替换、缺参不炸、不 eval、不吃 replace 特殊序列。

describe('技能模板渲染 · 占位符替换', () => {
  it('三个占位符全部替换', () => {
    const out = renderSkillTemplate('标题：{{title}}\n人设：{{persona}}\n正文：{{content}}', {
      content: '正文内容',
      title: '我的标题',
      persona: '美食博主',
    });
    expect(out).toBe('标题：我的标题\n人设：美食博主\n正文：正文内容');
  });

  it('同一占位符多次出现，每处都替换', () => {
    expect(renderSkillTemplate('{{content}}+{{content}}', { content: 'A' })).toBe('A+A');
  });

  it('花括号内有空白也认（{{ content }}）', () => {
    expect(renderSkillTemplate('{{ content }}|{{  title  }}', { content: 'A', title: 'B' })).toBe('A|B');
  });

  it('缺参不炸：未提供的占位符替换为空串', () => {
    expect(renderSkillTemplate('[{{title}}][{{persona}}][{{content}}]', { content: 'A' })).toBe('[][][A]');
    expect(renderSkillTemplate('{{content}}', {})).toBe('');
  });

  it('白名单外的占位符原样保留，不吞不炸', () => {
    expect(renderSkillTemplate('{{evil}}和{{content}}', { content: 'A' })).toBe('{{evil}}和A');
  });

  it('没有占位符的模板原样返回', () => {
    expect(renderSkillTemplate('纯文本模板', { content: 'A' })).toBe('纯文本模板');
  });

  it('绝不 eval：模板里的 JS 表达式原样输出', () => {
    const tpl = '价格 ${1+1} 元，{{content}}';
    expect(renderSkillTemplate(tpl, { content: 'X' })).toBe('价格 ${1+1} 元，X');
  });

  it('正文含 replace 特殊序列（$&/$\'）不被展开', () => {
    // 若实现用了「替换字符串」而非替换函数，'$&' 会展开成匹配文本，把用户内容改坏
    const out = renderSkillTemplate('前{{content}}后', { content: "涨了$&又跌$'再涨$1" });
    expect(out).toBe("前涨了$&又跌$'再涨$1后");
  });

  it('空模板返回空串', () => {
    expect(renderSkillTemplate('', { content: 'A' })).toBe('');
  });
});

describe('技能模板渲染 · brief 占位符（参数卡）', () => {
  it('{{brief}} 与 {{context}} 各自替换，互不干扰', () => {
    const out = renderSkillTemplate('账号：{{context}}\n本次：{{brief}}\n正文：{{content}}', {
      content: '正文',
      context: '【风格指纹】幽默',
      brief: '【本次运行的额外要求】\n- 篇幅：更短',
    });
    expect(out).toContain('账号：【风格指纹】幽默');
    expect(out).toContain('本次：【本次运行的额外要求】');
  });

  it('没填参数卡时 {{brief}} 变空串，不留占位噪声', () => {
    expect(renderSkillTemplate('A{{brief}}B', { content: 'x' })).toBe('AB');
  });
});
