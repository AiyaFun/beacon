import Link from 'next/link';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { platformName, platformColor } from '@/lib/constants';
import { relTime } from '@/lib/format';
import { Card, Empty } from '@/components/ui';
import { Icon } from '@/components/icons';
import { listInstalledSkills } from '@/lib/skills';
import { Rewriter } from './Rewriter';
import { ExportButtons } from './ExportButtons';
import { CardExport } from './CardExport';
import { SkillPanel } from './SkillPanel';
import { CopyText } from '@/components/CopyText';
import { PublishForm } from './PublishForm';
import { PublishPlanPanel } from './PublishPlanPanel';
import { DraftAdvisorCard } from './DraftAdvisorCard';
import { NewDraftDialog } from './NewDraftDialog';
import { DraftButton } from './DraftButton';
import { TitleCoverPanel } from './TitleCoverPanel';
import { IllustrationPanel } from './IllustrationPanel';
import { CoverJumpButton } from './CoverJumpButton';
import type { CoverQuota } from './CoverStation';
import { imageConfigured, imageSource } from '@/lib/llm/image';
import { listLibrary, listDraftCovers, listDraftIllustrations, coverCountsByDraft } from '@/lib/media/store';
import { COVER_STYLES } from '@/lib/cover/styles';
import { getImageQuotaStatus } from '@/lib/quota';
import { readPersona } from '@/lib/persona';
import { DeriveCard } from './DeriveCard';
import { DraftList, type DraftRow } from './DraftList';
import { StudioTabs, type StudioTab } from './StudioTabs';
import { VersionCompare } from './VersionCompare';
import { draftFamily } from '@/lib/studio/family';
import { shouldHintWechatAiSource } from '@/lib/algorithm/ai-source';
import { MakeTabs } from '@/components/MakeTabs';
import { HubHeader } from '@/components/HubHeader';
import { getServerLang } from '@/lib/i18n/server';
import { getDictionary } from '@/lib/i18n/dict';

export const dynamic = 'force-dynamic';

const STATUS_LABEL: Record<string, { zh: string; en: string; cls: string }> = {
  editing: { zh: '编辑中', en: 'Editing', cls: 'badge-gray' },
  checking: { zh: '合规检测中', en: 'Checking', cls: 'badge-amber' },
  ready: { zh: '待发布', en: 'Ready', cls: 'badge-green' },
  published: { zh: '已发布', en: 'Published', cls: 'badge-brand' },
  abandoned: { zh: '已搁置', en: 'Shelved', cls: 'badge-gray' },
};

function statusOf(status: string) {
  const item = STATUS_LABEL[status];
  if (!item) return { text: status, cls: 'badge-gray' };
  return { text: item.zh, cls: item.cls };
}

