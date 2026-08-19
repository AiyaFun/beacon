import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { readPersona, personaCompleteness, type PersonaCard } from '@/lib/persona';
import { readFingerprint, type FingerprintItem, type StyleFingerprint } from '@/lib/style';
import { MEMORY_TYPES, platformName } from '@/lib/constants';
import { relTime } from '@/lib/format';
import { PageHead, Card, Meter, Empty, Stat } from '@/components/ui';
import { Icon } from '@/components/icons';
import { personaLearningProposals } from '@/lib/memory/optimize';
import { PersonaEditor } from './PersonaEditor';
import { MemoryEditor } from './MemoryEditor';
import { VersionHistory, type VersionRow } from './VersionHistory';
import { AccountManager } from './AccountManager';
import { StyleAnalyzeButton } from './StyleAnalyzeButton';
import { OptimizeMemoryButton } from './OptimizeMemoryButton';

export const dynamic = 'force-dynamic';

type MemoryTypeKey = keyof typeof MEMORY_TYPES;

// 置信度配色：高=绿 / 中=琥珀 / 低=灰
function confColor(c: number): string {
  if (c >= 0.7) return 'var(--green)';
  if (c >= 0.5) return 'var(--amber)';
  return 'var(--muted, #94a3b8)';
}

export default async function PersonaPage() {
  const s = await getSession();
  const [account, memories, allAccounts] = await Promise.all([
    s.accountId ? prisma.creatorAccount.findUnique({ where: { id: s.accountId } }) : null,
    // 记忆按账号隔离：当前账号的记忆 + 工作区级共享记忆（accountId 为空）
    prisma.memoryEntry.findMany({
      where: {
        workspaceId: s.workspaceId,
        OR: [{ accountId: s.accountId || null }, { accountId: null }],
      },
      orderBy: [{ active: 'desc' }, { confidence: 'desc' }, { hitCount: 'desc' }],
    }),
    prisma.creatorAccount.findMany({
      where: { workspaceId: s.workspaceId },
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { drafts: true, publishRecords: true } } },
    }),
  ]);

  const persona = readPersona(account?.personaCard ?? '{}');
  const completeness = personaCompleteness(persona);

  // 人设版本历史：PersonaVersion 此前只写不读，快照白存了一堆、回滚功能不存在。
  const versionRows: VersionRow[] = s.accountId
    ? (
        await prisma.personaVersion.findMany({
          where: { accountId: s.accountId },
          orderBy: { version: 'desc' },
          take: 20,
        })
      ).map((v) => {
        const snap = readPersona(v.snapshot);
        return {
          id: v.id,
          version: v.version,
          editedBy: v.editedBy,
          createdAt: v.createdAt.toISOString(),
          identity: snap.identity ?? '',
          audience: snap.audience ?? '',
        };
      })
    : [];
  const fingerprint = readFingerprint(account?.styleFingerprint ?? '{}');

  // F3-9 账号成长小结（规则聚合，零 LLM）：行为统计 + 生效偏好 + 完善度
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const [topicRows, draftCount, publishCount, materialCount] = s.accountId
    ? await Promise.all([
        prisma.topicIdea.findMany({ where: { accountId: s.accountId }, select: { state: true } }),
        prisma.draft.count({ where: { accountId: s.accountId } }),
        prisma.publishRecord.count({ where: { accountId: s.accountId } }),
        prisma.material.count({ where: { accountId: s.accountId } }),
      ])
    : [[] as { state: string }[], 0, 0, 0];
  const topicAccepted = topicRows.filter((t) => ['accepted', 'drafting', 'published'].includes(t.state)).length;
  const topicRejected = topicRows.filter((t) => t.state === 'rejected').length;
  const activePrefs = memories.filter((m) => m.active && (m.type === 'preference' || m.type === 'performance'));
  const memThisWeek = memories.filter((m) => new Date(m.createdAt) >= weekAgo).length;

  // 按四类记忆分区
  const memoryTypeKeys = Object.keys(MEMORY_TYPES) as MemoryTypeKey[];
  const grouped = new Map<MemoryTypeKey, typeof memories>();
  for (const k of memoryTypeKeys) grouped.set(k, []);
  for (const m of memories) {
    const k = m.type as MemoryTypeKey;
    if (grouped.has(k)) grouped.get(k)!.push(m);
  }
  const activeCount = memories.filter((m) => m.active).length;

  // 持续学习：从生效记忆里提炼「可固化进人设卡」的建议（纯规则、只提议、由用户确认）
  const proposals = personaLearningProposals(memories);

  return (
    <>
      <PageHead
        title="人设与记忆"
        desc="记忆越用越懂你的账号；数据只提议，人设你说了算"
      />

      {/* 多账号管理 */}
      <Card title="我的账号" sub={`${allAccounts.filter((a) => a.status === 'active').length} 个活跃账号`} style={{ marginBottom: 16 }}>
        <AccountManager
          accounts={allAccounts.map((a) => ({
            id: a.id,
            name: a.name,
            platform: a.platform,
            platformLabel: platformName(a.platform),
            handle: a.handle,
            status: a.status,
            isCurrent: a.id === s.accountId,
            draftCount: a._count.drafts,
            publishCount: a._count.publishRecords,
            personaScore: personaCompleteness(readPersona(a.personaCard)),
          }))}
        />
      </Card>

      {/* 人设卡 */}
      <Card
        title="人设卡"
        sub={account ? account.name : undefined}
        style={{ marginBottom: 16 }}
        action={
          <div className="row" style={{ gap: 12, alignItems: 'center' }}>
            <div className="stack" style={{ gap: 2, minWidth: 120 }}>
              <div className="row-between">
                <span className="small muted">完善度</span>
                <span className="small"><b>{completeness}%</b></span>
              </div>
              <Meter value={completeness} />
            </div>
          </div>
        }
      >
        {/* 版本历史 + 回滚：每次保存都会存快照，这里让它真的可看、可回退 */}
        <VersionHistory rows={versionRows} />
        {!account ? (
          <Empty icon="🪪" text="还没有账号资料。回到首页点『完善人设』一分钟建好。" />
        ) : (
          <div className="stack" style={{ gap: 14 }}>
            <div className="grid grid-2" style={{ gap: 14 }}>
              <PersonaLine icon="user" label="身份" value={persona.identity} />
              <PersonaLine icon="users" label="目标受众" value={persona.audience} />
              <PersonaLine icon="sparkles" label="价值主张" value={persona.valueProp} />
              <PersonaLine icon="radar" label="赛道" value={persona.niche} />
              <PersonaLine icon="chat" label="语气风格" value={persona.tone} />
            </div>

            <div className="divider" />

            <PersonaBadges label="能做" items={persona.canDo} tone="green" empty="未定义内容边界" />
            <PersonaBadges label="不能做 / 红线" items={persona.cantDo} tone="red" empty="未定义内容红线" />
            <PersonaBadges
              label="主战平台"
              items={persona.platforms.map(platformName)}
              tone="brand"
              empty="未选择平台"
            />

            <div className="divider" />
            <PersonaEditor initial={persona} />
          </div>
        )}
      </Card>

      {/* 风格指纹 */}
      <Card
        title="风格指纹"
        sub="从历史高表现内容自动提取"
        style={{ marginBottom: 16 }}
      >
        <p className="small muted" style={{ marginTop: -6, marginBottom: 12 }}>
          三层刻画你的稳定表达习惯，生成时作为隐性约束——让 AI 写出来更像你，而不是通用腔。
        </p>
        <div className="grid grid-3" style={{ gap: 12 }}>
          <FingerprintLayer title="语气层 voice" items={fingerprint.voice} tone="brand" />
          <FingerprintLayer title="结构层 format" items={fingerprint.format} tone="accent" />
          <FingerprintLayer title="选题层 topic" items={fingerprint.topic} tone="amber" />
        </div>
        <div style={{ marginTop: 12 }}>
          <StyleAnalyzeButton />
        </div>
      </Card>

      {/* F3-9 账号成长小结：规则聚合、零 LLM 成本，支撑试用留存 */}
      <Card
        title="账号成长小结"
        sub={`本周系统新记住 ${memThisWeek} 件事 · 规则聚合，不烧 AI 额度`}
        style={{ marginBottom: 16 }}
      >
        <div className="grid grid-4" style={{ gap: 12, marginBottom: 12 }}>
          <Stat label="人设完善度" value={`${completeness}%`} foot={completeness >= 75 ? '已达标' : '继续完善'} />
          <Stat label="已生效偏好" value={activePrefs.length} foot="正注入每次生成" />
          <Stat label="长期记忆" value={memories.length} foot={`本周 +${memThisWeek}`} />
          <Stat label="素材库" value={materialCount} foot="差异化原料" href="/material" />
        </div>
        <div className="grid grid-4" style={{ gap: 12, marginBottom: 14 }}>
          <Stat label="采纳选题" value={topicAccepted} foot="含创作中/已发布" href="/topics" />
          <Stat label="拒绝选题" value={topicRejected} foot="口味负反馈" href="/topics" />
          <Stat label="草稿" value={draftCount} foot="创作产出" href="/studio" />
          <Stat label="已发布" value={publishCount} foot="登记的发布" href="/data" />
        </div>
        {activePrefs.length > 0 ? (
          <>
            <div className="small muted" style={{ marginBottom: 8 }}>已生效的偏好与结论（正在注入每次生成）</div>
            <div className="stack" style={{ gap: 6 }}>
              {activePrefs.slice(0, 5).map((p) => (
                <div key={p.id} className="row" style={{ gap: 8, alignItems: 'center' }}>
                  <span className="dot dot-green" />
                  <span className="small" style={{ flex: 1 }}>{p.content}</span>
                  <span className="badge badge-gray" style={{ fontSize: 10 }}>{Math.round(p.confidence * 100)}%</span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="small muted">
            还没有生效的偏好——多用几次「采纳/拒绝选题」和对话里的显式表态，系统会开始记住你的口味。
          </div>
        )}
      </Card>

      {/* 持续学习·优化：定时自动跑 + 手动立即优化；人设改进只提议、你确认 */}
      <Card
        title="持续学习与优化"
        sub="记忆越用越准 · 每天自动优化一次，也可手动触发"
        style={{ marginBottom: 16 }}
        action={<span className="badge badge-brand"><Icon.refresh size={13} /> 去重 · 生效 · 遗忘</span>}
      >
        <div className="stack" style={{ gap: 14 }}>
          <p className="small muted" style={{ lineHeight: 1.7 }}>
            系统会持续把记忆去重合并、让反复验证的结论「生效」、给久未复验的老旧观察降权遗忘（降权不删除，可随时恢复）。
            绩效回流后自动跑一轮（每日 05:30），用最新数据反哺；也可在这里立即优化。
          </p>
          <OptimizeMemoryButton />

          <div className="divider" />
          <div className="card-title" style={{ marginBottom: 4 }}>
            人设改进建议 <span className="card-sub">数据只提议，改不改你说了算</span>
          </div>
          {proposals.length === 0 ? (
            <div className="small muted">暂无建议——记忆再多沉淀一些（采纳/拒绝选题、改稿、登记数据），系统会在这里提出可固化进人设卡的建议。</div>
          ) : (
            <div className="stack" style={{ gap: 10 }}>
              {proposals.map((p, i) => (
                <div key={i} className="card" style={{ padding: 12, boxShadow: 'none', background: 'var(--surface-2)' }}>
                  <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                    <span style={{ color: 'var(--brand)', flexShrink: 0 }}><Icon.bulb size={16} /></span>
                    <div className="stack" style={{ gap: 4 }}>
                      <span className="small"><b>{p.text}</b></span>
                      <span className="small muted">依据：{p.evidence}</span>
                    </div>
                  </div>
                </div>
              ))}
              <p className="small muted">
                想采纳？到上方<b>人设卡</b>点「编辑」把它写进对应字段即可——系统不会替你改人设。
              </p>
            </div>
          )}
        </div>
      </Card>

      {/* 长期记忆 */}
      <Card
        title="长期记忆"
        sub={`共 ${memories.length} 条 · ${activeCount} 条已生效`}
      >
        <p className="small muted" style={{ marginTop: -6, marginBottom: 14 }}>
          全程可见、可编辑、可删除。按置信度分级注入；推断类记忆需同类行为累计多次才会「生效」，单次观察只记录、不影响推荐。
        </p>

        {memories.length === 0 ? (
          <Empty icon="🧠" text="还没有记忆——采纳/拒绝选题、改稿、登记数据都会沉淀成记忆" />
        ) : (
          <div className="stack" style={{ gap: 18 }}>
            {memoryTypeKeys.map((k) => {
              const list = grouped.get(k) ?? [];
              const meta = MEMORY_TYPES[k];
              return (
                <div key={k}>
                  <div className="row" style={{ gap: 8, marginBottom: 8, alignItems: 'baseline' }}>
                    <b className="small">{meta.name}</b>
                    <span className="small muted">{meta.desc}</span>
                    <span className="badge badge-gray">{list.length}</span>
                  </div>
                  {list.length === 0 ? (
                    <div className="small muted" style={{ paddingLeft: 2 }}>暂无</div>
                  ) : (
                    <div className="stack" style={{ gap: 8 }}>
                      {list.map((m) => (
                        <div
                          key={m.id}
                          className="card"
                          style={{
                            padding: 12,
                            boxShadow: 'none',
                            background: 'var(--surface-2)',
                            opacity: m.active ? 1 : 0.62,
                          }}
                        >
                          <div className="row-between" style={{ alignItems: 'flex-start', gap: 10 }}>
                            <div style={{ flex: 1 }}>
                              <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 6 }}>
                                <span className={`dot ${m.active ? 'dot-green' : 'dot-amber'}`} />
                                {m.active ? (
                                  <span className="badge badge-green">已生效</span>
                                ) : (
                                  <span className="badge badge-gray">观察中，未生效</span>
                                )}
                                <span className="small muted">命中 {m.hitCount} 次</span>
                                <span className="small muted">· {relTime(m.updatedAt)}</span>
                              </div>
                            </div>
                          </div>
                          <MemoryEditor id={m.id} content={m.content} />
                          <div className="row" style={{ gap: 8, alignItems: 'center', marginTop: 10 }}>
                            <span className="small muted" style={{ minWidth: 44 }}>置信度</span>
                            <div style={{ flex: 1, maxWidth: 180 }}>
                              <Meter value={m.confidence} max={1} color={confColor(m.confidence)} />
                            </div>
                            <span className="small mono">{Math.round(m.confidence * 100)}%</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </>
  );
}

function PersonaLine({ icon, label, value }: { icon: keyof typeof Icon; label: string; value?: string }) {
  const IconCmp = Icon[icon];
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="row" style={{ gap: 6, color: 'var(--brand)' }}>
        <IconCmp size={14} /> <span className="small" style={{ color: 'var(--muted, #94a3b8)' }}>{label}</span>
      </div>
      <div className="small" style={{ color: value ? 'var(--text)' : 'var(--muted, #94a3b8)' }}>
        {value || '（未填写）'}
      </div>
    </div>
  );
}

function PersonaBadges({
  label,
  items,
  tone,
  empty,
}: {
  label: string;
  items: string[];
  tone: 'green' | 'red' | 'brand';
  empty: string;
}) {
  return (
    <div className="row" style={{ gap: 10, alignItems: 'baseline' }}>
      <span className="small muted" style={{ minWidth: 84 }}>{label}</span>
      {items.length === 0 ? (
        <span className="small muted">{empty}</span>
      ) : (
        <div className="wrap" style={{ gap: 6 }}>
          {items.map((it, i) => (
            <span key={i} className={`badge badge-${tone}`}>{it}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function FingerprintLayer({ title, items, tone }: { title: string; items: FingerprintItem[]; tone: string }) {
  return (
    <div className="card" style={{ padding: 12, boxShadow: 'none', background: 'var(--surface-2)' }}>
      <div className="small muted" style={{ marginBottom: 8 }}>{title}</div>
      {items.length === 0 ? (
        <span className="small muted">暂无提取</span>
      ) : (
        <div className="stack" style={{ gap: 6 }}>
          {items.map((it, i) => (
            <div key={i} className="row" style={{ gap: 8, alignItems: 'center' }}>
              <span className={`badge badge-${tone}`}>{it.tag}</span>
              <div style={{ flex: 1, height: 4, borderRadius: 2, background: 'var(--border)' }}>
                <div style={{ width: `${Math.round(it.score * 100)}%`, height: '100%', borderRadius: 2, background: `var(--${tone})` }} />
              </div>
              <span className="small muted" style={{ minWidth: 32, textAlign: 'right' }}>{Math.round(it.score * 100)}%</span>
              {it.count > 1 && <span className="small muted">×{it.count}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
