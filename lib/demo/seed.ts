import { prisma } from '../db';
import { toJson } from '../json';
import { DEMO_ACCOUNT_ID, DEMO_MEMBER_ID, DEMO_TENANT_ID, DEMO_WORKSPACE_ID } from './guard';

// 演示（游客）租户的假数据种子。**幂等**：可重复调用。
//   - 顶层四件（tenant/workspace/member/account）按固定 ID upsert；
//   - 演示专属的子数据（发布记录/选题/草稿/记忆/素材/竞对订阅/技能安装）先清后建；
//   - 全局表里的演示行（竞对及其作品、示例热榜）按唯一键 upsert，且用可辨识前缀 / isMock 标注，
//     不污染真实租户视图（竞对只通过 demo 工作区的 watchlist 可见；热榜示例打 isMock）。
//
// 演示成员是 viewer 角色（RBAC 全只读）。数据只为「让每个页面看起来是活的」。

const now = Date.now();
const daysAgo = (n: number) => new Date(now - n * 86_400_000);

const DEMO_PERSONA = {
  identity: '深耕职场成长的内容创作者，擅长把复杂方法论讲成人话',
  audience: '一二线城市 25-35 岁职场人，焦虑但爱学习',
  valueProp: '每条内容都给一个当天能用上的小方法',
  canDo: ['职场沟通', '效率工具', '副业思路', '个人成长'],
  cantDo: ['医疗建议', '荐股', '政治敏感话题'],
  tone: '真诚、口语化、偶尔自嘲，不端着',
  platforms: ['xiaohongshu', 'douyin', 'wechat'],
  niche: '职场成长',
};

const DEMO_FINGERPRINT = {
  voice: ['第一人称叙事', '短句多', '结尾抛问题引互动'],
  format: ['开头三行钩子', '分点小标题', '金句收尾'],
  topic: ['亲测有效的方法', '踩坑复盘', '认知反差'],
};

type Competitor = {
  handle: string;
  platform: string;
  name: string;
  followers: number;
  posts: { platformItemId: string; title: string; url: string; metrics: Record<string, number>; days: number }[];
};

const DEMO_COMPETITORS: Competitor[] = [
  {
    handle: 'demo-xhs-zhichang',
    platform: 'xiaohongshu',
    name: '职场姐姐Lily',
    followers: 128_000,
    posts: [
      { platformItemId: 'demoXHS1001', title: '离职前我做对的3件事', url: 'https://www.xiaohongshu.com/explore/demoXHS1001', metrics: { views: 82_000, likes: 6_400, comments: 320, collects: 3_100 }, days: 2 },
      { platformItemId: 'demoXHS1002', title: '00后整顿职场是真的吗', url: 'https://www.xiaohongshu.com/explore/demoXHS1002', metrics: { views: 45_000, likes: 2_900, comments: 210, collects: 1_200 }, days: 6 },
    ],
  },
  {
    handle: 'demo-dy-xiaoxie',
    platform: 'douyin',
    name: '效率小谢',
    followers: 356_000,
    posts: [
      { platformItemId: 'demoDY2001', title: '3个被低估的电脑快捷键', url: 'https://www.douyin.com/video/demoDY2001', metrics: { views: 520_000, likes: 31_000, comments: 1_800, shares: 9_400 }, days: 1 },
      { platformItemId: 'demoDY2002', title: '为什么你越忙越穷', url: 'https://www.douyin.com/video/demoDY2002', metrics: { views: 280_000, likes: 18_000, comments: 900, shares: 4_200 }, days: 4 },
    ],
  },
  {
    handle: 'demo-bili-chengzhang',
    platform: 'bilibili',
    name: '成长研究所',
    followers: 92_000,
    posts: [
      { platformItemId: 'demoBV3001', title: '我用一年时间验证的时间管理法', url: 'https://www.bilibili.com/video/demoBV3001', metrics: { views: 156_000, likes: 12_000, comments: 640, coins: 3_200, collects: 5_800 }, days: 3 },
    ],
  },
];

// ⚠️ 这里**故意没有**演示热榜数据。HotItem 是全局表（无 tenantId），而 ensureDemoTenant 由
// 「游客访问」按钮触发——线上第一个点游客的人，就会把演示词条灌进**所有付费租户**的热榜，
// 其中一条还正好落在百度这种有真实通道的源上，混在真数据里没有任何标记（真机 2026-07-30）。
// 展台不需要自己造热榜：某个源没有真实通道时，ingestHot 的 MockHotAdapter 兜底本来就会
// 填出形态一样的示例条目（且逐条挂「示例」标、不进候选池）。演示租户看到的和别人一样。

