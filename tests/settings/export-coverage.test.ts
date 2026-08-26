import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

// 数据导出覆盖度守卫（静态检查，不连库）。
//
// 【为什么需要它】导出是 PIPL 第 45 条可携带权的兑现：**用户要能把自己配的东西带走**。
// 而「新加了一张用户配置表，忘了加进导出」这件事在开发态完全看不出来——
// 导出接口照常返回 200，文件照常下载，只是里面少了一块，而少的那块只有用户自己知道。
//
// TaskPreset（一键任务卡）就是这么漏的：它和定时、自建智能体一样是用户花心思配出来的，
// 三者里前两个在导出里，它不在——上线前的排查才发现。
//
// 所以加一道**加表即报警**的闸，形状与 tests/rls-coverage.test.ts 一样：
// 以后任何人往 schema 里加一张用户配置类的表，若不在导出里、也不在下面的豁免清单里
// 写明理由，这条用例直接变红。
//
// ⚠️ 它只能证明「查了这张表」，不能证明「导出的字段够用」——后者只能靠人读那份 JSON。

const ROOT = path.resolve(__dirname, '..', '..');
const SCHEMA = fs.readFileSync(path.join(ROOT, 'prisma', 'schema.postgres.prisma'), 'utf8');
const EXPORT_SRC = fs.readFileSync(path.join(ROOT, 'lib', 'account', 'export.ts'), 'utf8');
const INVENTORY_SRC = fs.readFileSync(path.join(ROOT, 'lib', 'account', 'inventory.ts'), 'utf8');

/**
 * 刻意不导出的表，每张都要有理由。
 *
 * 分三类：
 *   ① 全局共享的（不属于这个租户，导出去也没意义）
 *   ② 运行日志与中间态（有自己的到期清理，不是「用户配的东西」）
 *   ③ 凭证与会话（导出即等于把钥匙交出去，meta.excluded 里明说了不导）
 */
const EXEMPT: Record<string, string> = {
  // ① 全局共享
  CompetitorAccount: '全局共享竞对档案，导出的是订阅关系而不是档案本身',
  CrawledPost: '全局共享竞对作品',
  PostMetricSnapshot: '全局共享竞对作品的指标快照',
  CompetitorDailyStat: '全局共享竞对的逐日快照',
  HotItem: '全局广播热榜',
  TopicCluster: '全局广播话题簇',
  SensitiveWord: '系统词库',
  AlgorithmRule: '系统级平台算法规则库',
  ParserRule: '系统级解析规则库',
  Tenant: '租户本身的元信息已在 meta 里',
  Workspace: '已在 workspaces 里导出',

  // ② 运行日志与中间态：有自己的到期清理，不是用户配出来的东西
  AgentRun: 'AI 执行的运行日志，90 天自动清理',
  AgentStep: '执行步骤流水，跟着 AgentRun 走',
  AgentRunNote: '执行过程中的追问，跟着 AgentRun 走',
  AgentArtifact: '执行产物的指针，产物本身（草稿/图/计划）已各自导出',
  WorkflowRun: '工作流运行日志',
  CollectionRun: '采集台账',
  JobRun: '平台任务运行记账，不属于任何租户',
  LlmCallLog: '成本账本（消耗统计已在 meta.inventory 里）',
  BrowserTask: '派给插件的任务队列，中间态',
  PublishTask: '发布任务中间态，跟着 PublishPlan 走',
  PublishPlan: '发布计划，publishRecords 已导出实际发布结果',
  ParserIncident: '解析降级的告警记录',
  ReaderComment: '读者原声，90 天到期删除（政策承诺）',
  DraftVersion: '草稿历史版本，drafts 里已带当前正文',
  ComplianceCheck: '合规检测记录，是过程不是资产',
  BotConversation: '群机器人对话上下文，滚动窗口',
  AccountDeletion: '注销存根（电商法三年留存），不是用户资产',

  // ③ 凭证与会话：meta.excluded 里明说了不导
  AuthSession: '登录会话 token，导出即交钥匙',
  IngestToken: '采集令牌，同上',
  ApiToken: '对外调用令牌，同上',
  PublishCredential: '发布凭证（AppSecret / OAuth token 都是密文），导出即交钥匙',
  WxPayNotifyLog: '支付回调去重日志',
  WxPayRefund: '退款流水（payments 里已有订单）',
  MediaAsset: '媒体资产的存储指针（图片本体在对象存储，导出包不塞二进制）',
  TopicVote: '选题投票，是过程数据',
  Invite: '邀请码，用完即废',
  Notification: '站内通知，是提醒不是资产',
  PersonaVersion: '人设历史版本（personaVersions 已导出）',
};

