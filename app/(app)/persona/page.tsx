import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { readPersona, personaCompleteness } from '@/lib/persona';
import { readFingerprint, type FingerprintItem } from '@/lib/style';
import { MEMORY_TYPES, platformName } from '@/lib/constants';
import { relTime } from '@/lib/format';
import { Card, Meter, Empty, Stat } from '@/components/ui';
import { Icon } from '@/components/icons';
import { personaLearningProposals } from '@/lib/memory/optimize';
import { PersonaEditor } from './PersonaEditor';
import { MemoryEditor } from './MemoryEditor';
import { MemoryAddForm } from './MemoryAddForm';
import { recallForInjectionDetailed } from '@/lib/memory/core';
import { VersionHistory, type VersionRow } from './VersionHistory';
import { AccountManager } from './AccountManager';
import { StyleAnalyzeButton } from './StyleAnalyzeButton';
import { OptimizeMemoryButton } from './OptimizeMemoryButton';
import { PageTabs } from '@/components/PageTabs';
import { AssetTabs } from '@/components/AssetTabs';
import { HubHeader } from '@/components/HubHeader';
import { getServerLang } from '@/lib/i18n/server';
import { getDictionary } from '@/lib/i18n/dict';

export const dynamic = 'force-dynamic';

type MemoryTypeKey = keyof typeof MEMORY_TYPES;

function confColor(c: number): string {
  if (c >= 0.7) return 'var(--green)';
  if (c >= 0.5) return 'var(--amber)';
  return 'var(--muted, #94a3b8)';
}