// 展台的选题要覆盖三个时间队列和几种候选源，否则新访客只会看到清一色「今日突击 · 来自热点」，
// 以为这个产品还是个热榜搬运工。evidence/windowHint 用真实形态的句子（数字是演示值，
// 全部条目 mocked=true，UI 会挂「示例数据」标）。
const DEMO_TOPICS: {
  title: string; angle: string; scores: Record<string, number>; total: number; state: string;
  queue: string; sourceType: string; evidence?: string; windowHint?: string;
}[] = [
  { title: '00后整顿职场，普通人能学到什么', angle: '不站队，只讲可迁移的沟通方法', scores: { traffic: 92, personaFit: 88, cost: 70, monetization: 65, compliance: 95, differentiation: 80 }, total: 82, state: 'recommended', queue: 'today', sourceType: 'hot' },
  {
    title: '年轻人开始反向消费了', angle: '不谈现象谈账本：我自己一年的消费结构对比',
    scores: { traffic: 90, personaFit: 84, cost: 68, monetization: 62, compliance: 94, differentiation: 89 }, total: 84,
    state: 'recommended', queue: 'today', sourceType: 'gap',
    evidence: '该话题已在 微博、知乎 共 2 个平台上榜，最早 4 小时前出现；本工作区监控的 6 条小红书竞对近期作品中无人做同题（抽样口径，非全平台）。',
    windowHint: '小红书抢跑窗口约剩 44 小时',
  },
  { title: '被低估的3个电脑快捷键', angle: '每个都配一个真实工作场景', scores: { traffic: 88, personaFit: 82, cost: 90, monetization: 55, compliance: 98, differentiation: 60 }, total: 79, state: 'recommended', queue: 'today', sourceType: 'hot' },
  {
    title: '副业踩坑又上热搜了', angle: '把当年那期的三个坑，用今年的新案例重讲一遍',
    scores: { traffic: 83, personaFit: 91, cost: 86, monetization: 72, compliance: 95, differentiation: 74 }, total: 84,
    state: 'recommended', queue: 'week', sourceType: 'recycle',
    evidence: '你在 2026年3月 发过同题的《3个副业踩坑实录》，当时 21.0万播放（你在抖音近 12 条的均值是 4.6万）。这个话题现在重新上榜了。',
  },
  {
    title: '通勤路上我都在听什么', angle: '短视频版重剪：把 12 分钟压成 90 秒的清单体',
    scores: { traffic: 78, personaFit: 88, cost: 94, monetization: 58, compliance: 96, differentiation: 66 }, total: 79,
    state: 'recommended', queue: 'week', sourceType: 'crossplat',
    evidence: '这条在抖音跑到 12.8万播放，是你该平台近 12 条均值（4.6万）的 2.8 倍；小红书、公众号尚未发过同题内容。',
    windowHint: '已验证内容改编到小红书、公众号，制作成本远低于从零起题',
  },
  {
    title: '刚开始做个人成长内容，最容易踩的几个坑', angle: '用我自己前 20 条数据说话，每个坑配一条真实翻车记录',
    scores: { traffic: 70, personaFit: 93, cost: 82, monetization: 64, compliance: 97, differentiation: 80 }, total: 79,
    state: 'recommended', queue: 'evergreen', sourceType: 'evergreen',
    evidence: '新人持续涌入，入门避坑类内容的搜索需求常年不衰减',
    windowHint: '无时效压力，任何时候做都成立；适合排进产能空档',
  },
  {
    title: '关于个人成长，大多数人其实搞反了的一件事', angle: '先破后立：把最流行的那句鸡汤拆开算账',
    scores: { traffic: 76, personaFit: 90, cost: 78, monetization: 66, compliance: 92, differentiation: 87 }, total: 81,
    state: 'recommended', queue: 'evergreen', sourceType: 'evergreen',
    evidence: '反常识钩子天然高完播，且不依赖时效',
    windowHint: '无时效压力，任何时候做都成立；适合排进产能空档',
  },
  { title: '副业别急着赚钱，先验证这1件事', angle: '用「最小验证」框架替代盲目开干', scores: { traffic: 85, personaFit: 90, cost: 75, monetization: 78, compliance: 95, differentiation: 86 }, total: 85, state: 'accepted', queue: 'today', sourceType: 'hot' },
  { title: '越忙越穷的底层原因', angle: '从「时间颗粒度」角度切，反常识', scores: { traffic: 80, personaFit: 92, cost: 72, monetization: 70, compliance: 90, differentiation: 88 }, total: 82, state: 'candidate', queue: 'today', sourceType: 'hot' },
  { title: '通勤两小时，我这样把它变成资产', angle: '通勤=最稳定的学习时段，给排期模板', scores: { traffic: 75, personaFit: 85, cost: 80, monetization: 60, compliance: 95, differentiation: 78 }, total: 77, state: 'candidate', queue: 'today', sourceType: 'hot' },
];

