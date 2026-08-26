import { prisma } from '@/lib/db';
import { PageHead, Card, Stat, Empty } from '@/components/ui';
import { fmtNum } from '@/lib/format';
import { LLM_FUNCTIONS, LLM_VENDORS, type LlmFunction } from '@/lib/constants';
import { readPlatformAiConfig, platformSpendUsd } from '@/lib/ops/platform-config';
import { beijingStartOfDay, beijingStartOfMonth } from '@/lib/beijing';
import { ProviderPanel } from './ProviderPanel';
import { ConfigPanel } from './ConfigPanel';

export const dynamic = 'force-dynamic';

const FN_LABEL: Record<LlmFunction, string> = {
  scoring: '选题打分',
  generation: '内容生成',
  advisor: '智囊团会诊',
  compliance: '合规复检',
  chat: 'AI 助手对话',
  diagnosis: '算法教练诊断',
  video: '视频理解',
  image: '封面生图',
  agent: '执行模式（可选）',
};

// 全域 AI：平台级渠道 + 每功能参数 + 预算闸 + 用量账本。
//
// 与租户侧「接入与密钥」的分工：那边是**用户自己的 Key**（BYOK，钱他自己出），
// 这边是**平台垫付**的那条通道。优先级永远是 BYOK 优先——用户配了自己的 Key，
// 平台不该拿自己的额度替他花钱，也不该拿平台预算把他拦住。
export default async function OpsAiPage() {
  const dayStart = beijingStartOfDay();
  const monthStart = beijingStartOfMonth();

  const [providers, cfg, daySpend, monthSpend, byFn, bySource, mockCount, totalCalls] = await Promise.all([
    prisma.platformProvider.findMany({ orderBy: { createdAt: 'asc' } }),
    readPlatformAiConfig(),
    platformSpendUsd('day'),
    platformSpendUsd('month'),
    prisma.llmCallLog.groupBy({
      by: ['fn'],
      _count: { _all: true },
      _sum: { costUsd: true },
      where: { createdAt: { gte: monthStart } },
    }),
    prisma.llmCallLog.groupBy({
      by: ['source'],
      _count: { _all: true },
      _sum: { costUsd: true },
      where: { createdAt: { gte: monthStart } },
    }),
    prisma.llmCallLog.count({ where: { createdAt: { gte: dayStart }, mocked: true } }),
    prisma.llmCallLog.count({ where: { createdAt: { gte: dayStart } } }),
  ]);

  const dayCap = cfg.budget.dailyUsdCap;
  const monthCap = cfg.budget.monthlyUsdCap;

  return (
    <>
      <PageHead
        title="全域 AI 配置"
        desc="平台垫付通道的渠道 / 参数 / 预算 · 租户自带 Key（BYOK）始终优先，不受这里的预算约束"
      />

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat
          label="今日平台垫付"
          value={`$${daySpend.toFixed(2)}`}
          foot={dayCap === null ? '未设上限' : `上限 $${dayCap}（${Math.round((daySpend / Math.max(dayCap, 0.01)) * 100)}%）`}
        />
        <Stat
          label="本月平台垫付"
          value={`$${monthSpend.toFixed(2)}`}
          foot={monthCap === null ? '未设上限' : `上限 $${monthCap}`}
        />
        <Stat label="今日调用" value={fmtNum(totalCalls)} foot={`其中 Mock ${fmtNum(mockCount)} 次`} />
        <Stat label="平台渠道" value={providers.filter((p) => p.enabled).length} foot={`共 ${providers.length} 条`} />
      </div>

      <ProviderPanel
        providers={providers.map((p) => ({
          id: p.id,
          label: p.label,
          vendor: p.vendor,
          vendorLabel: LLM_VENDORS[p.vendor]?.name ?? p.vendor,
          model: p.model,
          region: p.region,
          enabled: p.enabled,
          isDefault: p.isDefault,
          status: p.status,
          routing: p.routing,
        }))}
        functions={LLM_FUNCTIONS.map((fn) => ({ key: fn, label: FN_LABEL[fn] }))}
      />

      <ConfigPanel
        config={cfg}
        functions={LLM_FUNCTIONS.map((fn) => ({ key: fn, label: FN_LABEL[fn] }))}
      />

      <div className="grid grid-2" style={{ marginTop: 16 }}>
        <Card title="本月按功能" sub="调用次数与花费（含 BYOK）">
          {byFn.length === 0 ? (
            <Empty icon="📊" text="本月还没有调用。" />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>功能</th><th>调用</th><th>花费</th></tr></thead>
                <tbody>
                  {byFn
                    .slice()
                    .sort((a, b) => (b._sum.costUsd ?? 0) - (a._sum.costUsd ?? 0))
                    .map((r) => (
                      <tr key={r.fn}>
                        <td>{FN_LABEL[r.fn as LlmFunction] ?? r.fn}</td>
                        <td>{fmtNum(r._count._all)}</td>
                        <td>${(r._sum.costUsd ?? 0).toFixed(3)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="本月按付费方" sub="谁出的钱">
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>来源</th><th>调用</th><th>花费</th></tr></thead>
              <tbody>
                {bySource.map((r) => (
                  <tr key={r.source}>
                    <td>
                      {r.source === 'platform' ? '平台垫付' : r.source === 'byok' ? '用户自带 Key' : r.source === 'mock' ? 'Mock（不花钱）' : '历史数据（不详）'}
                    </td>
                    <td>{fmtNum(r._count._all)}</td>
                    <td>${(r._sum.costUsd ?? 0).toFixed(3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted" style={{ marginTop: 8 }}>
            「历史数据（不详）」是本列加上之前就存在的记录。不知道是谁出的钱就说不知道，不并进平台账。
          </p>
        </Card>
      </div>
    </>
  );
}
