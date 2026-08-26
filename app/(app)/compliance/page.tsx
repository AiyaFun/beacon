import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { can } from '@/lib/rbac';
import { platformName, COMPLIANCE_TIERS } from '@/lib/constants';
import { PageHead, Card, Stat, TierBadge, Fold } from '@/components/ui';
import { Icon } from '@/components/icons';
import { Checker } from './Checker';
import { WordManager } from './WordManager';
import { FeedbackPanel } from './FeedbackPanel';
import type { CustomWord, FeedbackItem } from './actions';
import { MakeTabs } from '@/components/MakeTabs';
import { HubHeader } from '@/components/HubHeader';

export const dynamic = 'force-dynamic';

const TIER_ORDER = ['legal', 'platform', 'industry', 'custom'] as const;

export default async function CompliancePage() {
  const s = await getSession();

  // 可见词库：全局三级（legal/platform/industry）+ 本租户自定义级
  const [words, recentDrafts, feedbackItems] = await Promise.all([
    prisma.sensitiveWord.findMany({
      where: {
        OR: [
          { tenantId: null, enabled: true },
          { tenantId: s.tenantId },
        ],
      },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.draft.findMany({
      where: { account: { workspaceId: s.workspaceId } },
      orderBy: { updatedAt: 'desc' },
      take: 10,
      include: { versions: { orderBy: { seq: 'desc' }, take: 1 } },
    }),
    prisma.complianceFeedback.findMany({
      where: { tenantId: s.tenantId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
  ]);

  const draftOptions = recentDrafts.map((d) => ({
    id: d.id,
    title: d.title,
    content: d.versions[0]?.content || d.title,
  }));

  const customWords: CustomWord[] = (words.filter((w) => w.tier === 'custom')).map((w) => ({
    id: w.id,
    word: w.word,
    action: w.action,
    platform: w.platform,
    suggestion: w.suggestion,
    enabled: w.enabled,
    createdAt: w.createdAt.toISOString(),
  }));

  const byTier = new Map<string, typeof words>();
  for (const w of words) {
    if (!byTier.has(w.tier)) byTier.set(w.tier, []);
    byTier.get(w.tier)!.push(w);
  }

  return (
    <>
      <HubHeader
        title="做内容"
        hint="按目标平台检测并规避敏感词，四级词库：法律／平台／行业／自定义"
        tabs={<MakeTabs active="check" inline />}
      />

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        {TIER_ORDER.map((tier) => {
          const t = COMPLIANCE_TIERS[tier];
          return (
            <Stat
              key={tier}
              label={t.name}
              value={byTier.get(tier)?.length ?? 0}
              foot={t.desc}
            />
          );
        })}
      </div>

      <div className="grid-asym-left" style={{ marginBottom: 16 }}>
        {/* ⚠️ 这里此前写的是「本地秒查（不联网、不出库）」——三处都不成立：
            actCheck 是 server action（文案离开浏览器）、llmSemanticReview 无条件把原文拼进
            prompt 发给模型、命中且关联草稿时还会 prisma.complianceCheck.create。
            用户可能把未发布的商业稿贴进来，「不联网」这四个字直接影响他要不要贴。 */}
        <Card title="实时检测器" sub="词库秒查 + AI 语义复核（文案会发往服务端）">
          <Checker drafts={draftOptions} />
        </Card>

        <Fold title="四级词库总览" sub="共几级、各拦什么" note={<span className="small muted">看一次就够</span>}>
          <div className="stack" style={{ gap: 16 }}>
            {TIER_ORDER.map((tier) => {
              const list = byTier.get(tier) ?? [];
              const t = COMPLIANCE_TIERS[tier];
              return (
                <div key={tier}>
                  <div className="row-between" style={{ marginBottom: 8 }}>
                    <div className="row" style={{ gap: 8 }}>
                      <TierBadge tier={tier} />
                      <span className="small muted">{t.desc}</span>
                    </div>
                    <span className="badge badge-gray">{list.length} 条</span>
                  </div>
                  {list.length === 0 ? (
                    <div className="small muted">暂无词条</div>
                  ) : (
                    <div className="stack" style={{ gap: 6 }}>
                      {list.slice(0, 4).map((w) => (
                        <div key={w.id} className="list-row" style={{ alignItems: 'center' }}>
                          <span className="mono" style={{ minWidth: 84, fontWeight: 600 }}>{w.word}</span>
                          <span className={`badge ${w.action === 'block' ? 'badge-red' : w.action === 'warn' ? 'badge-amber' : 'badge-brand'}`}>
                            {w.action === 'block' ? '禁用' : w.action === 'warn' ? '警告' : '建议'}
                          </span>
                          <span className="small muted" style={{ flex: 1 }}>
                            {w.platform ? `${platformName(w.platform)} · ` : ''}
                            {w.suggestion ? `改为 ${w.suggestion}` : (w.category ?? '')}
                          </span>
                        </div>
                      ))}
                      {list.length > 4 && <div className="small muted">…另有 {list.length - 4} 条</div>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Fold>
      </div>

      <Fold title="自定义词库管理" sub="添加黑名单词条或白名单替代建议" note={<span className="small muted">要加词才翻开</span>}>
        <WordManager words={customWords} />
      </Fold>

      <Fold title="误报反馈" sub="认为某词在你的语境下属误报？告诉我们" note={<span className="small muted">偶尔用</span>}>
        <FeedbackPanel items={feedbackItems.map((f) => ({
          id: f.id,
          word: f.word,
          tier: f.tier,
          context: f.context,
          reason: f.reason,
          status: f.status,
          createdAt: f.createdAt.toISOString(),
        }))} canResolve={can(s.role, 'compliance.resolve')} />
      </Fold>

      <div className="alert-gradient-brand" style={{ padding: '14px 18px', marginBottom: 16 }}>
        <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
          <div className="icon-box-brand">
            <Icon.shield size={18} />
          </div>
          <div>
            <b className="small" style={{ color: 'var(--brand)', fontSize: 13.5 }}>AIGC 标识义务提醒（国家网信办新规）</b>
            <div className="small" style={{ marginTop: 2, opacity: 0.9, lineHeight: 1.6 }}>
              依据《人工智能生成合成内容标识办法》，AI 生成或合成的内容需显著声明「本内容由 AI 生成」，
              并保留必要的隐式元数据标识。发布 AI 参与创作的图文／视频前，请在正文或水印处加注声明。
            </div>
          </div>
        </div>
      </div>

      <Fold title="合规说明" sub="发布前必读" note={<span className="small muted">看一次就够</span>}>
        <div className="stack" style={{ gap: 12 }}>
          <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
            <span style={{ color: 'var(--brand)', marginTop: 2 }}><Icon.bulb size={16} /></span>
            <div>
              <b className="small">词库秒查 + AI 语义二次复核</b>
              <div className="small muted" style={{ marginTop: 3 }}>
                检测分两步：先在<b>服务端</b>跑词库匹配（毫秒级、不调用模型、不计费），
                再把文案送一次 AI 做语义复核，找词库覆盖不到的变体与隐含承诺。
                <b>你贴进来的文案会离开浏览器</b>——它会发到烽火台服务器，并在第二步随请求发给模型服务商。
                检测记录只有在<b>关联了草稿且确实命中</b>时才会留存（用于「上周被拦了什么」），
                检测框里的临时文本不入库。
                法律级红线命中即禁止导出，需先改写规避。
                <b>边界说明：</b>本工具做的是发布前自查，不替代平台审核，也不构成法律意见；变体规避写法（拼音/谐音/拆字）可能漏检。
              </div>
            </div>
          </div>
          <div className="divider" />
          <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
            <span style={{ color: 'var(--brand)', marginTop: 2 }}><Icon.chat size={16} /></span>
            <div>
              <b className="small">误报可反馈</b>
              <div className="small muted" style={{ marginTop: 3 }}>
                词库为宁可错杀的保守策略，若某词在你的语境下属误报，可在「自定义级」加入白名单或调整动作等级，
                词库会按平台规则版本持续更新。
              </div>
            </div>
          </div>
        </div>
      </Fold>
    </>
  );
}