const DEMO_DRAFTS: { title: string; platform: string; status: string; content: string }[] = [
  { title: '副业别急着赚钱，先验证这1件事', platform: 'xiaohongshu', status: 'ready', content: '开头：我劝你副业先别急着赚钱。\n\n很多人一上来就囤货、开店、买课，结果三个月就放弃了。\n\n真正该做的第一步，是花一周做「最小验证」——用最低成本确认有人真的愿意付钱。\n\n① 找到10个目标用户\n② 用一句话描述你能帮他们解决什么\n③ 看有没有人愿意先付个定金\n\n验证通过再投入，你会少走一年弯路。\n\n你想做的副业，验证过吗？' },
  { title: '被低估的3个电脑快捷键', platform: 'douyin', status: 'editing', content: '口播稿：今天分享3个能救命的快捷键。\n第一个……' },
  { title: '00后整顿职场，普通人能学到什么', platform: 'wechat', status: 'published', content: '正文：这两天「00后整顿职场」又上热搜了……' },
];

// 发布记录。**topicTitle 是必要的**：爆款基因页的「选题来源」「切入角」两维靠 PublishRecord.topicId
// 串到 TopicIdea 才有数据，不挂归因的话展台上那两维永远是空的。
// 条数也刻意给够：抖音/小红书两个平台各 ≥3 条，基因页才有达样本线的桶可展示；
// 公众号只留 1 条是**故意的**——顺便把「样本不足不下结论」这个行为也展示出来。
const DEMO_PUBLISH: {
  platform: string; title: string; platformItemId: string | null;
  metrics: Record<string, number>; fromRecommend: boolean; days: number;
  hour?: number; // 北京时间发布小时（不填按 daysAgo 的当前时刻）
  topicTitle?: string; // 对应 DEMO_TOPICS 里的标题，用于归因
}[] = [
  { platform: 'xiaohongshu', title: '离职这半年，我最大的3个改变', platformItemId: 'demoOwnXHS01', metrics: { views: 34_000, likes: 2_100, comments: 180, collects: 1_400 }, fromRecommend: true, days: 5, hour: 21, topicTitle: '副业别急着赚钱，先验证这1件事' },
  { platform: 'douyin', title: '通勤路上我都在听什么', platformItemId: 'demoOwnDY01', metrics: { views: 128_000, likes: 8_300, comments: 420, shares: 2_100 }, fromRecommend: true, days: 8, hour: 20, topicTitle: '通勤路上我都在听什么' },
  { platform: 'wechat', title: '为什么我不再做时间管理', platformItemId: 'demoOwnWX01', metrics: { views: 12_000, likes: 640, comments: 96 }, fromRecommend: false, days: 12, hour: 8 },
  { platform: 'xiaohongshu', title: '普通人如何开始写作', platformItemId: null, metrics: { views: 9_800, likes: 520, comments: 60 }, fromRecommend: false, days: 15, hour: 21 },
  { platform: 'douyin', title: '3个副业踩坑实录', platformItemId: 'demoOwnDY02', metrics: { views: 210_000, likes: 15_600, comments: 880, shares: 5_400 }, fromRecommend: true, days: 20, hour: 20, topicTitle: '副业踩坑又上热搜了' },
  { platform: 'douyin', title: '00后整顿职场，普通人能学到什么', platformItemId: 'demoOwnDY03', metrics: { views: 96_000, likes: 5_200, comments: 310, shares: 1_400 }, fromRecommend: true, days: 26, hour: 20, topicTitle: '00后整顿职场，普通人能学到什么' },
  { platform: 'douyin', title: '被低估的3个电脑快捷键', platformItemId: 'demoOwnDY04', metrics: { views: 41_000, likes: 2_600, comments: 140, shares: 620 }, fromRecommend: true, days: 33, hour: 12, topicTitle: '被低估的3个电脑快捷键' },
  { platform: 'xiaohongshu', title: '年轻人开始反向消费了', platformItemId: 'demoOwnXHS02', metrics: { views: 58_000, likes: 3_900, comments: 260, collects: 2_200 }, fromRecommend: true, days: 40, hour: 21, topicTitle: '年轻人开始反向消费了' },
  { platform: 'douyin', title: '越忙越穷的底层原因', platformItemId: 'demoOwnDY05', metrics: { views: 22_000, likes: 1_100, comments: 70, shares: 210 }, fromRecommend: false, days: 47, hour: 12, topicTitle: '越忙越穷的底层原因' },
];

