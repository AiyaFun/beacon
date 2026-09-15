import Link from 'next/link';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { platformName, platformColor } from '@/lib/constants';
import { relTime } from '@/lib/format';
import { listInstalledSkills } from '@/lib/skills';
import { Rewriter } from './Rewriter';
import { NewDraftDialog } from './NewDraftDialog';
import { DraftButton } from './DraftButton';
import type { CoverQuota } from './CoverStation';
import { imageConfigured, imageSource } from '@/lib/llm/image';
import { listLibrary, listDraftCovers, listDraftIllustrations, coverCountsByDraft } from '@/lib/media/store';
import { COVER_STYLES } from '@/lib/cover/styles';
import { getImageQuotaStatus } from '@/lib/quota';
import { readPersona } from '@/lib/persona';
import { DraftList, type DraftRow } from './DraftList';
import { AssistPane } from './AssistPane';
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
  // 【并进这一波的三样（2026-09-12）】fromTopic 与封面工位那三条原本各自单独 await，
  // 排在第 2 波和第 10 波上，可它们的入参只有 sp.topicId / s.tenantId / s.accountId
  //（第 52~53 行就已就绪），跟 drafts 没有任何数据依赖。生产库跨区一跳 32ms，
  // 白等两跳。并发从 4 涨到 8，离池子 15 还远。
  const [drafts, skills, materials, ownedAccounts, fromTopic, coverConfigured, coverSource, coverAccount] = await Promise.all([
    // 【只取列表要用的字段，正文不进这一份】原来是 `include: { topic:true, versions:{全量} }`：
    // 把**每篇草稿的每一版正文**都拉回服务端再塞进 RSC 流，而列表上只显示标题、状态、
    // 版本数和「最近一版是谁改的」。一份 30 版的稿子几百 KB，稿子一多就是几 MB。
    // topic 关系对象也从来没被读过（页面用的是标量 d.topicId）。
    // 选中那一篇的正文另外取（见下方 selectedVersions），不多一波。
    prisma.draft.findMany({
      where: { accountId: s.accountId },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true, title: true, status: true, platform: true,
        topicId: true, parentDraftId: true, coverAssetId: true, updatedAt: true,
        _count: { select: { versions: true } },
        versions: { orderBy: { seq: 'desc' }, take: 1, select: { seq: true, authorType: true, createdAt: true } },
      },
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
    // 从选题引擎「去工坊起这篇稿」带过来的选题。此前这个参数没人接：点过来只是跳到工坊首页，
    // 选题上下文当场丢掉，用户得自己回想刚才采纳的是哪条。
    sp.topicId
      ? prisma.topicIdea.findFirst({
          where: { id: sp.topicId, accountId: s.accountId },
          select: { id: true, title: true, angle: true },
        })
      : Promise.resolve(null),
    // 封面工位要的三样：能不能生图 / 今日还能出几张 / 人设赛道（给风格排序）。
    // 都在服务端算好传下去——客户端组件不碰 prisma，也别让「今日剩余」靠前端猜。
    imageConfigured(s.tenantId),
    imageSource(s.tenantId),
    prisma.creatorAccount.findUnique({ where: { id: s.accountId }, select: { personaCard: true } }),
  ]);
  // 已经起过稿就直接定位过去；还没有就把 topicId 交给「AI 生成初稿」按钮。
  // **不在页面加载时替他生成**——那是一次真实调用要花额度，必须他自己点。
  const topicDraft = fromTopic ? drafts.find((d) => d.topicId === fromTopic.id) : undefined;
  const pendingTopic = fromTopic && !topicDraft ? fromTopic : null;

  const selectedId = sp.draft && drafts.some((d) => d.id === sp.draft)
    ? sp.draft
    : (topicDraft?.id ?? drafts[0]?.id);
  const selected = drafts.find((d) => d.id === selectedId) ?? null;

  // ── 第二波：所有「知道选中哪一篇之后才能查」的东西，一次发完 ──
  //
  // 【原来这里是四波串行】会诊计数 → 稿件家族 → 出图配额 → 形象库那五样。
  // 逐条核过：前三者只依赖 selectedId / coverSource（都在上一波就有了），
  // 只有「家族里每篇出没出过封面」真的要等 family 的结果，留到第三波。
  // 生产库跨区一跳 32ms，白等两跳。
  const COMPARE_LIMIT = 10;
  const [
    draftSessionCount, draftAdoptedCount, family, imageQuota,
    selectedVersions, coverLibrary, draftCovers, stylePresets, illustrations,
  ] = await Promise.all([
    // W-6：这篇草稿的会诊场次与其中已采纳的意见数（决定「按已采纳意见改一版」是否可点）
    selectedId
      ? prisma.advisorSession.count({ where: { accountId: s.accountId, draftRef: selectedId } })
      : Promise.resolve(0),
    selectedId
      ? prisma.advisorOpinion.count({
          where: { adopted: true, session: { accountId: s.accountId, draftRef: selectedId } },
        })
      : Promise.resolve(0),
    // 同源稿件家族（一稿多平台）：只有选中草稿时才查
    selectedId ? draftFamily(s.accountId, selectedId) : Promise.resolve([]),
    coverConfigured && coverSource ? getImageQuotaStatus(s.tenantId, coverSource) : Promise.resolve(null),
    // 选中这一篇的正文：版本对比要拿全文（diff 在浏览器里算），所以**只取最近 10 版**，
    // 而且只取这一篇的——列表那一份已经不带正文了。
    selectedId
      ? prisma.draftVersion.findMany({
          where: { draftId: selectedId },
          orderBy: { seq: 'desc' },
          take: COMPARE_LIMIT,
          select: { seq: true, authorType: true, content: true, createdAt: true },
        })
      : Promise.resolve([]),
    // 形象库 / 本稿封面 / 风格预设 / 本稿配图：都在服务端算好传下去（客户端组件不碰 prisma）
    listLibrary(s.workspaceId, s.accountId),
    selectedId ? listDraftCovers(s.workspaceId, selectedId) : Promise.resolve([]),
    prisma.coverStylePreset.findMany({
      where: { workspaceId: s.workspaceId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, name: true, description: true },
    }),
    selectedId ? listDraftIllustrations(s.workspaceId, selectedId) : Promise.resolve([]),
  ]);
  // 第三波：唯一真的要等 family 的一条
  const familyCoverCounts = await coverCountsByDraft(s.workspaceId, family.map((f) => f.draftId));
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
  // selectedVersions 已按 seq desc 取回最近 10 版；这里翻成升序给对比用
  const versionsAsc = [...selectedVersions].sort((a, b) => a.seq - b.seq);
  const latest = selectedVersions[0]; // 已按 seq desc
  const selectedStatus = selected ? statusOf(selected.status) : null;

  const compareVersions = versionsAsc.map((v) => ({
    seq: v.seq,
    authorType: v.authorType,
    content: v.content,
    timeLabel: relTime(v.createdAt),
  }));

  // 列表用的行数据在服务端摊平：客户端组件不该拿到整个 Prisma 模型，
  // 相对时间也必须在这里算好（客户端读 Date.now() 会 hydration 不一致）。
  const draftRows: DraftRow[] = drafts.map((d) => {
    const st = statusOf(d.status);
    const latestVer = d.versions[0];
    return {
      id: d.id,
      title: d.title,
      status: d.status,
      statusText: st.text,
      statusCls: st.cls,
      platformName: platformName(d.platform),
      platformColor: platformColor(d.platform),
      versionCount: d._count.versions,
      lastLabel: latestVer ? relTime(latestVer.createdAt) : '—',
      latestVersion: latestVer
        ? {
            seq: latestVer.seq,
            authorType: latestVer.authorType === 'ai' ? (lang === 'en' ? 'AI Draft' : 'AI 初稿') : (lang === 'en' ? 'Human Edit' : '人工终稿'),
            timeLabel: relTime(latestVer.createdAt),
          }
        : undefined,
    };
  });

  // 下半区四件事：互斥，做完一件再做下一件，所以是标签页而不是四张常驻卡片。
  // 【删掉了一个从没被渲染过的 tabs 数组】它构造了 技能/标题/封面/正文配图/一稿多平台/草稿会诊
  // 六个面板，然后**一次都没进过 return** —— 第 311 行那个 `tabs={<MakeTabs/>}` 是 HubHeader 的同名
  // 属性，不是它。于是「正文配图」在工坊里没有任何入口，而 /images 页至今写着
  //「创作工坊 · 正文配图：按某一篇的正文自动拆成一组画面」——照着那句话来找的人什么也找不到。
  // 2026-09-12：配图入口已接进 AssistPane（「标题封面」页签下的「给正文配图」），
  // 其余五个面板 AssistPane 本来就有，这个数组整段删除。

  return (
    <>
      <HubHeader
        title={dict.tabs.makeTitle}
        hint={lang === 'en' ? 'AI drafting · Version history · Multi-platform rewriter · Pre-publish compliance checks' : 'AI 起草 · 版本留痕 · 多平台改写 · 发布前合规。AI 初稿和你改后终稿的差异，系统会从中学你的口味。'}
        tabs={<MakeTabs active="write" inline />}
        action={
          <span className="row wrap" style={{ gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
            <NewDraftDialog defaultPlatform={selected?.platform} />
            <Link href="/publish" className="btn primary">
              {lang === 'en' ? 'Publish' : '去发布'}
            </Link>
          </span>
        }
      />

      {fromTopic && (
        <div
          className="card"
          style={{
            marginBottom: 12,
            padding: '10px 16px',
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

      <div className="work-grid">
        {/* 左栏（草稿与版本 258px） */}
        <aside className="surface draft-pane">
          <DraftList
            drafts={draftRows}
            selectedId={selectedId}
            emptyText={
              pendingTopic
                ? (lang === 'en' ? 'No drafts yet — click "AI Generate Draft" above to start.' : '还没有草稿——点上面那条横幅里的「AI 生成初稿」，就按带过来的这条选题起一版')
                : (lang === 'en' ? 'No drafts yet — click "New Draft" in the top right to start.' : '还没有草稿——点右上角「新建草稿」，开启你的创作')
            }
            versions={compareVersions}
          />
        </aside>

        {/* 中栏（正文编辑区 1fr） */}
        <Rewriter
          key={selected?.id ?? 'new'}
          draftId={selected?.id}
          initialText={latest?.content ?? ''}
          draftTitle={selected?.title}
          initialPlatform={selected?.platform}
          versionSeq={latest?.seq ?? selected?._count.versions ?? 1}
        />

        {/* 右栏（AI 与成品 318px） */}
        <AssistPane
          draftId={selected?.id}
          platform={selected?.platform}
          draftTitle={selected?.title}
          hasContent={!!latest?.content?.trim()}
          personaText={personaForCover}
          defaultStyleKey={coverPersona.coverStyle}
          defaultFontKey={coverPersona.coverFont}
          coverQuota={coverQuota}
          coverLibrary={coverLibrary}
          draftCovers={draftCovers}
          coverAssetId={selected?.coverAssetId ?? null}
          stylePresets={stylePresets}
          family={family}
          familyCoverCounts={familyCoverCounts}
          wechatAiHint={shouldHintWechatAiSource(ownedAccounts.map((a) => a.platform))}
          draftSessionCount={draftSessionCount}
          draftAdoptedCount={draftAdoptedCount}
          skills={skills}
          materials={materials}
          draftIllustrations={draftIllustrations}
          illustrationStyles={COVER_STYLES.map((st) => ({ key: st.key, name: st.name, hint: st.hint }))}
        />
      </div>
    </>
  );
}