/** schema 里所有 model 名。 */
function allModels(): string[] {
  return [...SCHEMA.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]);
}

/** 这张表有没有租户归属（tenantId / workspaceId / accountId），只有这些才谈得上「用户的数据」。 */
function isTenantScoped(model: string): boolean {
  const block = SCHEMA.match(new RegExp(`model\\s+${model}\\s*\\{[\\s\\S]*?\\n\\}`))?.[0] ?? '';
  return /\n\s+(tenantId|workspaceId|accountId)\s+String/.test(block);
}

/** 导出里查过这张表吗（prisma.xxx.findMany / findUnique / count）。 */
function coveredByExport(model: string): boolean {
  const camel = model[0].toLowerCase() + model.slice(1);
  return new RegExp(`prisma\\.${camel}\\.`).test(EXPORT_SRC);
}

describe('数据导出覆盖度（加表漏导即报警）', () => {
  it('每张带租户归属的表，要么被导出，要么在豁免清单里写明理由', () => {
    const missing = allModels()
      .filter(isTenantScoped)
      .filter((m) => !EXEMPT[m])
      .filter((m) => !coveredByExport(m));

    expect(
      missing,
      `以下表带租户归属却没进数据导出：${missing.join('、')}。\n`
      + '要么在 lib/account/export.ts 里查它，要么在本文件的 EXEMPT 里写明为什么不需要导。\n'
      + '（导出是 PIPL 第 45 条可携带权的兑现——少一块只有用户自己会发现。）',
    ).toEqual([]);
  });

  it('豁免清单里不许有已经不存在的表（清单本身也会过时）', () => {
    const models = new Set(allModels());
    const stale = Object.keys(EXEMPT).filter((m) => !models.has(m));
    expect(stale, `这些表已经不在 schema 里了，从 EXEMPT 删掉：${stale.join('、')}`).toEqual([]);
  });

  it('这条守卫真的扫得到东西（正则坏了会静默全过）', () => {
    // 【防「守卫自己坏了却一直绿」】扫不到 model 或扫不出租户归属的话，
    // 上面那条会永远是空数组
    expect(allModels().length, '一个 model 都没扫到，正则大概坏了').toBeGreaterThan(30);
    expect(allModels().filter(isTenantScoped).length, '一张带租户归属的表都没扫到').toBeGreaterThan(20);
    expect(coveredByExport('CreatorAccount'), '连明明导出了的表都判成没导').toBe(true);
    expect(coveredByExport('HotItem'), '把没导的表判成导了').toBe(false);
  });

  it('导出的东西也要出现在数据清单里（清单少一行 = 用户以为没导出）', () => {
    // 清单是用户唯一能核对「这份文件里有什么」的地方。
    // 导了却不列，他会以为没导；列了却没导，他会以为有——两种都是错的。
    for (const [model, label] of [
      ['taskPreset', '一键任务卡'],
      ['scheduledAgent', '定时智能体计划'],
      ['workflowTemplate', '自建智能体'],
    ] as const) {
      expect(INVENTORY_SRC, `数据清单里没数 ${label}`).toMatch(new RegExp(`prisma\\.${model}\\.count`));
    }
  });
});
