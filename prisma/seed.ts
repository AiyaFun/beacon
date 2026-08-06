import { PrismaClient } from '@prisma/client';
import { seedDemo } from '../lib/demo/seed';
import { SYSTEM_WORDS, ALGORITHM_RULES, WORDLIST_VERSION, BUILTIN_SKILLS } from './system-data';

const prisma = new PrismaClient();

// 生产化种子：只灌「全局参考数据」——敏感词库（真实广告法/平台/行业词）+ 平台算法规则库。
// 不再造任何演示账号/竞对/作品/选题/记忆/发布等假数据。
// 用户用任意手机号登录即自动开通一个干净的空租户+工作区+起始账号（见 lib/auth.ts）。

async function main() {
  console.log('🌱 重建全局参考数据（清空所有内容）...');

  // 清空全部（顺序注意外键）
  await prisma.advisorOpinion.deleteMany();
  await prisma.advisorSession.deleteMany();
  await prisma.performanceSnapshot.deleteMany();
  await prisma.publishRecord.deleteMany();
  await prisma.complianceCheck.deleteMany();
  await prisma.draftVersion.deleteMany();
  await prisma.draft.deleteMany();
  await prisma.topicIdea.deleteMany();
  await prisma.memoryEntry.deleteMany();
  await prisma.postMetricSnapshot.deleteMany();
  await prisma.crawledPost.deleteMany();
  await prisma.watchlistItem.deleteMany();
  await prisma.competitorAccount.deleteMany();
  await prisma.hotItem.deleteMany();
  await prisma.topicCluster.deleteMany();
  await prisma.sensitiveWord.deleteMany();
  await prisma.algorithmRule.deleteMany();
  await prisma.modelProvider.deleteMany();
  await prisma.ownPost.deleteMany();
  await prisma.personaVersion.deleteMany();
  await prisma.taskItem.deleteMany();
  await prisma.llmCallLog.deleteMany();
  await prisma.jobRun.deleteMany();
  await prisma.authSession.deleteMany();
  await prisma.verificationCode.deleteMany();
  await prisma.creatorAccount.deleteMany();
  await prisma.member.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.tenant.deleteMany();

  // 敏感词库与算法规则的数据本体见 prisma/system-data.ts（唯一真相源，生产同步脚本共用同一份）

  await prisma.sensitiveWord.createMany({
    data: SYSTEM_WORDS.map((w) => ({
      word: w.word,
      tier: w.tier,
      platform: w.platform ?? null,
      action: w.action,
      suggestion: w.suggestion ?? null,
      category: w.category,
      version: WORDLIST_VERSION,
    })),
  });

  for (const r of ALGORITHM_RULES) {
    await prisma.algorithmRule.create({ data: { ...r, source: (r as { source?: string }).source ?? null } });
  }

  await seedContentSkills();

  // 演示（游客）租户：登录页「游客访问」的只读体验数据。与真实账号隔离（固定 DEMO_TENANT_ID）。
  await seedDemo();

  console.log(`✅ 完成：敏感词库 ${SYSTEM_WORDS.length} 条（版本 ${WORDLIST_VERSION}）· 算法规则 ${ALGORITHM_RULES.length} 条`);
  console.log('   真实用户：任意手机号登录即自动开通干净空账号。');
  console.log('   演示租户已就绪：登录页「游客访问」可免注册体验示例数据（只读）。');
}

// ── 内置内容技能（域14）：全租户可见（tenantId=null），固定 slug，按 slug upsert 幂等 ──
// 模板本身住在 `prisma/system-data.ts`（唯一真相源），这里只负责写库。
// 这样生产才能用 `scripts/sync-system-data.ts` 增量同步同一份模板——
// 以前模板只在本文件里，而本文件永不能在生产跑，改了模板生产也拿不到。
async function seedContentSkills() {
  const skills = BUILTIN_SKILLS;

  for (const skl of skills) {
    await prisma.contentSkill.upsert({
      where: { slug: skl.slug },
      update: {
        name: skl.name,
        description: skl.description,
        emoji: skl.emoji,
        platform: skl.platform,
        category: skl.category,
        outputKind: skl.outputKind,
        promptTemplate: skl.promptTemplate,
        tenantId: null,
        isBuiltin: true,
        enabled: true,
      },
      create: {
        slug: skl.slug,
        name: skl.name,
        description: skl.description,
        emoji: skl.emoji,
        platform: skl.platform,
        category: skl.category,
        outputKind: skl.outputKind,
        promptTemplate: skl.promptTemplate,
        tenantId: null,
        isBuiltin: true,
        enabled: true,
      },
    });
  }
  console.log(`✅ 内置技能 ${skills.length} 个（按 slug upsert 幂等，不动租户安装关系）`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
