import { describe, it, expect } from 'vitest';
import { deriveAgentState, successRate, statOf, type StateInput } from '@/lib/agent/overview-state';

// 数字员工档案（2026-09-11 P0-2）：状态口径只有 lib/agent/overview.ts 这一处，
// 界面不许各算一套。判错的方向都是「界面说可用、其实派不动」。

const input = (p: Partial<StateInput> = {}): StateInput => ({
  installed: true, templateEnabled: true, liveStatuses: [], lastFinished: null, brokenSchedules: 0, ...p,
});

describe('deriveAgentState：可用 / 忙碌 / 受阻 / 故障 / 停用', () => {
  it('没装 = 停用，哪怕它正在跑（卸载不终止在跑的那次，但派不了新的）', () => {
    expect(deriveAgentState(input({ installed: false, liveStatuses: ['running'] })).state).toBe('stopped');
    expect(deriveAgentState(input({ templateEnabled: false })).state).toBe('stopped');
  });

  it('等确认 / 等浏览器 / 等额度 / 排队 = 受阻，且比忙碌优先（受阻的更需要人）', () => {
    for (const s of ['awaiting_confirm', 'waiting_browser', 'waiting_quota', 'queued']) {
      const r = deriveAgentState(input({ liveStatuses: ['running', s] }));
      expect(r.state, s).toBe('blocked');
      expect(r.reason.length).toBeGreaterThan(4);
    }
  });

  it('正在跑 = 忙碌，且盖过「最近一次失败」（它正在重新证明自己）', () => {
    expect(deriveAgentState(input({ liveStatuses: ['running'], lastFinished: { status: 'failed', error: 'x' } })).state).toBe('busy');
  });

  it('没在跑但最近一次失败 / 名下定时连败 = 故障，原因带出来', () => {
    const a = deriveAgentState(input({ lastFinished: { status: 'failed', error: '模板不存在' } }));
    expect(a.state).toBe('broken');
    expect(a.reason).toContain('模板不存在');
    expect(deriveAgentState(input({ brokenSchedules: 2 })).state).toBe('broken');
  });

  it('装着、没在跑、最近一次没坏 = 可用；从没跑过也是可用', () => {
    expect(deriveAgentState(input()).state).toBe('available');
    expect(deriveAgentState(input({ lastFinished: { status: 'cancelled', error: null } })).state).toBe('available');
  });
});

describe('successRate / statOf：样本为 0 不补分', () => {
  it('没跑过是 null，不是 0 也不是 100', () => {
    expect(successRate(0, 0)).toBeNull();
    expect(statOf([]).rate).toBeNull();
  });
  it('取消的不算分母：用户自己终止的不是失败', () => {
    const s = statOf([{ status: 'done' }, { status: 'failed' }, { status: 'cancelled' }, { status: 'done' }]);
    expect(s).toEqual({ total: 4, done: 2, failed: 1, cancelled: 1, rate: 67 });
  });
});
