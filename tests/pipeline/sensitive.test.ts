import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { clusterHotTopics, generateRecommendations, isSensitiveTitle, sensitiveHits } from '@/lib/pipeline';

// F1-4 敏感热点打标与推荐隔离（PRD §6 / §5 绝不清单第 12 条）。
//
// 本文件存在的理由：这道 P0 护栏**从未生效过**。`TopicCluster.isSensitive` 上线以来
// 只有两个读取点（推荐过滤 + 榜单页展示过滤），**零写入点**——线上 82 个簇里 isSensitive:true 的有 0 个。
// 也就是说「敏感热点不进推荐」是一句写在 schema 里的空话。这里把打标这一半锁死。

const hot = (source: string, rank: number, title: string, heat = 100) =>
  prisma.hotItem.create({ data: { source, rank, title, heat } });

async function seedAccount() {
  const tenant = await prisma.tenant.create({ data: { name: 't', plan: 'free' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'w' } });
  const account = await prisma.creatorAccount.create({
    data: {
      workspaceId: ws.id,
      platform: 'douyin',
      name: '测试账号',
      // 人设必须显式给全：personaCard 的 schema 默认值是 "{}"，而 readPersona 走的是
      // parseJson("{}", emptyPersona()) —— "{}" 是合法 JSON，fallback 不生效，返回的对象
      // 没有 canDo/cantDo，personaPromptBlock 里 `p.canDo.join` 直接抛 TypeError。
      // 那是 lib/persona.ts 的问题（不在本轮改动范围），这里绕开它，专心测隔离。
      personaCard: JSON.stringify({
        identity: '内容创作者成长教练',
        audience: '起号新人',
        valueProp: '帮新人起号找选题',
        niche: '起号涨粉',
        canDo: ['选题拆解'],
        cantDo: ['医疗建议'],
        tone: '口语',
        platforms: ['douyin'],
      }),
    },
  });
  return { workspaceId: ws.id, accountId: account.id };
}

beforeEach(async () => {
  await prisma.hotItem.deleteMany();
  await prisma.topicCluster.deleteMany();
});

describe('F1-4 词库判定 · 该拦的必须拦', () => {
  // 真实热榜标题（2026-07-17 抖音/头条/微博/知乎实采）
  it.each([
    ['重庆彭水山体垮塌已救出10人', '灾难伤亡'],
    ['深圳市委原常委王强主动投案被查', '反腐'],
    ['伊朗称摧毁多架美军战斗机', '军事冲突'],
    ['塞尔维亚总统武契奇公开支持乌克兰，称支持其领土主权完整', '涉外政治'],
    ['曲婉婷母亲贪污3.5亿元职工安置费', '贪污'],
    ['21岁女孩家中遇害凶手竟是亲生父亲', '恶性刑案'],
    ['德68岁电工迷奸近60名女性被公诉', '性犯罪'],
    ['长沙6岁女孩在小区游泳馆里溺亡', '死亡事故'],
    ['印度数十万人涌入活动发生踩踏', '踩踏事故'],
    ['小米 SU7 碰撞测试博主因捏造事实被判刑一年八个月', '司法判决'],
    ['国防部回应“解放军来了”刷屏', '军事'],
    ['成都突发车祸一车烧成空壳', '交通事故'],
  ])('「%s」应打标（%s）', (title) => {
    expect(isSensitiveTitle(title)).toBe(true);
  });

  it('伤亡人数是数字，穷举不了，靠模式层兜住', () => {
    // 「致3伤」不可能出现在任何固定词表里
    expect(isSensitiveTitle('女子驾车操作不当碰撞行人致3伤')).toBe(true);
    expect(isSensitiveTitle('事故造成12人受伤')).toBe(true);
    expect(sensitiveHits('女子驾车操作不当碰撞行人致3伤')[0].category).toBe('disaster');
  });
});

describe('F1-4 词库判定 · 误标专项（过度屏蔽会把推荐池抽空）', () => {
  // 误标的代价不是「多拦一条」——被打标的词条**永久进不了推荐与生成**（PRD F1-4 描述）。
  // 下面全是真实热榜里的正常词条，一条都不许被拦。
  it.each([
    ['气象台不敢报40℃是谣言', '天气'],
    ['吐鲁番逼近50℃炙烤', '天气'],
    ['电影想你了今日上映', '影视'],
    ['功夫女足票房破10亿', '影视'],
    ['迪丽热巴晒和张小斐合照', '明星'],
    ['马龙许昕苦战五局晋级八强', '体育'],
    ['谁将获得本届世界杯冠军', '体育'],
    ['A股今天暴跌原因', '财经行情'],
    ['黄金跌破4000美元', '财经行情'],
    ['西红柿炒蛋在日本火了', '美食'],
    ['世界人工智能大会今日开幕', '科技'],
    ['短视频运营最新政策', '创作者选题'],
    ['直播带货新规解读', '创作者选题'],
    ['内容合规红线有哪些', '创作者选题'],
    ['被裁掉的女孩', '职场'],
    ['哥哥605分考上军校 妹妹争着领牌匾', '励志（含「军校」但不涉军事冲突）'],
    ['男子帮台湾游客拍照发现是失联大伯', '暖闻（含「台湾」但不涉两岸政治）'],
    ['青岛进入啤酒节时间', '生活'],
  ])('「%s」不该被拦（%s）', (title) => {
    expect(isSensitiveTitle(title)).toBe(false);
  });

  it('「翻车」是创作者黑话，不是事故', () => {
    // 「这条视频翻车了」是选题富矿，收光杆「翻车」等于自杀
    expect(isSensitiveTitle('我的第一条爆款视频翻车了')).toBe(false);
    expect(isSensitiveTitle('高速翻车事故致多人受伤')).toBe(true);
  });

  it('光杆地名不是敏感词，「新疆旅游」不该被当成涉政', () => {
    expect(isSensitiveTitle('新疆旅游攻略保姆级')).toBe(false);
    expect(isSensitiveTitle('香港美食city walk')).toBe(false);
    expect(isSensitiveTitle('台独言论遭批')).toBe(true);
  });

  it('「政策」「新规」不能进词库：那是创作者的正常选题', () => {
    expect(isSensitiveTitle('小红书搜索流量新规解读')).toBe(false);
  });
});

