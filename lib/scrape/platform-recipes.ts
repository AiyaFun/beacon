import { prisma } from '../db';
import { RECIPE_PLATFORMS } from '../browser-task/kinds';
import type { RecipeField } from './recipe';

// ── 内置平台配方（2026-09-15）────────────────────────────────────────────
//
// 【为什么不给这五个平台各写一个内容脚本】微博 / 快手 / 知乎 / 头条号 / 百家号在 PLATFORMS 里
// 躺了一个月，插件对它们只有「发布填充」一条路，竞对一个字都采不到。再手写五个解析器，
// 就是再养五个「改版即碎、要真机校准、要发版」的包袱——而任意站点采集配方那条链
//（骨架上传 → 模型推断 → 逐 token 验证 → 下发）已经在跑，它天生就是为「没有手写解析器的站点」造的。
// 所以这五个平台走配方：服务端按工作区**自动播一份**，第一次打开主页时插件交骨架、
// 服务端学出规则，之后按规则采；改版了就自动重学。校准从此发生在真实用户的真实页面上，
// 不发生在开发机上（开发机上打不开这些页面，这也是它们迟迟没有解析器的真实原因）。
//
// 【字段是固定的位置契约】配方的字段 key 只能是 f1..f12（sanitizeValues），
// 而竞对入库需要知道「哪个 key 是粉丝数、哪个是链接」。所以内置配方的字段顺序**写死**，
// lib/scrape/platform-map.ts 按同一份契约把行映射成竞对作品。改这份顺序 = 改两处。
//
// 【它是配方，不是爬虫】仍然只在用户自己的浏览器里读**已订阅竞对**的公开主页；
// 站点要先由用户在侧边栏授权一次（optional_host_permissions，不进安装权限）；
// 站点权利人申请停采后 GET 不再下发、POST 不再收（app/api/ingest/recipe/route.ts 的闸）。

export type RecipePlatform = (typeof RECIPE_PLATFORMS)[number];

export type PlatformRecipeSemantic =
  | 'followers' | 'name' | 'post.title' | 'post.url' | 'post.views' | 'post.likes' | 'post.comments' | 'post.publishedAt';

/** 固定位置契约：f1..f8 各是什么。label 是给模型看的人话，semantic 是给映射用的机器名。 */
export const PLATFORM_RECIPE_FIELDS: readonly (RecipeField & { semantic: PlatformRecipeSemantic })[] = [
  { key: 'f1', label: '粉丝数', semantic: 'followers' },
  { key: 'f2', label: '账号昵称', semantic: 'name' },
  { key: 'f3', label: '作品标题', semantic: 'post.title' },
  { key: 'f4', label: '作品链接', semantic: 'post.url' },
  { key: 'f5', label: '播放或阅读数', semantic: 'post.views' },
  { key: 'f6', label: '点赞数', semantic: 'post.likes' },
  { key: 'f7', label: '评论数', semantic: 'post.comments' },
  { key: 'f8', label: '发布时间', semantic: 'post.publishedAt' },
];

export const FIELD_KEY_OF: Record<PlatformRecipeSemantic, string> = Object.fromEntries(
  PLATFORM_RECIPE_FIELDS.map((f) => [f.semantic, f.key]),
) as Record<PlatformRecipeSemantic, string>;

/**
 * 五个平台的入口。pathPattern 只支持前缀匹配（插件 recipeForUrl：origin 全等 + pathname 前缀），
 * 微博主页有 /u/<uid> 与 /n/<昵称> 两种形态，所以不限路径（null = 整个 origin）。
 */
export const PLATFORM_RECIPE_SEEDS: Record<RecipePlatform, { name: string; origin: string; pathPattern: string | null }> = {
  weibo: { name: '微博主页（内置）', origin: 'https://weibo.com', pathPattern: null },
  kuaishou: { name: '快手主页（内置）', origin: 'https://www.kuaishou.com', pathPattern: '/profile/*' },
  zhihu: { name: '知乎主页（内置）', origin: 'https://www.zhihu.com', pathPattern: '/people/*' },
  toutiao: { name: '头条号主页（内置）', origin: 'https://www.toutiao.com', pathPattern: '/c/user/token/*' },
  baijiahao: { name: '百家号主页（内置）', origin: 'https://author.baidu.com', pathPattern: '/home/*' },
};

export function isRecipePlatform(p: string): p is RecipePlatform {
  return (RECIPE_PLATFORMS as readonly string[]).includes(p);
}

/**
 * 给一个工作区播齐五份内置配方（幂等）。挂在插件拉配方那条 GET 上：
 * 装了插件的工作区第一次拉清单就有了，没装插件的工作区一份都不建。
 * 并发两次 GET 撞上时靠 (workspaceId, platformKey) 唯一索引兜底，撞了就当已存在。
 */
export async function ensurePlatformRecipes(tenantId: string, workspaceId: string): Promise<{ created: number }> {
  const existing = await prisma.scrapeRecipe.findMany({
    where: { workspaceId, platformKey: { not: null } },
    select: { platformKey: true },
  });
  const have = new Set(existing.map((r) => r.platformKey));
  let created = 0;
  for (const key of RECIPE_PLATFORMS) {
    if (have.has(key)) continue;
    const seed = PLATFORM_RECIPE_SEEDS[key];
    try {
      await prisma.scrapeRecipe.create({
        data: {
          tenantId, workspaceId,
          name: seed.name, origin: seed.origin, pathPattern: seed.pathPattern,
          fields: JSON.stringify(PLATFORM_RECIPE_FIELDS.map(({ key: k, label }) => ({ key: k, label }))),
          rules: '[]', options: '{}', status: 'learning',
          createdBy: 'system:platform', platformKey: key,
        },
      });
      created += 1;
    } catch (e) {
      // P2002 = 唯一索引冲突（另一个请求刚建好）。别的错照抛
      if (!(e && typeof e === 'object' && (e as { code?: string }).code === 'P2002')) throw e;
    }
  }
  return { created };
}