// 读者提问示例（source='comment'）：展示「从自有评论区挖问题」这条链路的产物形态
const DEMO_QUESTIONS: { title: string; note: string; days: number }[] = [
  { title: '副业到底要不要辞职做', note: '被问到 7 次；其它问法：辞职搞副业靠谱吗 / 要不要裸辞做副业', days: 2 },
  { title: '新手第一个副业选哪个好', note: '被问到 4 次；其它问法：完全没经验先做什么', days: 4 },
  { title: '这个方法上班族也能用吗', note: '被问到 3 次', days: 6 },
];

const DEMO_MEMORIES: { type: string; content: string; confidence: number; hitCount: number }[] = [
  { type: 'performance', content: '「踩坑复盘」类选题在你的账号上平均播放高于基线 38%', confidence: 0.82, hitCount: 4 },
  { type: 'performance', content: '带具体数字的标题（如「3件事」）互动率更高', confidence: 0.76, hitCount: 3 },
  { type: 'preference', content: '你更常在晚上 20-22 点发布，该时段完播率更好', confidence: 0.68, hitCount: 5 },
  { type: 'preference', content: '偏好口语化开头，避免说教式导语', confidence: 0.71, hitCount: 2 },
];

// 灵感收集箱的展台数据：三条覆盖它的三种状态，让访客一眼看懂「存进来的东西会变成什么」。
const DEMO_INSPIRATIONS: {
  title: string; note: string | null; url: string | null; platform: string | null;
  author: string | null; source: string; state: string; days: number;
}[] = [
  { title: '一条讲「反向消费」的爆款视频', note: '这个开头三秒的对比很值得学，想用在自己的选题上', url: 'https://www.douyin.com/video/demoInsp01', platform: 'douyin', author: '效率小谢', source: 'plugin', state: 'open', days: 3 },
  { title: '评论区有人问「副业到底要不要辞职做」', note: '想做一期正面回答这个问题的', url: null, platform: null, author: null, source: 'manual', state: 'open', days: 8 },
  { title: '别的赛道在用的「一天 vs 一年」对比形式', note: '这个形式可以搬到职场成长赛道', url: 'https://www.xiaohongshu.com/explore/demoInsp03', platform: 'xiaohongshu', author: '职场姐姐Lily', source: 'plugin', state: 'used', days: 26 },
];

const DEMO_MATERIALS: { type: string; content: string; tags: string[] }[] = [
  { type: 'experience', content: '我裸辞后靠一个小副业撑过了3个月，最关键的是提前做了最小验证', tags: ['副业', '裸辞'] },
  { type: 'opinion', content: '时间管理的本质不是塞满，而是敢于删除', tags: ['认知', '效率'] },
];