export default async function StudioPage({
  searchParams,
}: {
  searchParams: Promise<{ draft?: string; topicId?: string; tab?: string }>;
}) {
  const s = await getSession();
  const sp = await searchParams;
  const lang = await getServerLang();
  const dict = getDictionary(lang);

  // 技能列表在 server 端算好再传下去：客户端只拿列表，不碰 prisma
  // （导出不再需要「有没有 Claude Key」这个布尔——两种格式都有本地渲染器，永远可点）
  const [drafts, skills, materials, ownedAccounts] = await Promise.all([
    prisma.draft.findMany({
      where: { accountId: s.accountId },
      include: {
        topic: true,
        versions: { orderBy: { seq: 'desc' } },
      },
      orderBy: { updatedAt: 'desc' },
    }),
    listInstalledSkills(s.tenantId),
    // 技能参数卡里「这篇要用哪几条素材」的候选。只取内容类（口头禅是语气资产、文风样本是给
    // 原句注入用的，都不该出现在「引用哪条素材」的勾选列表里）。
    prisma.material.findMany({
      where: { accountId: s.accountId, type: { in: ['experience', 'case', 'opinion'] } },
      orderBy: { updatedAt: 'desc' },
      take: 12,
      select: { id: true, type: true, content: true },
    }),
    // 派生卡那条「你缺一个公众号」提示的判据。按 workspaceId 取（账号是工作区级的，
    // 不是当前 accountId 级）——判的是「这个人手上有哪些平台的号」，不是「他现在在哪个号下」。
    prisma.creatorAccount.findMany({
      where: { workspaceId: s.workspaceId },
      select: { platform: true },
    }),
  ]);

  // 从选题引擎「去工坊起这篇稿」带过来的选题。此前这个参数没人接：点过来只是跳到工坊首页，
  // 选题上下文当场丢掉，用户得自己回想刚才采纳的是哪条。
  const fromTopic = sp.topicId
    ? await prisma.topicIdea.findFirst({
        where: { id: sp.topicId, accountId: s.accountId },
        select: { id: true, title: true, angle: true },
      })
    : null;
  // 已经起过稿就直接定位过去；还没有就把 topicId 交给「AI 生成初稿」按钮。
  // **不在页面加载时替他生成**——那是一次真实调用要花额度，必须他自己点。
  const topicDraft = fromTopic ? drafts.find((d) => d.topicId === fromTopic.id) : undefined;
  const pendingTopic = fromTopic && !topicDraft ? fromTopic : null;

  const selectedId = sp.draft && drafts.some((d) => d.id === sp.draft)
    ? sp.draft
    : (topicDraft?.id ?? drafts[0]?.id);
  // W-6：这篇草稿的会诊场次与其中已采纳的意见数（决定「按已采纳意见改一版」是否可点）
  const [draftSessionCount, draftAdoptedCount] = selectedId
    ? await Promise.all([
        prisma.advisorSession.count({ where: { accountId: s.accountId, draftRef: selectedId } }),
        prisma.advisorOpinion.count({
          where: { adopted: true, session: { accountId: s.accountId, draftRef: selectedId } },
        }),
      ])
    : [0, 0];
  const selected = drafts.find((d) => d.id === selectedId) ?? null;
  // 同源稿件家族（一稿多平台）：只有选中草稿时才查
  const family = selectedId ? await draftFamily(s.accountId, selectedId) : [];

  // 封面工位要的三样：能不能生图 / 今日还能出几张 / 人设赛道（给风格排序）。
  // 都在服务端算好传下去——客户端组件不碰 prisma，也别让「今日剩余」靠前端猜。
  const [coverConfigured, coverSource, coverAccount] = await Promise.all([
    imageConfigured(s.tenantId),
    imageSource(s.tenantId),
    prisma.creatorAccount.findUnique({ where: { id: s.accountId }, select: { personaCard: true } }),
  ]);
  const imageQuota = coverConfigured && coverSource ? await getImageQuotaStatus(s.tenantId, coverSource) : null;
  // 形象库 / 本稿封面 / 家族里每篇出没出过封面：都在服务端算好传下去（客户端组件不碰 prisma）
  const [coverLibrary, draftCovers, familyCoverCounts, stylePresets, illustrations] = await Promise.all([
    listLibrary(s.workspaceId, s.accountId),
    selectedId ? listDraftCovers(s.workspaceId, selectedId) : Promise.resolve([]),
    coverCountsByDraft(s.workspaceId, family.map((f) => f.draftId)),
    prisma.coverStylePreset.findMany({
      where: { workspaceId: s.workspaceId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, name: true, description: true },
    }),
    selectedId ? listDraftIllustrations(s.workspaceId, selectedId) : Promise.resolve([]),
  ]);
  // 配图卡片只要展示用的几项，meta 里的提示词不往客户端传（那是给模型看的，且很长）
  const draftIllustrations = illustrations.map((i) => ({
    id: i.id,
    url: i.url,
    scene: typeof i.meta.scene === 'string' ? i.meta.scene : '',
    anchor: typeof i.meta.anchor === 'string' ? i.meta.anchor : undefined,
    aigcEmbedded: i.meta.aigcEmbedded !== false,
  }));
  const coverQuota: CoverQuota = {
    configured: coverConfigured,
    remaining: imageQuota?.remaining ?? 0,
    cap: imageQuota?.cap ?? 0,
    source: coverSource,
  };
  const coverPersona = readPersona(coverAccount?.personaCard ?? '{}');
  const personaForCover = [coverPersona.niche, coverPersona.tone, coverPersona.identity, coverPersona.audience]
    .filter(Boolean)
    .join(' ');
  const versionsAsc = selected ? [...selected.versions].sort((a, b) => a.seq - b.seq) : [];
  const latest = selected?.versions[0]; // versions 已按 seq desc
  const selectedStatus = selected ? statusOf(selected.status) : null;

  // 版本对比要拿全文（diff 在浏览器里算），所以只下发最近 10 版——正文动辄几千字，
  // 一份 30 版的稿子全下发就是几百 KB 的 RSC 载荷，而没人会去比第 1 版和第 27 版。
  const COMPARE_LIMIT = 10;
  const compareVersions = versionsAsc.slice(-COMPARE_LIMIT).map((v) => ({
    seq: v.seq,
    authorType: v.authorType,
    content: v.content,
    timeLabel: relTime(v.createdAt),
  }));

  // 列表用的行数据在服务端摊平：客户端组件不该拿到整个 Prisma 模型，
  // 相对时间也必须在这里算好（客户端读 Date.now() 会 hydration 不一致）。
  const draftRows: DraftRow[] = drafts.map((d) => {
    const st = statusOf(d.status);
    return {
      id: d.id,
      title: d.title,
      status: d.status,
      statusText: st.text,
      statusCls: st.cls,
      platformName: platformName(d.platform),
      platformColor: platformColor(d.platform),
      versionCount: d.versions.length,
      lastLabel: d.versions[0] ? relTime(d.versions[0].createdAt) : '—',
    };
  });

  // 下半区四件事：互斥，做完一件再做下一件，所以是标签页而不是四张常驻卡片。
  const tabs: StudioTab[] = [
    {
      key: 'skill',
      label: '技能出成品',
      hint: (
        <>
          点技能，把当前草稿正文变成对应平台的排版成品（公众号排版、小红书图文卡…）。
          技能永远基于<b>最新一版</b>正文运行；展开「本次要求」可指定篇幅、语气和这篇要用上的素材。
        </>
      ),
      node: (
        <SkillPanel
          draftId={selected?.id}
          skills={skills}
          draftPlatform={selected?.platform}
          materials={materials}
        />
      ),
    },
    {
      key: 'title',
      label: '标题与封面',
      hint: (
        <>
          <b>封面</b>：比例按草稿平台自动定，大字默认用你采纳的标题（留空则从正文提炼），可上传自己的照片「主体保真」，出图即带 AI 生成标识。
          <b>标题矩阵</b>：一次给 6 个<b>角度互不相同</b>的标题，每条附诊断，命中红线的直接拦下；任一条可一键作封面大字。
        </>
      ),
      node: (
        <TitleCoverPanel
          draftId={selected?.id}
          platform={selected?.platform}
          draftTitle={selected?.title}
          hasContent={!!latest?.content?.trim()}
          personaText={personaForCover}
          defaultStyleKey={coverPersona.coverStyle}
          defaultFontKey={coverPersona.coverFont}
          quota={coverQuota}
          library={coverLibrary}
          covers={draftCovers}
          coverAssetId={selected?.coverAssetId ?? null}
          stylePresets={stylePresets}
        />
      ),
    },
    {
      key: 'illustration',
      label: '正文配图',
      hint: (
        <>
          从正文拆出一组画面，风格统一地出图——小红书组图、公众号内页插图都用它。
          先拆画面给你改，确认后再出图（出图按张计费）。配图<b>不上字</b>，文字排版走「标题与封面」。
          手头没有稿子、就是想要几张图，去 <Link href="/images">AI 出图</Link>（同一套额度与保留期）。
        </>
      ),
      node: (
        <IllustrationPanel
          draftId={selected?.id}
          platform={selected?.platform}
          styles={COVER_STYLES.map((st) => ({ key: st.key, name: st.name, hint: st.hint }))}
          existing={draftIllustrations}
        />
      ),
    },
    {
      key: 'derive',
      label: '一稿多平台',
      badge: family.length > 1 ? family.length : undefined,
      hint: '同一篇内容派生出各平台版本，各自独立发布与回流，之后就能比较谁跑得好。',
      node: (
        <DeriveCard
          draftId={selected?.id}
          currentPlatform={selected?.platform}
          family={family}
          coverCounts={familyCoverCounts}
          wechatHint={shouldHintWechatAiSource(ownedAccounts.map((a) => a.platform))}
        />
      ),
    },
  ];
  if (selected) {
    tabs.push({
      key: 'advisor',
      label: lang === 'en' ? 'Draft Review' : '草稿会诊',
      badge: draftAdoptedCount || undefined,
      node: (
        <DraftAdvisorCard
          draftId={selected.id}
          adoptedCount={draftAdoptedCount}
          sessionCount={draftSessionCount}
        />
      ),
    });
  }

  return (
    <>
      <HubHeader
        title={dict.tabs.makeTitle}
        hint={lang === 'en' ? 'AI drafting · Version history · Multi-platform rewriter · Pre-publish compliance checks' : 'AI 起草 · 版本留痕 · 多平台改写 · 发布前合规。AI 初稿和你改后终稿的差异，系统会从中学你的口味。'}
        tabs={<MakeTabs active="write" inline />}
        action={
          <span className="row wrap" style={{ gap: 8, justifyContent: 'flex-end' }}>
            <NewDraftDialog defaultPlatform={selected?.platform} />
            {!pendingTopic && <DraftButton draftId={selectedId ?? null} />}
          </span>
        }
      />

      {fromTopic && (
        <div
          className="card"
          style={{
            marginBottom: 16,
            padding: '12px 16px',
            background: 'var(--surface-2)',
            boxShadow: 'none',
            borderLeft: '3px solid var(--brand)',
          }}
        >
          <div className="row-between wrap" style={{ gap: 12, alignItems: 'center' }}>
            <div className="stack" style={{ gap: 4, minWidth: 0 }}>
              <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
                <span className="badge badge-brand">{lang === 'en' ? 'From Topic Engine' : '来自选题引擎'}</span>
                <b className="small">{fromTopic.title}</b>
                {topicDraft && <span className="small muted">{lang === 'en' ? 'Draft already started for this topic' : '这条已经起过稿，已为你定位到它'}</span>}
              </div>
              {pendingTopic?.angle && (
                <div className="small muted">{lang === 'en' ? 'Angle: ' : '切入角：'}{pendingTopic.angle}</div>
              )}
            </div>
            {pendingTopic && <DraftButton draftId={null} topicId={pendingTopic.id} />}
          </div>
        </div>
      )}

      <div className="grid-asym-left grid-align-start" style={{ gap: 20 }}>
        <div className="stack" style={{ gap: 16 }}>
          <Card title={dict.studio.draftListTitle} sub={lang === 'en' ? `${drafts.length} drafts` : `${drafts.length} 篇`}>
            <DraftList
              drafts={draftRows}
              selectedId={selectedId}
              emptyText={
                pendingTopic
                  ? (lang === 'en' ? 'No drafts yet — click "AI Generate Draft" above to start.' : '还没有草稿——点上面那条横幅里的「AI 生成初稿」，就按带过来的这条选题起一版')
                  : (lang === 'en' ? 'No drafts yet — click "AI Generate Draft" in the top right to start from an accepted topic.' : '还没有草稿——点右上角「AI 生成初稿」，基于已采纳的选题起一版')
              }
            />
          </Card>

          <Card
            title="版本时间线"
            sub={selected ? selected.title : undefined}
            action={
              latest ? (
                <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
                  <span className="small muted">共 {selected!.versions.length} 版</span>
                  <VersionCompare versions={compareVersions} draftId={selected?.id} />
                </div>
              ) : undefined
            }
          >
            {!selected ? (
              <Empty icon="🕮" text="选中草稿查看版本演进" />
            ) : versionsAsc.length === 0 ? (
              <Empty icon="🕮" text="还没有版本，点「AI 生成初稿」生成第一版" />
            ) : (
              <div className="stack" style={{ gap: 0 }}>
                {versionsAsc.map((v, i) => {
                  const isAi = v.authorType === 'ai';
                  const prev = i > 0 ? versionsAsc[i - 1] : null;
                  const isLast = i === versionsAsc.length - 1;
                  return (
                    <div key={v.id} className="row" style={{ gap: 10, alignItems: 'stretch' }}>
                      {/* 时间轴竖线 */}
                      <div className="col" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 16 }}>
                        <span className={`dot ${isAi ? 'dot-amber' : 'dot-green'}`} style={{ marginTop: 6 }} />
                        {!isLast && <span style={{ flex: 1, width: 2, background: 'var(--border)' }} />}
                      </div>
                      <div style={{ flex: 1, minWidth: 0, paddingBottom: isLast ? 0 : 14 }}>
                        <div className="row wrap" style={{ gap: 6, alignItems: 'center' }}>
                          <span className="badge badge-gray">v{v.seq}</span>
                          <span className={`badge ${isAi ? 'badge-amber' : 'badge-green'}`}>
                            {isAi ? 'AI 初稿' : '人工终稿'}
                          </span>
                          <span className="small muted" style={{ fontSize: 11 }}>{relTime(v.createdAt)}</span>
                        </div>
                        {v.diffFromPrev && (
                          <div className="small" style={{ marginTop: 4, fontSize: 11, color: prev && prev.authorType !== v.authorType ? 'var(--brand)' : 'var(--muted)' }}>
                            <Icon.arrow size={11} /> {v.diffFromPrev}
                            {prev && prev.authorType === 'ai' && v.authorType === 'human' && (
                              <span className="badge badge-brand" style={{ marginLeft: 4, fontSize: 10 }} title="系统对比 AI 初稿与改后终稿学习偏好">已学偏好</span>
                            )}
                          </div>
                        )}
                        {/* 正文预览默认只展开最新一版：每条 160 字的预览块约 80px，
                            十几版之后这一栏就是一条几百像素长、谁也不看的灰带。
                            用原生 details 折叠，不引入 JS，也不影响服务端渲染。 */}
                        <details open={isLast} style={{ marginTop: 6 }}>
                          <summary className="small muted ver-toggle" style={{ fontSize: 11 }}>
                            正文预览
                          </summary>
                          <div
                            className="small muted"
                            style={{
                              marginTop: 4,
                              whiteSpace: 'pre-wrap',
                              maxHeight: 96,
                              overflow: 'hidden',
                              padding: '8px 10px',
                              background: 'var(--surface-2)',
                              borderRadius: 6,
                              lineHeight: 1.5,
                              fontSize: 12,
                            }}
                          >
                            {v.content.slice(0, 160)}
                            {v.content.length > 160 ? '…' : ''}
                          </div>
                        </details>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </div>

        {/* 右栏（1fr，约 70% 宽主工作台）：当前草稿 → 写 → 出成品 */}
        <div className="stack" style={{ gap: 20 }}>
          {/* 当前草稿条：正在编辑哪一篇 + 这篇写完之后的全部出口。
              这些动作原来全挤在页头，跟「新建 / 起草」混在一排 8 个同权重按钮里；
              它们其实都属于某一份草稿，放在草稿身份旁边才对得上号。 */}
          {selected ? (
            <div className="card" style={{ padding: '14px 18px' }}>
              <div className="row wrap" style={{ gap: 8, alignItems: 'center', minWidth: 0 }}>
                <span className="badge" style={{ background: 'var(--surface-2)', color: platformColor(selected.platform) }}>
                  {platformName(selected.platform)}
                </span>
                <b style={{ fontSize: 14.5, letterSpacing: '-0.2px' }}>{selected.title}</b>
                {selectedStatus && <span className={`badge ${selectedStatus.cls}`}>{selectedStatus.text}</span>}
                <span className="small muted">
                  共 {selected.versions.length} 版 · 更新 {relTime(selected.updatedAt)}
                </span>
              </div>
              <div className="divider" style={{ margin: '12px 0 10px' }} />
              <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
                <span className="small muted" style={{ marginRight: 2 }}>写完之后</span>
                {latest?.content && (
                  <>
                    <CopyText text={`${selected.title}\n\n${latest.content}`} label="复制发布包" />
                    <CopyText text={latest.content} label="复制正文" />
                  </>
                )}
                <PublishPlanPanel draftId={selected.id} />
                <PublishForm draftId={selected.id} />
                <ExportButtons draftId={selected.id} />
                <CardExport draftId={selected.id} />
                <CoverJumpButton />
              </div>
            </div>
          ) : (
            <div className="card" style={{ padding: '14px 18px' }}>
              <div className="small muted">
                还没有选中草稿。左边点一篇，或用右上角「新建草稿 / AI 生成初稿」开一篇新的
                ——复制、导出、登记发布都会出现在这里。
              </div>
            </div>
          )}

          <Card
            title="正文编辑 · 算法教练"
            sub="边写边诊断，按平台算法实时优化"
            action={
              <span className="small muted">
                实时诊断开头钩子 / 篇幅 / 结构 / 互动引导，结合账号真实回流数据；零 AI 额度
              </span>
            }
          >
            {/* key 必须绑草稿：不绑的话切换草稿只换 props，Rewriter 的 text state 原样留着
                ——左边点开 B 稿，编辑框里还是 A 稿的正文，此时点「保存我的修改」
                就把 A 的内容写成了 B 的新版本。这是不会报错、只会悄悄写坏数据的那种 bug。
                重挂也正好让本地暂存的恢复检查按新草稿重跑一次。 */}
            <Rewriter
              key={selected?.id ?? 'none'}
              draftId={selected?.id}
              initialText={latest?.content ?? ''}
              draftTitle={selected?.title}
              initialPlatform={selected?.platform}
            />
          </Card>

          <Card title="出成品 · 打磨" sub="正文定了之后的四件事，一次做一件">
            <StudioTabs tabs={tabs} initialTab={sp.tab} />
          </Card>
        </div>
      </div>
    </>
  );
}