describe('F1-4 打标写入 · 护栏必须真的落库', () => {
  it('敏感跨源簇写入 isSensitive=true，且 summary 为空（AC④：不调用 LLM 出摘要）', async () => {
    await hot('douyin', 1, '重庆彭水山体垮塌已救出10人', 900);
    await hot('toutiao', 1, '重庆山体垮塌已救出10人', 800);
    const rep = await clusterHotTopics();
    expect(rep.sensitive).toBe(1);
    const c = await prisma.topicCluster.findFirstOrThrow();
    expect(c.isSensitive).toBe(true);
    expect(c.summary).toBeNull(); // AC④：敏感簇不出 AI 摘要
  });

  it('正常跨源簇不打标，且照常出摘要', async () => {
    await hot('douyin', 1, '功夫女足票房破10亿', 900);
    await hot('toutiao', 1, '《功夫女足》上映七天票房破10亿登顶暑期档', 800);
    const rep = await clusterHotTopics();
    expect(rep.sensitive).toBe(0);
    const c = await prisma.topicCluster.findFirstOrThrow();
    expect(c.isSensitive).toBe(false);
    expect(c.summary).toBeTruthy();
  });

  it('簇内任一成员敏感 → 整簇敏感（同簇即同事件，方向偏保守）', async () => {
    await hot('weibo', 1, '曲婉婷母亲贪污3.5亿元职工安置费', 900);
    await hot('toutiao', 1, '曲婉婷母亲贪污案职工安置费去向追问', 800);
    const rep = await clusterHotTopics();
    expect(rep.sensitive).toBe(1);
  });

  it('打标结论要能被调用方看见：reviewed 字段说明本轮判到哪一层', async () => {
    await hot('douyin', 1, '重庆彭水山体垮塌已救出10人', 900);
    await hot('toutiao', 1, '重庆山体垮塌已救出10人', 800);
    const rep = await clusterHotTopics();
    // dev 无 key：只有词库跑过，LLM 没跑过。不许把「没复核」说成「复核了没问题」。
    expect(rep.reviewed).toBe('lexicon');
  });
});

describe('F1-4 推荐隔离 · AC①「打标词条 100% 不出现在推荐流」', () => {
  it('敏感跨源簇的词条进不了推荐', async () => {
    const { workspaceId, accountId } = await seedAccount();
    await hot('douyin', 1, '重庆彭水山体垮塌已救出10人', 1000);
    await hot('toutiao', 1, '重庆山体垮塌已救出10人', 990);
    await hot('douyin', 2, '功夫女足票房破10亿', 500);
    await clusterHotTopics();
    await generateRecommendations(accountId, workspaceId, 6);
    const ideas = await prisma.topicIdea.findMany({ where: { accountId } });
    expect(ideas.length).toBeGreaterThan(0);
    expect(ideas.some((i) => i.title.includes('垮塌'))).toBe(false);
  });

  it('【零成本绕过回归锁】单源敏感词条不进任何跨源簇，cluster 为 null —— 条目级词库必须兜住', async () => {
    // 这是簇级打标单独存在时的致命缺口：clusterHotTopics 只建**跨平台**簇（≥2 源），
    // 只在 1 个源上榜的敏感词条 cluster 恒为 null → `!h.cluster?.isSensitive` 恒为 true → 直接进候选池。
    const { workspaceId, accountId } = await seedAccount();
    await hot('weibo', 1, '深圳市委原常委王强主动投案被查', 1000); // 仅 weibo 一个源
    await hot('douyin', 1, '功夫女足票房破10亿', 500);
    await clusterHotTopics();
    const clusters = await prisma.topicCluster.count();
    expect(clusters).toBe(0); // 确认它确实没有簇可依赖
    await generateRecommendations(accountId, workspaceId, 6);
    const ideas = await prisma.topicIdea.findMany({ where: { accountId } });
    expect(ideas.some((i) => i.title.includes('投案'))).toBe(false);
  });

  it('隔离不能靠抽空推荐池实现：正常词条照常出推荐', async () => {
    const { workspaceId, accountId } = await seedAccount();
    await hot('weibo', 1, '重庆彭水山体垮塌', 1000);
    await hot('douyin', 1, '功夫女足票房破10亿', 900);
    await hot('douyin', 2, '世界人工智能大会今日开幕', 800);
    await hot('toutiao', 1, '气象台不敢报40℃是谣言', 700);
    await clusterHotTopics();
    await generateRecommendations(accountId, workspaceId, 6);
    const ideas = await prisma.topicIdea.findMany({ where: { accountId } });
    expect(ideas.length).toBeGreaterThan(0);
  });
});
