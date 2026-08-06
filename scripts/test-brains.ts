import { prisma } from '../lib/db';
import { firstWorkspaceSession as getSession } from '../lib/script-session';

async function main() {
  const s = await getSession();
  console.log('\n━━━ 新增模块大脑验证 ━━━\n');

  // 智囊团 convene
  const panel = await import('../lib/advisor/panel');
  console.log('advisor/panel 导出:', Object.keys(panel).join(', '));
  if (typeof (panel as Record<string, unknown>).convene === 'function') {
    const r = await (panel as { convene: (a: string, w: string, seed?: string) => Promise<unknown> }).convene(s.accountId, s.workspaceId, '本周没灵感');
    const sid = typeof r === 'string' ? r : ((r as Record<string, string>)?.sessionId ?? (r as Record<string, string>)?.id);
    const ops = await prisma.advisorOpinion.count({ where: { sessionId: sid } });
    console.log(`  ✅ convene() → session=${String(sid).slice(0, 8)} 落库人物意见=${ops} 条`);
  } else console.log('  ⚠️ 未导出 convene');

  // 账号体检
  if (typeof (panel as Record<string, unknown>).accountHealth === 'function') {
    const account = await prisma.creatorAccount.findUnique({ where: { id: s.accountId } });
    const posts = await prisma.ownPost.findMany({ where: { accountId: s.accountId } });
    const pubs = await prisma.publishRecord.findMany({ where: { accountId: s.accountId } });
    const h = await (panel as { accountHealth: (a: unknown, p: unknown, r: unknown) => unknown }).accountHealth(account, posts, pubs);
    console.log(`  ✅ accountHealth() → ${JSON.stringify(h).slice(0, 120)}`);
  }

  // 算法教练 diagnose
  const coach = await import('../lib/algorithm/coach');
  console.log('\nalgorithm/coach 导出:', Object.keys(coach).join(', '));
  if (typeof (coach as Record<string, unknown>).diagnose === 'function') {
    const posts = await prisma.ownPost.findMany({ where: { accountId: s.accountId } });
    const metrics = posts.map((p) => JSON.parse(p.metrics || '{}'));
    const d = (coach as { diagnose: (p: string, m: unknown[]) => unknown }).diagnose('douyin', metrics);
    const arr = Array.isArray(d) ? d : [];
    console.log(`  ✅ diagnose('douyin') → ${arr.length} 条诊断`);
    arr.slice(0, 3).forEach((x: unknown) => console.log('     •', (typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 70)));
  } else console.log('  ⚠️ 未导出 diagnose');

  console.log('');
}
main().catch((e) => { console.error('❌', e); process.exit(1); }).finally(() => prisma.$disconnect());
