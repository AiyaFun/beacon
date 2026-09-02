import { describe, it, expect } from 'vitest';
import { __testing } from '@/lib/agent/run';
import type { ChatMessage } from '@/lib/llm/types';

// 对话超长时的三段处理（2026-09-02 加了第零步）：剪旧工具结果 → 折叠中段 → 删。
// 这三步的产物是**落库**的，之后每一轮都会原样再送一遍——这里出的错是永久的。

const { capMessages, pruneOldToolResults, KEEP_RECENT, MAX_MESSAGES_CHARS } = __testing;

/** 一轮 = 助手要调工具 + 工具回复。big 控制回复有多大。 */
function round(i: number, big: number, ok = true): ChatMessage[] {
  return [
    { role: 'assistant', content: '', toolCalls: [{ id: `c${i}`, name: 'list_drafts', arguments: '{}' }] },
    { role: 'tool', toolCallId: `c${i}`, content: JSON.stringify({ ok, summary: `第 ${i} 次查到 3 篇`, data: 'x'.repeat(big) }) },
  ];
}

function convo(rounds: number, big: number): ChatMessage[] {
  const m: ChatMessage[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: '帮我看看草稿' }];
  for (let i = 0; i < rounds; i++) m.push(...round(i, big));
  return m;
}

const roles = (m: ChatMessage[]) => m.map((x) => x.role);
const noOrphan = (m: ChatMessage[]) => {
  const declared = new Set<string>();
  for (const x of m) {
    if (x.role === 'assistant') for (const c of x.toolCalls ?? []) declared.add(c.id);
    if (x.role === 'tool') expect(declared.has(x.toolCallId)).toBe(true);
  }
};

describe('第零步：只剪旧的大工具结果', () => {
  it('剪完够用就不折叠：助手的每一次调用都还在', () => {
    const m = convo(10, 40_000); // 40 万字，远超上限
    const json = capMessages(m);
    expect(json.length).toBeLessThanOrEqual(MAX_MESSAGES_CHARS);
    // 十次 assistant(toolCalls) 一次没少——折叠会把它们压成一句话
    expect(m.filter((x) => x.role === 'assistant').length).toBe(10);
    expect(json).not.toContain('前面的过程已折叠');
    noOrphan(m);
  });

  it('占位符带着工具自己那句摘要，并保留 ok 标志', () => {
    const m: ChatMessage[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'q' }, ...round(0, 5000, false)];
    for (let i = 1; i <= KEEP_RECENT; i++) m.push(...round(i, 10));
    expect(pruneOldToolResults(m)).toBe(true);
    const pruned = m[3];
    expect(pruned.role).toBe('tool');
    if (pruned.role !== 'tool') return;
    expect(pruned.content.length).toBeLessThan(400);
    expect(pruned.content).toContain('第 0 次查到 3 篇');
    expect(pruned.content).toMatch(/"ok"\s*:\s*false/); // 折叠摘要数失败次数靠这个形状
    expect(pruned.content).toContain('不要重做');
  });

  it('最近几条不剪（模型要接着上一步干活）', () => {
    const m = convo(3, 5000);
    expect(pruneOldToolResults(m)).toBe(false);
    expect(m.every((x) => !x.content.toString().includes('"pruned"'))).toBe(true);
  });

  it('小结果不剪、剪过的不再剪', () => {
    const m = convo(12, 100);
    expect(pruneOldToolResults(m)).toBe(false);
    const big = convo(12, 5000);
    expect(pruneOldToolResults(big)).toBe(true);
    expect(pruneOldToolResults(big)).toBe(false);
  });
});

describe('第一步：折叠不能造出连着的两条 user', () => {
  it('折叠段后面紧跟真实用户消息（追问过）时，摘要并进那条消息而不是另起一条', () => {
    const m = convo(40, 100);
    // 追问：中间插一条用户消息，再接几轮。**切点必须正好落在这条用户消息上**——
    // 第一版让它落在后一条 assistant 上，于是合并分支根本没走到，拆掉合并逻辑用例照样绿
    //（变异验证当场抓到）。最近 KEEP_RECENT 条 = user + 两轮(4 条) + 最后一句，正好 6 条。
    const tail: ChatMessage[] = [{ role: 'user', content: '另外，把标题也改一下' }];
    tail.push(...round(100, 100), ...round(101, 100));
    tail.push({ role: 'assistant', content: '最后一句' });
    expect(tail.length).toBe(KEEP_RECENT);
    m.push(...tail);
    // 把总长撑过上限，且剪枝剪不下来（每条都小）
    const filler: ChatMessage = { role: 'user', content: 'y'.repeat(MAX_MESSAGES_CHARS) };
    m.splice(1, 0, filler);
    const json = capMessages(m);
    const r = roles(m);
    for (let i = 1; i < r.length; i++) {
      expect(r[i - 1] === 'user' && r[i] === 'user', `第 ${i} 条与前一条都是 user`).toBe(false);
    }
    expect(json).toContain('前面的过程已折叠');
    // 摘要就在那条追问的开头，追问原文也还在
    const merged = m[1];
    expect(merged.role).toBe('user');
    expect(String(merged.content)).toContain('前面的过程已折叠');
    expect(String(merged.content)).toContain('另外，把标题也改一下');
    noOrphan(m);
  });

  it('折叠段后面是助手消息时，摘要单独一条 user', () => {
    const m = convo(40, 100);
    const filler: ChatMessage = { role: 'user', content: 'y'.repeat(MAX_MESSAGES_CHARS) };
    m.splice(1, 0, filler);
    capMessages(m);
    expect(m[1].role).toBe('user');
    expect(String(m[1].content)).toContain('前面的过程已折叠');
    expect(m[2].role).toBe('assistant');
    noOrphan(m);
  });
});
