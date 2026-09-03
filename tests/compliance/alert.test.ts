import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// 「合规拦截告警」是新建机器人默认勾上的三项之一，却直到 2026-09-03 都没有发射点。
const pushed: { ws: string; event: string; msg: any }[] = [];
vi.mock('@/lib/bot', () => ({
  pushEvent: async (ws: string, event: string, msg: unknown) => { pushed.push({ ws, event, msg }); return { sent: 1, failed: 0 }; },
  beaconUrl: (p: string) => `https://x${p}`,
}));
const { notifyComplianceBlock } = await import('@/lib/compliance/alert');
const hit = [{ word: '最佳', tier: 'legal', index: 0 }] as any;

beforeEach(() => { pushed.length = 0; });

describe('notifyComplianceBlock', () => {
  it('说清拦在哪、命中什么、片段截短', async () => {
    await notifyComplianceBlock('w1', '导出稿件', hit, 'x'.repeat(500));
    expect(pushed).toHaveLength(1);
    expect(pushed[0].event).toBe('compliance_alert');
    const s = JSON.stringify(pushed[0].msg);
    expect(s).toContain('导出稿件');
    expect(s).toContain('最佳');
    expect(s).not.toContain('x'.repeat(100));
  });
  it('没有 workspaceId / 没命中 → 不推', async () => {
    await notifyComplianceBlock(null, 'x', hit);
    await notifyComplianceBlock('w1', 'x', []);
    expect(pushed).toHaveLength(0);
  });
});

describe('🔒 各条红线硬闸的拒绝分支都接了告警', () => {
  it.each([
    ['app/(app)/studio/actions.ts', ['导出稿件', '导出 PDF', '采纳标题']],
    ['lib/cover/run.ts', ['生成封面']],
    ['lib/illustration/run.ts', ['生成配图']],
  ])('%s', (file, wheres) => {
    const src = readFileSync(join(process.cwd(), file), 'utf8');
    for (const w of wheres) expect(src, w).toMatch(new RegExp(`notifyComplianceBlock\\([^\\n]*'${w}'`));
  });
  it('refresh_reminder 已从事件表删除（产品里没有这个概念）', () => {
    expect(readFileSync(join(process.cwd(), 'lib/bot/types.ts'), 'utf8')).not.toContain('refresh_reminder');
  });
});
