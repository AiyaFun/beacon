/**
 * 被监控账号移除申请（PIPL 拒绝权）的**运营处理台**。
 *
 * 为什么需要它：公开表单只负责收，采集闸只负责挡。此前没有任何入口能核验、驳回或
 * 真正执行移除——所有申请永远停在 pending，而 pending 就等于**全平台停采该账号**。
 * 没有这一步，权利人的诉求兑现不了，误报/冒用也纠正不了。
 *
 * 用法：
 *   DATABASE_URL="…" npx tsx scripts/removal-requests.ts list            # 列待处理（默认）
 *   DATABASE_URL="…" npx tsx scripts/removal-requests.ts list --all      # 含已处理
 *   DATABASE_URL="…" npx tsx scripts/removal-requests.ts show <id>       # 单条详情 + 会删掉什么
 *   DATABASE_URL="…" npx tsx scripts/removal-requests.ts verify <id> --apply   # 核验成立：停采 + 删已采数据
 *   DATABASE_URL="…" npx tsx scripts/removal-requests.ts reject <id> --apply   # 核验不成立：恢复采集
 *
 * 三条口径：
 *  1. **默认 dry-run**。verify 会删数据（不可逆），不加 --apply 只打印将删什么。
 *  2. 核验身份这一步在**线下**做（申请人填的 contact），脚本不代替判断，只执行结论。
 *  3. reject 之后该账号恢复采集——所以驳回要有理由，别拿它当「先放着」的抽屉。
 */
import { prisma } from '../lib/db';
import { purgeRemovedAccountData, removalHandleVariants, resolveRemovalRequest, countRemovedSiteData, countRemovedComment, COMMENT_KIND, SITE_KIND } from '../lib/legal/removal';

const argv = process.argv.slice(2);
const cmd = argv[0] || 'list';
const id = argv[1] && !argv[1].startsWith('--') ? argv[1] : '';
const APPLY = argv.includes('--apply');
const ALL = argv.includes('--all');

// ⚠️ 这里曾经是一份**独立实现**（自己 new PrismaClient、自己查 competitorAccount 再删），
// 注释写着「与 lib/legal/removal.ts 同一套语义」——但它并不是，而且是三处实打实的差：
//   ① 完全没删读者提问（InspirationItem source='rival-comment'）；
//   ② handle 精确匹配，差一个 @ 或大小写就一条都删不到（lib 那侧专门做了变体与兜底）；
//   ③ 没删采集台账（CollectionRun）。
// 也就是说：运营用这个脚本处理完申请、告诉权利人「已删除」，评论区提取的内容其实还在库里。
// 2026-08-11 接入评论正文时一并修掉——正文比提问更不能留。
//
// 现在直接复用 lib 那份唯一实现。「同一套语义」这句话只有靠同一段代码才成立，
// 靠注释维持的一致性迟早会漂（这次就漂了）。
// ⚠️ **2026-08-29 又漂了一次，而且更严重**：这个脚本从头到尾**没判过 kind**。
// 加了 comment（读者删自己那条评论，08-11）与 site（站点权利人停采，08-29）两类之后：
//   · comment 类：脚本把**作品链接**当账号 handle 传进 purgeRemovedAccountData，
//     而那里是按 author（账号 handle）删评论的——永远匹配不上，**一条都删不掉**，
//     还报「0 条」。而隐私政策白纸黑字写着读者本人可以要求删除自己那条评论 → **空承诺**。
//   · site 类：platform='site' 查不到任何竞对档案，同样删 0 条（已实测证实）。
// 而按 kind 分叉的那份实现（resolveRemovalRequest）**生产零调用点，只有测试在调**。
//
// 修法与上次同一条：**apply 那条路直接走 resolveRemovalRequest**，
// 它是唯一同时认得三种 kind 的实现。dry-run 只负责数，且每一类的数法与它逐项对齐。
async function countFor(req: { kind: string; platform: string; handle: string; commentText: string | null }) {
  if (req.kind === SITE_KIND) {
    const c = await countRemovedSiteData(req.handle);
    return { kind: 'site' as const, ...c };
  }
  if (req.kind === COMMENT_KIND) {
    return { kind: 'comment' as const, comments: await countRemovedComment(req.platform, req.commentText ?? '') };
  }
  return { kind: 'account' as const, ...(await purgeAccountDryRun(req.platform, req.handle)) };
}

async function purgeAccountDryRun(platform: string, handle: string) {
  // 只数不删。数法必须与真删那条路径逐项对齐。
  {
    const variants = removalHandleVariants(platform, handle);
    const account = await prisma.competitorAccount.findFirst({
      where: { platform, handle: { in: variants } },
      select: { id: true, name: true },
    });
    const [commentQuestions, readerComments] = await Promise.all([
      prisma.inspirationItem.count({ where: { source: 'rival-comment', platform, author: { in: variants } } }),
      prisma.readerComment.count({ where: { scope: 'rival', platform, author: { in: variants } } }),
    ]);
    if (!account) return { accounts: 0, posts: 0, watchlistItems: 0, runs: 0, commentQuestions, readerComments, name: '' };
    const [posts, watchlistItems, runs] = await Promise.all([
      prisma.crawledPost.count({ where: { competitorId: account.id } }),
      prisma.watchlistItem.count({ where: { competitorId: account.id } }),
      prisma.collectionRun.count({ where: { scope: 'rival', targetId: account.id } }),
    ]);
    return { accounts: 1, posts, watchlistItems, runs, commentQuestions, readerComments, name: account.name };
  }
}

