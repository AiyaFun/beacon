import type { CompetitorPostEntry, CompetitorAdapter, HotEntry, HotListAdapter } from './types';

// Mock 数据源：零配置跑通全流程。热榜/竞对作品均生成确定性的高仿数据。

const HOT_SAMPLES: Record<string, string[]> = {
  douyin: ['00后整顿职场新姿势', '这届年轻人开始反向消费', '一个人也要好好吃饭', '副业月入过万是真的吗', '手机摄影三个隐藏技巧'],
  weibo: ['专家建议年轻人不要频繁跳槽', '城市漫步成新潮流', '国货美妆集体涨价', '打工人的早八自救指南', 'AI 会取代哪些岗位'],
  bilibili: ['我用一个月学会了剪辑', '大学生返乡创业实录', '深度拆解爆款视频结构', '自媒体新手避坑指南', '普通人如何做知识付费'],
  zhihu: ['如何看待内容同质化严重', '为什么你的选题总没流量', '普通人做 IP 的正确路径', '小成本内容创业可行吗', '算法到底喜欢什么内容'],
  baidu: ['短视频运营最新政策', '创作者扶持计划上线', '直播带货新规解读', '内容合规红线有哪些', '各平台流量扶持对比'],
  toutiao: ['中年人转行做自媒体', '图文创作还有机会吗', '爆款标题的底层逻辑', '如何三个月起号', '内容变现的五种方式'],
  xiaohongshu: ['素人也能爆的笔记选题', '封面决定 80% 点击', '小红书搜索流量玩法', '起号第一周做什么', '如何找到对标账号'],
  youtube: ['How creators plan content', 'The 3-second hook rule', 'Small channel growth tips', 'Thumbnail A/B testing', 'Retention curve explained'],
  x: ['The creator economy in 2026', 'Why niche beats broad', 'Thread writing formula', 'Growth without ads', 'Algorithm signals decoded'],
};

function seededMetric(seed: string, base: number, spread: number): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return base + (h % spread);
}

export class MockHotAdapter implements HotListAdapter {
  readonly name = 'mock-hot';
  readonly kind = 'mock' as const;
  readonly sources = Object.keys(HOT_SAMPLES);

  async fetchHot(source: string): Promise<HotEntry[]> {
    const list = HOT_SAMPLES[source] ?? HOT_SAMPLES.weibo;
    return list.map((title, i) => ({
      source,
      rank: i + 1,
      title,
      url: '#',
      heat: seededMetric(title, 100000, 900000),
      extra: {},
    }));
  }

  async health() {
    return { ok: true, detail: 'mock always healthy' };
  }
}

const POST_TITLES = [
  '我做内容的第一年，踩过的5个坑',
  '为什么你的完播率一直上不去',
  '这个选题公式让我涨粉10万',
  '普通人起号最容易忽略的一步',
  '拆解一条百万播放视频的结构',
  '3个技巧提升你的开头留存',
  '我是怎么找到差异化定位的',
];

export class MockCompetitorAdapter implements CompetitorAdapter {
  readonly name = 'mock-competitor';
  readonly kind = 'mock' as const;
  readonly platform: string;

  constructor(platform: string) {
    this.platform = platform;
  }

  async fetchPosts(handle: string): Promise<CompetitorPostEntry[]> {
    return POST_TITLES.map((title, i) => {
      const seed = `${handle}-${title}`;
      const views = seededMetric(seed, 20000, 2000000);
      return {
        platform: this.platform,
        platformItemId: `${handle}-${i}`,
        title,
        summary: '（Mock）该作品围绕新手成长与实操经验展开，互动集中在评论区求教程。',
        url: '#',
        publishedAt: new Date(Date.now() - i * 86400000 * 2),
        metrics: {
          views,
          likes: Math.round(views * 0.06),
          comments: Math.round(views * 0.01),
          shares: Math.round(views * 0.008),
          collects: Math.round(views * 0.03),
        },
      };
    });
  }

  async health() {
    return { ok: true, detail: 'mock always healthy' };
  }
}