export default async function PersonaPage({
  searchParams,
}: {
  searchParams: Promise<{ [k: string]: string | string[] | undefined }>;
}) {
  const s = await getSession();
  const sp = await searchParams;
  const lang = await getServerLang();
  const dict = getDictionary(lang);
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

  // 注入明细：哪些条目**真的**在每次生成里被带上。「已生效」≠「在用」——active 超过注入位时
  // 第 13 条起根本没进提示；被守卫（像注入的句子）跳过的也不进。页面必须把这三态分开说。
  const injection = await recallForInjectionDetailed(s.workspaceId, s.accountId || undefined);
  const injectedIds = new Set(injection.injected.map((e) => e.id));
  const skippedReason = new Map(injection.skipped.map((x) => [x.id, x.reason]));

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
      <HubHeader
        title={lang === 'en' ? 'Memory & Materials' : '记忆与素材'}
        hint={lang === 'en' ? 'Memory evolves with your account; suggestions from data, final persona is yours' : '记忆越用越懂你的账号；数据只提议，人设你说了算'}
        tabs={<AssetTabs active="persona" inline />}
      />

      <PageTabs
        variant="sub"
        initial={typeof sp.tab === 'string' ? sp.tab : undefined}
        tabs={[
          {
            key: 'persona',
            label: lang === 'en' ? 'Persona' : '人设',
            hint: lang === 'en' ? 'Identity & tone of voice — grounds recommendations and drafts' : '这个账号是谁、说话什么味道——推荐与初稿都以它为准',
            node: (
              <>
      <Card
        title={dict.assets.personaTitle}
        sub={account ? account.name : undefined}
        style={{ marginBottom: 16 }}
        action={
          <div className="row" style={{ gap: 12, alignItems: 'center' }}>
            <div className="stack" style={{ gap: 2, minWidth: 120 }}>
              <div className="row-between">
                <span className="small muted">{lang === 'en' ? 'Completeness' : '完善度'}</span>
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
          <Empty icon="🪪" text={lang === 'en' ? 'No account profile yet. Return home and click "Complete Persona" to set up in 1 minute.' : '还没有账号资料。回到首页点『完善人设』一分钟建好。'} />
        ) : (
          <div className="stack" style={{ gap: 14 }}>
            <div className="grid grid-2" style={{ gap: 14 }}>
              <PersonaLine icon="user" label={lang === 'en' ? 'Identity' : '身份'} value={persona.identity} emptyText={lang === 'en' ? '(Not set)' : '（未填写）'} />
              <PersonaLine icon="users" label={lang === 'en' ? 'Target Audience' : '目标受众'} value={persona.audience} emptyText={lang === 'en' ? '(Not set)' : '（未填写）'} />
              <PersonaLine icon="sparkles" label={lang === 'en' ? 'Value Proposition' : '价值主张'} value={persona.valueProp} emptyText={lang === 'en' ? '(Not set)' : '（未填写）'} />
              <PersonaLine icon="radar" label={lang === 'en' ? 'Niche' : '赛道'} value={persona.niche} emptyText={lang === 'en' ? '(Not set)' : '（未填写）'} />
              <PersonaLine icon="chat" label={lang === 'en' ? 'Tone & Style' : '语气风格'} value={persona.tone} emptyText={lang === 'en' ? '(Not set)' : '（未填写）'} />
            </div>

            <div className="divider" />

            <PersonaBadges label={lang === 'en' ? 'Can Do' : '能做'} items={persona.canDo} tone="green" empty={lang === 'en' ? 'No boundaries defined' : '未定义内容边界'} />
            <PersonaBadges label={lang === 'en' ? "Can't Do / Guardrails" : '不能做 / 红线'} items={persona.cantDo} tone="red" empty={lang === 'en' ? 'No guardrails defined' : '未定义内容红线'} />
            <PersonaBadges
              label={lang === 'en' ? 'Core Platforms' : '主战平台'}
              items={persona.platforms.map((p) => platformName(p))}
              tone="brand"
              empty={lang === 'en' ? 'No platform selected' : '未选择平台'}
            />

            <div className="divider" />
            <PersonaEditor initial={persona} />
          </div>
        )}
      </Card>

      {/* 风格指纹 */}
      <Card
        title={lang === 'en' ? 'Style Fingerprint' : '风格指纹'}
        sub={lang === 'en' ? 'Extracted automatically from top-performing content' : '从历史高表现内容自动提取'}
        style={{ marginBottom: 16 }}
      >
        <p className="small muted" style={{ marginTop: -6, marginBottom: 12 }}>
          {lang === 'en'
            ? 'Captures your consistent expression habits across 3 dimensions as implicit generation constraints.'
            : '三层刻画你的稳定表达习惯，生成时作为隐性约束——让 AI 写出来更像你，而不是通用腔。'}
        </p>
        <div className="grid grid-3" style={{ gap: 12 }}>
          <FingerprintLayer title={lang === 'en' ? 'Voice Layer' : '语气层 voice'} items={fingerprint.voice} tone="brand" lang={lang} />
          <FingerprintLayer title={lang === 'en' ? 'Format Layer' : '结构层 format'} items={fingerprint.format} tone="accent" lang={lang} />
          <FingerprintLayer title={lang === 'en' ? 'Topic Layer' : '选题层 topic'} items={fingerprint.topic} tone="amber" lang={lang} />
        </div>
        <div style={{ marginTop: 12 }}>
          <StyleAnalyzeButton />
        </div>
      </Card>

      {/* F3-9 账号成长小结：规则聚合、零 LLM 成本，支撑试用留存 */}
              </>
            ),
          },
          {
            key: 'memory',
            label: lang === 'en' ? 'Memory' : '记忆',
            hint: lang === 'en' ? 'What AI has learned from your edits and data' : '系统从你的修改与数据里记住的东西：记住了什么、这周新记了什么、怎么优化',
            node: (
              <>
      <Card
        title={lang === 'en' ? 'Long-term Memory' : '长期记忆'}
        sub={lang === 'en' ? `${memories.length} total · ${activeCount} active · ${injection.limit} injection slots, ${injection.injected.length} used this run` : `共 ${memories.length} 条 · ${activeCount} 条已生效 · 注入位 ${injection.limit}，本次带上 ${injection.injected.length} 条`}
      >
        <p className="small muted" style={{ marginTop: -6, marginBottom: 10 }}>
          {lang === 'en'
            ? `Fully visible, editable, and deletable. Inferred memories require repeated observations before becoming active; active memories queue by "confidence × time decay". Only the top ${injection.limit} are injected per generation (marked "In Use"); others wait in queue. Prompt-injection-like entries are skipped with explanation.`
            : `全程可见、可编辑、可删除。推断类记忆需同类行为累计多次才会「生效」；生效的按「置信度 × 时间衰减」排队，每次生成只带前 ${injection.limit} 条（标「在用」），其余标「排队中」。长得像指令的条目会被跳过，也会说破。`}
        </p>
        <div style={{ marginBottom: 14 }}><MemoryAddForm /></div>

        {memories.length === 0 ? (
          <Empty icon="🧠" text={lang === 'en' ? 'No memories yet — adopted/rejected topics, edits, and recorded data will crystallize into memories' : '还没有记忆——采纳/拒绝选题、改稿、登记数据都会沉淀成记忆'} />
        ) : (
          <div className="stack" style={{ gap: 18 }}>
            {memoryTypeKeys.map((k) => {
              const list = grouped.get(k) ?? [];
              const meta = MEMORY_TYPES[k];
              return (
                <div key={k}>
                  <div className="row" style={{ gap: 8, marginBottom: 8, alignItems: 'baseline' }}>
                    <b className="small">{lang === 'en' ? meta.nameEn : meta.name}</b>
                    <span className="small muted">{lang === 'en' ? meta.descEn : meta.desc}</span>
                    <span className="badge badge-gray">{list.length}</span>
                  </div>
                  {list.length === 0 ? (
                    <div className="small muted" style={{ paddingLeft: 2 }}>{lang === 'en' ? 'None yet' : '暂无'}</div>
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
                                  <span className="badge badge-green">{lang === 'en' ? 'Active' : '已生效'}</span>
                                ) : (
                                  <span className="badge badge-gray">{lang === 'en' ? 'Observing, Inactive' : '观察中，未生效'}</span>
                                )}
                                {skippedReason.has(m.id) ? (
                                  <span className="badge badge-red" title={lang === 'en' ? `Guardrail decision: ${skippedReason.get(m.id)}. Convert to declarative sentence to restore injection` : `守卫判定：${skippedReason.get(m.id)}。改成陈述句就会恢复注入`}>{lang === 'en' ? 'Skipped · Instruction-like' : '被跳过·像指令'}</span>
                                ) : injectedIds.has(m.id) ? (
                                  <span className="badge badge-blue" title={lang === 'en' ? 'This entry is injected into the system prompt of every generation' : '这条会带进每次生成的系统提示'}>{lang === 'en' ? 'In Use' : '在用'}</span>
                                ) : m.active ? (
                                  <span className="badge badge-gray" title={lang === 'en' ? `Only ${injection.limit} injection slots available; queued by confidence × time decay. Currently waiting.` : `注入位只有 ${injection.limit} 个，按置信度×时间衰减排队，这条暂时没排进去`}>{lang === 'en' ? 'Queued' : '排队中'}</span>
                                ) : null}
                                <span className="small muted">{lang === 'en' ? `Hit ${m.hitCount} time${m.hitCount > 1 ? 's' : ''}` : `命中 ${m.hitCount} 次`}</span>
                                <span className="small muted">· {relTime(m.updatedAt)}</span>
                              </div>
                            </div>
                          </div>
                          <MemoryEditor id={m.id} content={m.content} />
                          <div className="row" style={{ gap: 8, alignItems: 'center', marginTop: 10 }}>
                            <span className="small muted" style={{ minWidth: 44 }}>{lang === 'en' ? 'Confidence' : '置信度'}</span>
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
      <Card
        title={lang === 'en' ? 'Account Growth Summary' : '账号成长小结'}
        sub={lang === 'en' ? `${memThisWeek} new memories learned this week · Rule-based aggregation, zero AI cost` : `本周系统新记住 ${memThisWeek} 件事 · 规则聚合，不烧 AI 额度`}
        style={{ marginBottom: 16 }}
      >
        <div className="grid grid-4" style={{ gap: 12, marginBottom: 12 }}>
          <Stat label={lang === 'en' ? 'Persona Completeness' : '人设完善度'} value={`${completeness}%`} foot={completeness >= 75 ? (lang === 'en' ? 'Qualified' : '已达标') : (lang === 'en' ? 'Keep refining' : '继续完善')} />
          <Stat label={lang === 'en' ? 'In-Use Memories' : '在用记忆'} value={injection.injected.length} foot={lang === 'en' ? `${injection.limit} slots · ${activeCount} active` : `注入位 ${injection.limit} · 已生效 ${activeCount}`} />
          <Stat label={lang === 'en' ? 'Long-term Memory' : '长期记忆'} value={memories.length} foot={lang === 'en' ? `+${memThisWeek} this week` : `本周 +${memThisWeek}`} />
          <Stat label={lang === 'en' ? 'Material Library' : '素材库'} value={materialCount} foot={lang === 'en' ? 'Distinctive materials' : '差异化原料'} href="/material" />
        </div>
        <div className="grid grid-4" style={{ gap: 12, marginBottom: 14 }}>
          <Stat label={lang === 'en' ? 'Adopted Topics' : '采纳选题'} value={topicAccepted} foot={lang === 'en' ? 'Drafting / Published' : '含创作中/已发布'} href="/topics" />
          <Stat label={lang === 'en' ? 'Rejected Topics' : '拒绝选题'} value={topicRejected} foot={lang === 'en' ? 'Taste negative feedback' : '口味负反馈'} href="/topics" />
          <Stat label={lang === 'en' ? 'Drafts' : '草稿'} value={draftCount} foot={lang === 'en' ? 'Creative output' : '创作产出'} href="/studio" />
          <Stat label={lang === 'en' ? 'Published' : '已发布'} value={publishCount} foot={lang === 'en' ? 'Recorded publishes' : '登记的发布'} href="/data" />
        </div>
        {activePrefs.length > 0 ? (
          <>
            <div className="small muted" style={{ marginBottom: 8 }}>{lang === 'en' ? 'Active preferences & insights (Queued by confidence into injection slots; only "In Use" are actually injected):' : '已生效的偏好与结论（按置信度排队进注入位，标「在用」的才真带进生成）'}</div>
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
            {lang === 'en' ? 'No active preferences yet — adopt/reject topics or express explicit preferences in chat to build your taste profile.' : '还没有生效的偏好——多用几次「采纳/拒绝选题」和对话里的显式表态，系统会开始记住你的口味。'}
          </div>
        )}
      </Card>

      {/* 持续学习·优化：定时自动跑 + 手动立即优化；人设改进只提议、你确认 */}
      <Card
        title={lang === 'en' ? 'Continuous Learning & Optimization' : '持续学习与优化'}
        sub={lang === 'en' ? 'Memories grow sharper with use · Automated daily at 05:30, or trigger manually' : '记忆越用越准 · 每天自动优化一次，也可手动触发'}
        style={{ marginBottom: 16 }}
        action={<span className="badge badge-brand"><Icon.refresh size={13} /> {lang === 'en' ? 'Dedupe · Activate · Forget' : '去重 · 生效 · 遗忘'}</span>}
      >
        <div className="stack" style={{ gap: 14 }}>
          <p className="small muted" style={{ lineHeight: 1.7 }}>
            {lang === 'en'
              ? 'The system continuously deduplicates and merges memories, activates repeatedly verified insights, and decays unverified observations (decayed memories are not deleted and can be restored). Automatically triggered after performance backfill (daily at 05:30) to feed back fresh data; or optimize immediately here.'
              : '系统会持续把记忆去重合并、让反复验证的结论「生效」、给久未复验的老旧观察降权遗忘（降权不删除，可随时恢复）。绩效回流后自动跑一轮（每日 05:30），用最新数据反哺；也可在这里立即优化。'}
          </p>
          <OptimizeMemoryButton />

          <div className="divider" />
          <div className="card-title" style={{ marginBottom: 4 }}>
            {lang === 'en' ? 'Persona Improvement Proposals ' : '人设改进建议 '}<span className="card-sub">{lang === 'en' ? 'Data only suggests; you decide what changes' : '数据只提议，改不改你说了算'}</span>
          </div>
          {proposals.length === 0 ? (
            <div className="small muted">{lang === 'en' ? 'No suggestions yet — as more memories accumulate (adopting/rejecting topics, drafting, registering data), proposals to solidify into your persona card will appear here.' : '暂无建议——记忆再多沉淀一些（采纳/拒绝选题、改稿、登记数据），系统会在这里提出可固化进人设卡的建议。'}</div>
          ) : (
            <div className="stack" style={{ gap: 10 }}>
              {proposals.map((p, i) => (
                <div key={i} className="card" style={{ padding: 12, boxShadow: 'none', background: 'var(--surface-2)' }}>
                  <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                    <span style={{ color: 'var(--brand)', flexShrink: 0 }}><Icon.bulb size={16} /></span>
                    <div className="stack" style={{ gap: 4 }}>
                      <span className="small"><b>{p.text}</b></span>
                      <span className="small muted">{lang === 'en' ? 'Basis: ' : '依据：'}{p.evidence}</span>
                    </div>
                  </div>
                </div>
              ))}
              <p className="small muted">
                {lang === 'en' ? 'Want to adopt? Click "Edit" on the Persona Card above and add it to the corresponding field — the system will not modify your persona for you.' : '想采纳？到上方人设卡点「编辑」把它写进对应字段即可——系统不会替你改人设。'}
              </p>
            </div>
          )}
        </div>
      </Card>

      {/* 长期记忆 */}
              </>
            ),
          },
          {
            key: 'accounts',
            label: lang === 'en' ? 'Accounts' : '账号管理',
            hint: lang === 'en' ? 'Creator accounts in this workspace: create, switch, merge, archive' : '这个工作区里的创作账号：新建、切换、合并、归档',
            node: (
              <>
      {/* 多账号管理 */}
      <Card
        title={lang === 'en' ? 'My Accounts' : '我的账号'}
        sub={lang === 'en' ? `${allAccounts.filter((a) => a.status === 'active').length} active accounts` : `${allAccounts.filter((a) => a.status === 'active').length} 个活跃账号`}
        style={{ marginBottom: 16 }}
      >
        <AccountManager
          accounts={allAccounts.map((a) => ({
            id: a.id,
            name: (lang === 'en' && (a.name === '我的账号' || !a.name)) ? 'My Account' : a.name,
            platform: a.platform,
            platformLabel: platformName(a.platform, lang),
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
              </>
            ),
          },
        ]}
      />

    </>
  );
}

function PersonaLine({ icon, label, value, emptyText }: { icon: keyof typeof Icon; label: string; value?: string; emptyText?: string }) {
  const IconCmp = Icon[icon];
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="row" style={{ gap: 6, color: 'var(--brand)' }}>
        <IconCmp size={14} /> <span className="small" style={{ color: 'var(--muted, #94a3b8)' }}>{label}</span>
      </div>
      <div className="small" style={{ color: value ? 'var(--text)' : 'var(--muted, #94a3b8)' }}>
        {value || emptyText || '（未填写）'}
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

function FingerprintLayer({ title, items, tone, lang }: { title: string; items: FingerprintItem[]; tone: string; lang?: string }) {
  return (
    <div className="card" style={{ padding: 12, boxShadow: 'none', background: 'var(--surface-2)' }}>
      <div className="small muted" style={{ marginBottom: 8 }}>{title}</div>
      {items.length === 0 ? (
        <span className="small muted">{lang === 'en' ? 'None extracted' : '暂无提取'}</span>
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
