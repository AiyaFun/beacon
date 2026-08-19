import { prisma } from '@/lib/db';
import { PageHead, Card, Stat, Empty } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { parseJson } from '@/lib/json';
import { platformName } from '@/lib/constants';
import { ParserPanel } from './ParserPanel';

export const dynamic = 'force-dynamic';

// 采集自学习的审核台：疑似改版事件 → 让模型推断候选锚点 → 人工采纳 → 下发规则包 → 可回滚。
export default async function OpsParserPage() {
  const [incidents, rules] = await Promise.all([
    prisma.parserIncident.findMany({
      where: { status: { in: ['open', 'proposed'] } },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    }),
    prisma.parserRule.findMany({ orderBy: [{ platform: 'asc' }, { field: 'asc' }, { version: 'desc' }], take: 100 }),
  ]);

  const active = rules.filter((r) => r.status === 'active');
  const candidates = rules.filter((r) => r.status === 'candidate');

  return (
    <>
      <PageHead
        title="采集自学习"
        desc="平台改版 → 留脱敏结构样本 → 模型推断新锚点 → 你点头才下发 · 插件当天生效，不必发版"
      />

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="待处理事件" value={incidents.filter((i) => i.status === 'open').length} foot="同一改版会合并计数" />
        <Stat label="待审候选" value={candidates.length} foot="模型产出，未上线" />
        <Stat label="生效规则" value={active.length} foot="插件正在用的那一版" />
        <Stat label="累计样本" value={incidents.reduce((a, i) => a + i.samples, 0)} foot="脱敏结构骨架" />
      </div>

      <ParserPanel
        incidents={incidents.map((i) => ({
          id: i.id,
          platform: i.platform,
          platformLabel: platformName(i.platform) || i.platform,
          scope: i.scope,
          field: i.field,
          status: i.status,
          samples: i.samples,
          hasSkeleton: !!i.skeleton,
          note: i.note,
          at: fmtDateTime(i.updatedAt),
        }))}
        rules={rules.map((r) => ({
          id: r.id,
          platform: r.platform,
          platformLabel: platformName(r.platform) || r.platform,
          field: r.field,
          status: r.status,
          version: r.version,
          selectors: parseJson<string[]>(r.selectors, []),
          anchors: parseJson<string[]>(r.anchors, []),
          hitRate: r.hitRate,
          source: r.source,
          note: r.note,
        }))}
      />

      {incidents.length === 0 && active.length === 0 && (
        <Card style={{ marginTop: 16 }}>
          <Empty icon="🧭" text="目前没有解析失效事件。插件采不到字段时会自动上报脱敏结构样本，这里就会出现待处理项。" />
        </Card>
      )}
    </>
  );
}
