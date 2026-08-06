import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

// RLS 覆盖度守卫（静态检查，不连库）。
//
// 【为什么需要它】`prisma/postgres/02-rls.sql` 最初只给 9 张表写了策略，其余租户数据全部裸奔。
// 那不是设计如此——是**新表加了没人补策略**，而且这种遗漏在开发态完全看不出来：
// 本地跑 SQLite（根本没有 RLS），CI 也不连 Postgres，漏了就是静悄悄漏了。
// `InspirationItem` / `TopicVote` 就是这么进来的（本轮补齐时才发现）。
//
// 所以除了补齐存量，更要紧的是加一道**加表即报警**的闸：
// 以后任何人往 schema 里加一张带租户归属的表，若不在 SQL 里补策略、也不在下面的豁免清单里
// 写明理由，这条用例直接变红。**补齐是一次性的，守卫是持久的。**
//
// ⚠️ 它只能证明「策略写了」，不能证明「策略正确」——后者要连真 Postgres 跑，
// 属于 VERIFICATION.md 里的 🟡（代码核实，未实跑）。别把这条测试绿了当成 RLS 验证过了。

const ROOT = path.resolve(__dirname, '..');
const SCHEMA = fs.readFileSync(path.join(ROOT, 'prisma', 'schema.postgres.prisma'), 'utf8');
const RLS_SQL = fs.readFileSync(path.join(ROOT, 'prisma', 'postgres', '02-rls.sql'), 'utf8');

// 刻意不启用 RLS 的表，每张都要有理由。加表到这里 = 明确声明「这张表不需要租户隔离」。
const EXEMPT: Record<string, string> = {
  // 全局共享：同一竞对/热点被 N 个租户使用，只存一份
  CompetitorAccount: '全局共享竞对档案，无租户归属',
  CrawledPost: '全局共享竞对作品',
  PostMetricSnapshot: '全局共享竞对作品的指标快照',
  HotItem: '全局广播热榜，全租户共用',
  TopicCluster: '全局广播话题簇',
  SensitiveWord: '系统词库（含租户自定义部分，由应用层过滤）',
  AlgorithmRule: '系统级平台算法规则库',
  ContentSkill: '内置技能为全局，租户自建部分由应用层过滤',
  // 系统级：由无租户上下文的系统路径写入
  WxPayNotifyLog: '支付回调去重日志，写入方永远无登录态',
  WxPayRefund: '退款流水，由无登录态回调/内部接口写入',
  LlmCallLog: '成本账本，worker 与用户路径都写',
  JobRun: '任务运行记账，worker 写入',
  VerificationCode: '登录前的短信验证码，此时还没有租户上下文',
  // 顶层与跨租户
  Tenant: '租户表自身即隔离边界的定义处',
  DataRemovalRequest: '数据删除请求，可能由未登录用户发起',
  AccountDeletion:
    '注销存根：写入的那一刻租户正在被删除，事后 tenantId 指向的行已不存在，' +
    '按它做行级隔离没有意义（永远匹配不到任何在世租户）。只供运维/法务对账，不经用户路径读。',
};

// 归属键 → 该表应当出现在 SQL 里的哪种断言形态。
// 只做「有没有为这张表建策略」的存在性检查，不校验策略表达式本身（那要连库才有意义）。
const OWNER_KEYS = ['tenantId', 'workspaceId', 'accountId', 'memberId'] as const;

// 没有直接归属键、靠父表外键归属的表。它们同样是租户数据，必须有策略。
const SECOND_DEGREE = ['DraftVersion', 'ComplianceCheck', 'PerformanceSnapshot', 'AdvisorOpinion'];

function modelsOf(schema: string): { name: string; body: string }[] {
  return [...schema.matchAll(/model (\w+) \{([\s\S]*?)\n\}/g)].map((m) => ({ name: m[1], body: m[2] }));
}

// SQL 里这张表是否被建了策略：要么出现在某个 ARRAY[...] 批量块里，要么有独立的 CREATE POLICY。
function hasPolicy(table: string): boolean {
  return (
    new RegExp(`'${table}'`).test(RLS_SQL) ||
    new RegExp(`CREATE POLICY \\w+ ON "${table}"`).test(RLS_SQL)
  );
}

describe('RLS 覆盖度（加表漏补策略即报警）', () => {
  const models = modelsOf(SCHEMA);

  it('schema 能被解析出模型（守卫本身不许静默失效）', () => {
    expect(models.length).toBeGreaterThan(30);
  });

  it('每张带租户归属键的表都有 RLS 策略', () => {
    const missing: string[] = [];
    for (const { name, body } of models) {
      if (EXEMPT[name]) continue;
      const owned = OWNER_KEYS.some((k) => new RegExp(`^\\s+${k}\\s`, 'm').test(body));
      if (!owned) continue;
      if (!hasPolicy(name)) missing.push(name);
    }
    expect(
      missing,
      `以下表带租户归属键却没有 RLS 策略：${missing.join('、')}。\n` +
        '要么在 prisma/postgres/02-rls.sql 里补策略，要么在 tests/rls-coverage.test.ts 的 EXEMPT 里写明为什么不需要。',
    ).toEqual([]);
  });

  it('二级归属的表（靠父表外键）也都有策略', () => {
    const missing = SECOND_DEGREE.filter((t) => !hasPolicy(t));
    expect(missing, `二级归属表缺策略：${missing.join('、')}`).toEqual([]);
  });

  it('豁免清单里的表确实存在于 schema（清单不许留幽灵项）', () => {
    const names = new Set(models.map((m) => m.name));
    const ghosts = Object.keys(EXEMPT).filter((t) => !names.has(t));
    expect(ghosts, `豁免清单里这些表在 schema 里已不存在：${ghosts.join('、')}`).toEqual([]);
  });

  it('两份 schema 的模型集合一致（sqlite 与 postgres 不许漂移）', () => {
    const sqlite = modelsOf(fs.readFileSync(path.join(ROOT, 'prisma', 'schema.prisma'), 'utf8'));
    const a = new Set(models.map((m) => m.name));
    const b = new Set(sqlite.map((m) => m.name));
    const onlyPg = [...a].filter((x) => !b.has(x));
    const onlySqlite = [...b].filter((x) => !a.has(x));
    expect(
      [...onlyPg, ...onlySqlite],
      `两份 schema 模型不一致：仅 postgres 有 [${onlyPg}]，仅 sqlite 有 [${onlySqlite}]`,
    ).toEqual([]);
  });

  it('NULL 放行语义在每条策略里都在（漏了会让 worker/cron 读不到数据）', () => {
    const policies = [...RLS_SQL.matchAll(/CREATE POLICY[\s\S]*?USING \(([\s\S]*?)\);/g)].map((m) => m[1]);
    expect(policies.length).toBeGreaterThan(5);
    const noNullPass = policies.filter((p) => !p.includes('app_current_tenant() IS NULL'));
    expect(
      noNullPass,
      '这些策略缺 NULL 放行：无登录态的 worker / cron / 支付回调会读不到任何数据',
    ).toEqual([]);
  });
});
