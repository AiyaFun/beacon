import { describe, it, expect } from 'vitest';
import { expiryNoticeFor } from '@/lib/pay/expiry';

// 到期提醒的第三条腿：顶部横幅（components/ExpiryBanner.tsx）。
// 邮件通道 2026-07-30 下线后，「人不打开通知中心也能看见」全靠它。
//
// 横幅与定时任务共用同一个纯函数，但**不传 sentStages**：
// 通知是「发一次」，横幅是「这段时间一直在」。这份用例钉的就是这个差别——
// 任务漏跑（worker 重启/机器维护）时横幅照常出现，不会出现「到期了却全无提示」。

describe('到期横幅的取数口径', () => {
  const base = { plan: 'personal', now: new Date('2026-08-01T00:00:00Z') };

  it('7 天内 → 有提示', () => {
    const n = expiryNoticeFor({ ...base, planExpiresAt: new Date('2026-08-05T00:00:00Z') });
    expect(n).not.toBeNull();
    expect(n!.stage).toBe('d7');
  });

  it('已到期（宽限窗内）→ 仍提示，且明说数据还在', () => {
    const n = expiryNoticeFor({ ...base, planExpiresAt: new Date('2026-07-30T00:00:00Z') });
    expect(n!.stage).toBe('expired');
    expect(n!.body).toContain('保留');
  });

  it('还早（8 天以上）→ 不打扰', () => {
    expect(expiryNoticeFor({ ...base, planExpiresAt: new Date('2026-09-01T00:00:00Z') })).toBeNull();
  });

  it('免费版 / 无到期日（运营手工开通）→ 永不提示', () => {
    expect(expiryNoticeFor({ plan: 'free', planExpiresAt: new Date('2026-08-02T00:00:00Z'), now: base.now })).toBeNull();
    expect(expiryNoticeFor({ plan: 'personal', planExpiresAt: null, now: base.now })).toBeNull();
  });

  it('🔒 不传 sentStages 时每次都出——横幅不吃「已发过」这套去重', () => {
    const at = new Date('2026-08-03T00:00:00Z');
    const a = expiryNoticeFor({ ...base, planExpiresAt: at });
    const b = expiryNoticeFor({ ...base, planExpiresAt: at });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // 对照：定时任务那条腿传了 sentStages，同一档就不再发第二次
    expect(expiryNoticeFor({ ...base, planExpiresAt: at, sentStages: [a!.stage] })).toBeNull();
  });
});
