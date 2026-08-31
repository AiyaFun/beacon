import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from '@/lib/db';
import { sweepRetention, ACCOUNT_DELETION_RETENTION_DAYS } from '@/lib/legal/retention';
import { between } from '../helpers/anchor';

// 注销存根的到期清理（2026-08-31）。
//
// ── 它兑现的不是哪句承诺，而是另一条义务 ──
// 隐私政策写的是「已完成交易的凭证按《电子商务法》第三十一条保存**不少于三年**」——
// 那是**下限**，不是「三年后删」。所以这条清理不是在补一个空承诺。
// 它兑现的是《个人信息保护法》第十九条：保存期限应当为实现处理目的所必要的**最短时间**。
// 在此之前 AccountDeletion 只增不减，永远留着与那一条相悖。
//
// ── 为什么按 deletedAt 算不会早删 ──
// 电商法的三年从**交易完成之日**起算。但先付款才谈得上注销，
// 所以 deletedAt 必然晚于这条存根里任何一笔交易的 paidAt——按它算只会留得更久。
const DAY = 86_400_000;

const stub = (deletedAt: Date) => prisma.accountDeletion.create({
  data: {
    tenantId: 't1', memberId: 'm1', scope: 'tenant', plan: 'personal',
    ledger: JSON.stringify([{ outTradeNo: 'bcn_x', amountFen: 12900, paidAt: '2023-01-01' }]),
    deletedAt,
  },
});

beforeEach(async () => { await prisma.accountDeletion.deleteMany(); });

describe('注销存根到期清理', () => {
  it('🔒 过期的删掉', async () => {
    await stub(new Date(Date.now() - (ACCOUNT_DELETION_RETENTION_DAYS + 5) * DAY));
    const r = await sweepRetention();
    expect(r.accountDeletions).toBe(1);
    expect(await prisma.accountDeletion.count()).toBe(0);
  });

  it('🔒 没到期的一条都不许动（早删一天是违法）', async () => {
    await stub(new Date(Date.now() - (ACCOUNT_DELETION_RETENTION_DAYS - 5) * DAY));
    const r = await sweepRetention();
    expect(r.accountDeletions).toBe(0);
    expect(await prisma.accountDeletion.count()).toBe(1);
  });

  it('🔒 留存期不短于电商法要求的三年（1095 天）', () => {
    // 法条说的是「不**少于**三年」。早删一天是违法，晚删一个月只是多留一会儿——
    // 两侧代价不对称，所以这条守的是下界，不是等值。
    expect(ACCOUNT_DELETION_RETENTION_DAYS).toBeGreaterThanOrEqual(1095);
  });

  it('🔒 判据只有 deletedAt 一条，不许有别的分支', async () => {
    // 这一步删的是**交易凭证**，删错了拿不回来。任何「顺手清理测试数据」之类的
    // 附加条件都会扩大删除范围，而扩大的那部分不会有人发现。
    const src = readFileSync(join(process.cwd(), 'lib/legal/retention.ts'), 'utf8');
    const body = between(src, "step('account_deletions'", '}, 0);');
    expect(body).toContain('deletedAt: { lt: cutoff }');
    expect(body, '判据里混进了别的条件').not.toMatch(/where:\s*\{[^}]*,[^}]*deletedAt/);
    expect(body, '判据里混进了别的条件').not.toMatch(/deletedAt[^}]*\},\s*\w+:/);
  });

  it('🔒 结果要印进 JobRun 的 detail（删了多少必须看得见）', () => {
    const h = readFileSync(join(process.cwd(), 'lib/jobs/handlers.ts'), 'utf8');
    expect(h, '删了多少不印出来，等于没人知道这一步跑没跑').toContain('注销存根 ${r.accountDeletions}');
  });

  it('🔒 政策原文没有承诺「三年后删除」（别把这条清理说成在兑现承诺）', () => {
    // 如果哪天政策改成了「三年后删除」，这条守卫该被改写成「必须删」而不是继续这么放着。
    const web = readFileSync(join(process.cwd(), 'app/(public)/legal/privacy/page.tsx'), 'utf8');
    const i = web.indexOf('留存三年');
    expect(i).toBeGreaterThan(0);
    expect(web.slice(i, i + 300)).toContain('不少于三年');
  });
});
