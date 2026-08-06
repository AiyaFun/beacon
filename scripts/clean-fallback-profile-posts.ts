// 清理「主页被当成一条作品」的历史脏数据（一次性运维脚本）。
//
// 背景：2026-07-29 之前，抖音 / B站 / 小红书的**主页解析器整个是死代码**——
// manifest 里主页脚本与作品页脚本同属一条 content_scripts 规则，作品页脚本（douyin-video.js /
// bili-video.js / xhs-note.js）直接覆盖了 `__beaconParse`，于是在主页上跑的是作品页解析器，
// 它一看路径不是 /video/ 就返回 null，common.js 随即退回 `beaconFallbackParse()`。
// 兜底解析器是给「认不出的页面」写的，它在主页上会产出**一条把主页本身当成作品**的记录：
//
//   platformItemId = 账号的 handle（sec_user_id / mid / user_id）  ← 决定性特征
//   url            = 主页地址（/user/…、space.bilibili.com/<mid>、/user/profile/…）
//   metrics        = {}（一个指标都没有）
//   竞对名          = 'small红书/社交创作者' 那句写死的兜底文案（当页面没有 og:title 时）
//
// 代码侧已经堵死（三个作品页脚本改成接力 + tests/ingest/parser-chain.test.ts 钉死行为），
// 但**已经写进库的记录不会自己消失**：它们会以「一条零指标的作品」出现在竞对作品列表里，
// 还会被 buildBaseline 当成竞对基准参与计算。要用本脚本清一次。
//
// 用法（默认试运行，只打印不删）：
//   npx tsx scripts/clean-fallback-profile-posts.ts          # 看看会删哪些
//   npx tsx scripts/clean-fallback-profile-posts.ts apply    # 真删
//
// 生产上跑（在 web 容器里，DATABASE_URL 已注入）：
//   docker exec beacon-web-1 node_modules/.bin/tsx scripts/clean-fallback-profile-posts.ts
//   docker exec beacon-web-1 node_modules/.bin/tsx scripts/clean-fallback-profile-posts.ts apply
//
// 判据同 clean-mock-competitor-posts.ts 的思路：**两个特征同时成立才算命中**——
// `platformItemId === 竞对的 handle` **且** url 是主页形态。
// 只按 platformItemId 一条筛也几乎不会误伤（真实作品 ID 与账号 ID 撞车的概率极低），
// 但主页 url 这一条是免费的双保险，宁可漏删一条也不误删用户真实采到的作品。
//
// 另外单独列出（**不自动改**）名字是兜底文案的竞对：改名会覆盖用户可能已经手工修过的名字，
// 交给人看一眼再决定。重新采一次主页就会用真实昵称覆盖它。

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// beaconFallbackParse 里那句写死的作者名兜底（extension/content/common.js）
const FALLBACK_NAME = '小红书/社交创作者';

// 主页地址形态。这里**不用平台白名单**：兜底解析在任何站点上都可能产出这种记录，
// 而判据的主力是「platformItemId === handle」，url 只作二次确认。
function looksLikeProfileUrl(url: string | null, handle: string): boolean {
  if (!url) return false;
  const u = url.toLowerCase();
  const h = handle.toLowerCase();
  if (!u.includes(h)) return false; // 主页地址里一定带账号 ID
  return (
    /\/user\/[^/]+\/?$/.test(u) // 抖音 /user/<sec_uid>
    || /\/user\/profile\/[^/]+\/?$/.test(u) // 小红书 /user/profile/<id>
    || /space\.bilibili\.com\/\d+\/?$/.test(u) // B站空间
    || /\/@[^/]+\/?$/.test(u) // TikTok / YouTube 主页
    || /\/channel\/[^/]+\/?$/.test(u)
  );
}

async function main() {
  const apply = process.argv[2] === 'apply';

  const competitors = await prisma.competitorAccount.findMany({
    select: { id: true, handle: true, name: true, platform: true },
  });
  const byId = new Map(competitors.map((c) => [c.id, c]));

  // 先按 platformItemId 命中候选（handle 集合通常只有几十个，一次 in 查询就够）
  const handles = [...new Set(competitors.map((c) => c.handle))];
  const suspects = handles.length
    ? await prisma.crawledPost.findMany({ where: { platformItemId: { in: handles } } })
    : [];

  const hits = suspects.filter((s) => {
    const c = byId.get(s.competitorId);
    if (!c) return false;
    if (s.platformItemId !== c.handle) return false; // 必须是**它自己**的 handle，不是别人的
    return looksLikeProfileUrl(s.url, c.handle);
  });

  console.log(`${apply ? '[执行]' : '[试运行]'} 命中 ${hits.length} 条「主页被当成作品」的记录`);
  for (const h of hits) {
    const c = byId.get(h.competitorId);
    console.log(`  ${c?.platform ?? '?'} / ${c?.name ?? '(未知竞对)'} / itemId=${h.platformItemId} / ${h.url ?? ''}`);
  }

  const misnamed = competitors.filter((c) => c.name === FALLBACK_NAME);
  if (misnamed.length) {
    console.log(`\n另有 ${misnamed.length} 个竞对的名字是兜底文案「${FALLBACK_NAME}」（**本脚本不改名**）：`);
    for (const c of misnamed) console.log(`  ${c.platform} / ${c.handle}`);
    console.log('  → 用插件重新打开一次它们的主页采集即可写回真实昵称；也可以在竞对监控页手动改。');
  }

  if (!apply) {
    console.log('\n以上为试运行结果，未做任何修改。确认无误后加 apply 参数再跑一次。');
  } else if (hits.length > 0) {
    const ids = hits.map((h) => h.id);
    const snaps = await prisma.postMetricSnapshot.deleteMany({ where: { postId: { in: ids } } });
    const del = await prisma.crawledPost.deleteMany({ where: { id: { in: ids } } });
    console.log(`\n已删除作品 ${del.count} 条、指标快照 ${snaps.count} 条`);
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
