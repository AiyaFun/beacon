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
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const argv = process.argv.slice(2);
const cmd = argv[0] || 'list';
const id = argv[1] && !argv[1].startsWith('--') ? argv[1] : '';
const APPLY = argv.includes('--apply');
const ALL = argv.includes('--all');

// 与 lib/legal/removal.ts 同一套语义，但脚本走独立 PrismaClient（不经 Next 运行时），
// 故这里直接用 Prisma 实现，避免把 app 侧的模块图拖进来。
async function purge(platform: string, handle: string) {
  const account = await prisma.competitorAccount.findUnique({ where: { platform_handle: { platform, handle } }, select: { id: true, name: true } });
  if (!account) return { accounts: 0, posts: 0, watchlistItems: 0, name: '' };
  const posts = await prisma.crawledPost.count({ where: { competitorId: account.id } });
  const watchlistItems = await prisma.watchlistItem.count({ where: { competitorId: account.id } });
  if (APPLY) await prisma.competitorAccount.delete({ where: { id: account.id } });
  return { accounts: 1, posts, watchlistItems, name: account.name };
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
    const p = await purge(req.platform, req.handle); // APPLY=false ⇒ 只统计不删
    console.log(`\n核验成立将删除：竞对档案 ${p.accounts} 个（${p.name || '未入库'}）· 作品 ${p.posts} 条 · 订阅关系 ${p.watchlistItems} 条`);
    console.log('（用户自己基于该账号产出的选题/草稿/记忆不删——那是第三方的创作产物，不属于被申请人的个人信息）');
    return;
  }

  if (cmd === 'verify' || cmd === 'reject') {
    const status = cmd === 'verify' ? 'removed' : 'rejected';
    console.log(`${APPLY ? '执行' : '[dry-run] 将'}把申请 ${id}（${req.platform}/${req.handle}）标记为 ${status}`);
    if (cmd === 'verify') {
      const p = await purge(req.platform, req.handle);
      console.log(`${APPLY ? '已删除' : '将删除'}：竞对档案 ${p.accounts} 个 · 作品 ${p.posts} 条 · 订阅关系 ${p.watchlistItems} 条`);
    } else {
      console.log('驳回后该账号恢复采集——确认申请人确实无权代表该账号再执行。');
    }
    if (!APPLY) {
      console.log('\n未加 --apply，什么都没改。');
      return;
    }
    await prisma.dataRemovalRequest.update({ where: { id }, data: { status, resolvedAt: new Date() } });
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