/** 幂等全量种子。scripts/seed-demo.ts 与 seed.ts 都调它；游客首次登录时也会懒调。 */
export async function seedDemo(): Promise<void> {
  // 1) 顶层四件按固定 ID upsert
  await prisma.tenant.upsert({
    where: { id: DEMO_TENANT_ID },
    update: { name: '烽火台演示工作台', plan: 'personal', planExpiresAt: daysAgo(-3650) },
    create: { id: DEMO_TENANT_ID, name: '烽火台演示工作台', plan: 'personal', planExpiresAt: daysAgo(-3650) },
  });
  await prisma.workspace.upsert({
    where: { id: DEMO_WORKSPACE_ID },
    update: { name: '主工作区' },
    create: { id: DEMO_WORKSPACE_ID, tenantId: DEMO_TENANT_ID, name: '主工作区' },
  });
  await prisma.member.upsert({
    where: { id: DEMO_MEMBER_ID },
    update: { name: '演示访客', role: 'viewer', status: 'active' },
    create: { id: DEMO_MEMBER_ID, tenantId: DEMO_TENANT_ID, name: '演示访客', role: 'viewer', status: 'active' },
  });
  await prisma.creatorAccount.upsert({
    where: { id: DEMO_ACCOUNT_ID },
    update: { name: '成长笔记', platform: 'multi', personaCard: toJson(DEMO_PERSONA), styleFingerprint: toJson(DEMO_FINGERPRINT) },
    create: {
      id: DEMO_ACCOUNT_ID,
      workspaceId: DEMO_WORKSPACE_ID,
      name: '成长笔记',
      platform: 'multi',
      handle: 'growth-notes',
      personaCard: toJson(DEMO_PERSONA),
      styleFingerprint: toJson(DEMO_FINGERPRINT),
    },
  });

  // 2) 清演示专属子数据（先清后建，保证幂等且不累积）
  await prisma.publishRecord.deleteMany({ where: { accountId: DEMO_ACCOUNT_ID } }); // 级联 PerformanceSnapshot
  await prisma.draft.deleteMany({ where: { accountId: DEMO_ACCOUNT_ID } }); // 级联 DraftVersion / ComplianceCheck
  await prisma.topicIdea.deleteMany({ where: { accountId: DEMO_ACCOUNT_ID } });
  await prisma.memoryEntry.deleteMany({ where: { workspaceId: DEMO_WORKSPACE_ID } });
  await prisma.material.deleteMany({ where: { accountId: DEMO_ACCOUNT_ID } });
  await prisma.inspirationItem.deleteMany({ where: { workspaceId: DEMO_WORKSPACE_ID } });
  await prisma.ownPost.deleteMany({ where: { accountId: DEMO_ACCOUNT_ID } });
  await prisma.watchlistItem.deleteMany({ where: { workspaceId: DEMO_WORKSPACE_ID } });
  await prisma.skillInstall.deleteMany({ where: { tenantId: DEMO_TENANT_ID } });

  // 3) 竞对（全局，用 demo- 前缀 handle；仅通过 demo 工作区 watchlist 可见）+ 作品 + 快照
  for (const c of DEMO_COMPETITORS) {
    const comp = await prisma.competitorAccount.upsert({
      where: { platform_handle: { platform: c.platform, handle: c.handle } },
      update: { name: c.name, followers: c.followers, lastCrawledAt: daysAgo(1) },
      create: { platform: c.platform, handle: c.handle, name: c.name, followers: c.followers, lastCrawledAt: daysAgo(1) },
    });
    await prisma.watchlistItem.upsert({
      where: { workspaceId_competitorId: { workspaceId: DEMO_WORKSPACE_ID, competitorId: comp.id } },
      update: {},
      create: { workspaceId: DEMO_WORKSPACE_ID, competitorId: comp.id, label: '示例竞对' },
    });
    for (const p of c.posts) {
      const post = await prisma.crawledPost.upsert({
        where: { platform_platformItemId: { platform: c.platform, platformItemId: p.platformItemId } },
        update: { title: p.title, url: p.url, metrics: toJson(p.metrics), hotScore: p.metrics.views ?? 0, publishedAt: daysAgo(p.days) },
        create: {
          competitorId: comp.id,
          platform: c.platform,
          platformItemId: p.platformItemId,
          title: p.title,
          url: p.url,
          metrics: toJson(p.metrics),
          hotScore: p.metrics.views ?? 0,
          publishedAt: daysAgo(p.days),
        },
      });
      await prisma.postMetricSnapshot.deleteMany({ where: { postId: post.id } });
      await prisma.postMetricSnapshot.create({ data: { postId: post.id, metrics: toJson(p.metrics) } });
    }
  }

  // 4) 热榜：**不写**。HotItem 是全局表，演示数据写进去就是往所有租户的榜单里灌假词条
  //    （原因见文件头 DEMO_HOT 被删处的注释）。展台的热榜由 ingestHot 正常产出。

  // 5) 选题（记下 标题→id：发布记录要靠它挂归因，基因页的「来源/切入角」两维才有数据）
  const topicIdByTitle = new Map<string, string>();
  for (const t of DEMO_TOPICS) {
    const created = await prisma.topicIdea.create({
      data: {
        accountId: DEMO_ACCOUNT_ID,
        title: t.title,
        angle: t.angle,
        scores: toJson(t.scores),
        totalScore: t.total,
        sourceType: t.sourceType,
        queue: t.queue,
        evidence: t.evidence,
        windowHint: t.windowHint,
        state: t.state,
        mocked: true,
      },
      select: { id: true },
    });
    topicIdByTitle.set(t.title, created.id);
  }

  // 6) 草稿 + 版本
  for (const d of DEMO_DRAFTS) {
    const draft = await prisma.draft.create({
      data: { accountId: DEMO_ACCOUNT_ID, title: d.title, platform: d.platform, status: d.status },
    });
    await prisma.draftVersion.create({
      data: { draftId: draft.id, seq: 1, authorType: 'ai', content: d.content },
    });
  }

  // 7) 发布记录 + 回流快照
  for (const r of DEMO_PUBLISH) {
    // 发布时刻按北京时间的小时折算回 UTC（基因页的「发布时段」维就是按 UTC+8 分桶的）
    const at = daysAgo(r.days);
    if (r.hour !== undefined) at.setUTCHours((r.hour - 8 + 24) % 24, 0, 0, 0);
    const rec = await prisma.publishRecord.create({
      data: {
        accountId: DEMO_ACCOUNT_ID,
        topicId: r.topicTitle ? topicIdByTitle.get(r.topicTitle) ?? null : null,
        platform: r.platform,
        title: r.title,
        platformItemId: r.platformItemId,
        needsBackfill: r.platformItemId === null,
        fromRecommend: r.fromRecommend,
        publishedAt: at,
        metrics: toJson(r.metrics),
      },
    });
    await prisma.performanceSnapshot.create({ data: { publishId: rec.id, metrics: toJson(r.metrics), source: 'manual' } });
  }

  // 8) 记忆 + 素材
  for (const m of DEMO_MEMORIES) {
    await prisma.memoryEntry.create({
      data: { workspaceId: DEMO_WORKSPACE_ID, accountId: DEMO_ACCOUNT_ID, type: m.type, content: m.content, confidence: m.confidence, hitCount: m.hitCount, active: m.hitCount >= 3 },
    });
  }
  for (const mat of DEMO_MATERIALS) {
    await prisma.material.create({ data: { accountId: DEMO_ACCOUNT_ID, type: mat.type, content: mat.content, tags: toJson(mat.tags) } });
  }
  for (const q of DEMO_QUESTIONS) {
    await prisma.inspirationItem.create({
      data: {
        workspaceId: DEMO_WORKSPACE_ID, accountId: DEMO_ACCOUNT_ID,
        title: q.title, note: q.note, source: 'comment', state: 'open', createdAt: daysAgo(q.days),
      },
    });
  }
  for (const insp of DEMO_INSPIRATIONS) {
    await prisma.inspirationItem.create({
      data: {
        workspaceId: DEMO_WORKSPACE_ID,
        // 展台里既有工作区共享的（插件回传形态）也有归到账号的（网页录入形态）
        accountId: insp.source === 'manual' ? DEMO_ACCOUNT_ID : null,
        title: insp.title, note: insp.note, url: insp.url, platform: insp.platform,
        author: insp.author, source: insp.source, state: insp.state,
        createdAt: daysAgo(insp.days),
        usedAt: insp.state === 'used' ? daysAgo(insp.days - 2) : null,
      },
    });
  }

  // 9) 安装全部内置技能（技能中心/创作工坊有内容可用）
  const builtins = await prisma.contentSkill.findMany({ where: { isBuiltin: true, enabled: true }, select: { id: true } });
  for (const s of builtins) {
    await prisma.skillInstall.upsert({
      where: { tenantId_skillId: { tenantId: DEMO_TENANT_ID, skillId: s.id } },
      update: { enabled: true },
      create: { tenantId: DEMO_TENANT_ID, skillId: s.id },
    });
  }
}

/**
 * 懒确保：游客登录时调。演示成员已存在则快路径返回（不重复灌数据）；缺失则种一次。
 * 返回演示成员/租户 ID 供建会话用。
 */
export async function ensureDemoTenant(): Promise<{ memberId: string; tenantId: string }> {
  const existing = await prisma.member.findUnique({ where: { id: DEMO_MEMBER_ID }, select: { id: true } });
  if (!existing) await seedDemo();
  return { memberId: DEMO_MEMBER_ID, tenantId: DEMO_TENANT_ID };
}