/** 每一类说自己那几项。混成一句会让运营看到一堆恒为 0 的字段，读不出重点。 */
function purgeLine(p: Awaited<ReturnType<typeof countFor>>): string {
  if (p.kind === 'site') {
    return `采集记录 ${p.records} 条 · 停用配方 ${p.recipes} 个（配方本身不删——那是用户自己写的东西）`;
  }
  if (p.kind === 'comment') {
    return `读者原声 ${p.comments} 条（只删这一条，不碰作品作者的任何数据）`;
  }
  return [
    `竞对档案 ${p.accounts} 个${p.name ? `（${p.name}）` : ''}`,
    `作品 ${p.posts} 条`,
    `订阅关系 ${p.watchlistItems} 条`,
    `采集台账 ${p.runs} 条`,
    `读者提问 ${p.commentQuestions} 条`,
    `读者原声 ${p.readerComments} 条`,
  ].join(' · ');
}

async function main() {
  if (cmd === 'list') {
    const rows = await prisma.dataRemovalRequest.findMany({
      where: ALL ? {} : { status: 'pending' },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    if (rows.length === 0) {
      console.log(ALL ? '（一条申请都没有）' : '（没有待处理申请）');
      return;
    }
    for (const r of rows) {
      console.log(
        [
          r.id,
          r.status.padEnd(8),
          `${r.platform}/${r.handle}`.padEnd(36),
          r.createdAt.toISOString().slice(0, 16).replace('T', ' '),
          r.contact,
          r.reason ? `理由：${r.reason.slice(0, 60)}` : '',
        ].join('  '),
      );
    }
    console.log(`\n共 ${rows.length} 条。处理：verify <id> --apply / reject <id> --apply`);
    return;
  }

  if (!id) throw new Error(`用法：${cmd} <申请 id> [--apply]`);
  const req = await prisma.dataRemovalRequest.findUnique({ where: { id } });
  if (!req) throw new Error(`申请不存在：${id}`);

  if (cmd === 'show') {
    console.log(JSON.stringify({ ...req, createdAt: req.createdAt.toISOString() }, null, 2));
    const p = await countFor(req); // 只统计不删
    console.log(`\n核验成立将删除：${purgeLine(p)}`);
    console.log('（用户自己基于该账号产出的选题/草稿/记忆不删——那是第三方的创作产物，不属于被申请人的个人信息）');
    return;
  }

  if (cmd === 'verify' || cmd === 'reject') {
    const status = cmd === 'verify' ? 'removed' : 'rejected';
    console.log(`${APPLY ? '执行' : '[dry-run] 将'}把申请 ${id}（${req.platform}/${req.handle}）标记为 ${status}`);
    if (cmd === 'verify') {
      // 先数（不删），apply 时再由 resolveRemovalRequest 真删——
      // **数和删必须是同一套判据**，所以数走 countFor、删走那份唯一实现，不再各写一份
      const p = await countFor(req);
      console.log(`${APPLY ? '将删除' : '将删除'}：${purgeLine(p)}`);
    } else {
      console.log('驳回后该账号恢复采集——确认申请人确实无权代表该账号再执行。');
    }
    if (!APPLY) {
      console.log('\n未加 --apply，什么都没改。');
      return;
    }
    // 【走那份唯一实现】它是**唯一**同时认得 account / comment / site 三种 kind 的地方，
    // 而且状态流转与执行删除在它内部是一起发生的。
    // 这个脚本以前自己 update 状态 + 自己调 purgeRemovedAccountData，
    // 于是 comment 与 site 两类被静默跳过（报 0 条，其实一条都没删）。
    const r = await resolveRemovalRequest(id, status as 'removed' | 'rejected');
    if (!r.ok) throw new Error(r.error ?? '处理失败');
    if (r.purged) {
      console.log(
        `实际删除：竞对档案 ${r.purged.accounts} · 作品 ${r.purged.posts} · 订阅 ${r.purged.watchlistItems}`
        + ` · 台账 ${r.purged.runs} · 读者提问 ${r.purged.commentQuestions} · 读者原声 ${r.purged.readerComments}`
        + ` · 采集记录 ${r.purged.scrapeRecords} · 停用配方 ${r.purged.scrapeRecipes}`
        + ` · 引用回执 ${r.purged.aiCitations}`,
      );
    }
    console.log('✅ 已处理。记得按 contact 回复申请人处理结果（PIPL 要求告知）。');
    return;
  }

  throw new Error(`未知命令：${cmd}（可用：list / show / verify / reject）`);
}

main()
  .catch((e) => {
    console.error('❌', (e as Error).message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
