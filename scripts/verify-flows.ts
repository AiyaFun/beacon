// 核心引擎流程验证：逐条实跑，打印 PASS/FAIL。独立于 UI，可随时运行。
import { prisma } from '../lib/db';
import { firstWorkspaceSession as getSession } from '../lib/script-session';
import { fetchAllHot } from '../lib/adapters/registry';
import { ingestHot, clusterHotTopics, crawlCompetitors, generateRecommendations } from '../lib/pipeline';
import { checkText, hasRedline } from '../lib/compliance/engine';
import { writeMemory, recallForInjection, buildMemoryContext } from '../lib/memory/core';
import { llmComplete } from '../lib/llm/gateway';
import { encryptKey, decryptKey, maskKey } from '../lib/crypto';
import { coarseRank } from '../lib/topic/scoring';
import { readPersona } from '../lib/persona';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

// 保证有一个被监控的竞对账号（幂等）。seed 不建演示数据，前置数据由脚本自备。
async function ensureWatchlist(workspaceId: string): Promise<void> {
  const competitor = await prisma.competitorAccount.upsert({
    where: { platform_handle: { platform: 'douyin', handle: 'verify_flows_demo' } },
    update: {},
    create: { platform: 'douyin', handle: 'verify_flows_demo', name: '验证脚本用对标账号', followers: 100000 },
  });
  await prisma.watchlistItem.upsert({
    where: { workspaceId_competitorId: { workspaceId, competitorId: competitor.id } },
    update: {},
    create: { workspaceId, competitorId: competitor.id, label: '验证脚本' },
  });
}

async function main() {
  console.log('\n━━━ 烽火台核心流程验证 ━━━\n');
  const s = await getSession();
  console.log(`会话: 租户=${s.tenantId.slice(0,8)} 账号=${s.accountId.slice(0,8)} 计划=${s.plan}\n`);

  // 1. 数据源适配器（五通道 → 热榜）
  console.log('【1】数据源适配器 fetchAllHot（开源主源→Mock兜底）');
  const hot = await fetchAllHot();
  check('返回9个源', hot.length === 9, `实得 ${hot.length}`);
  check('每源有条目', hot.every(h => h.entries.length > 0), `抖音 ${hot.find(h=>h.source==='douyin')?.entries.length} 条`);
  check('降级标记存在', hot.every(h => typeof h.degraded === 'boolean'), `via=${hot[0]?.via}`);

  // 2. 热榜采集入库
  console.log('\n【2】热榜采集入库 ingestHot');
  const ing = await ingestHot();
  check('写入热榜条目', ing.inserted > 0, `插入 ${ing.inserted} 条，降级源 ${ing.degraded.length} 个`);
  const hotCount = await prisma.hotItem.count();
  check('库内热榜非空', hotCount > 0, `库内 ${hotCount} 条`);

  // 3. 跨源聚类
  console.log('\n【3】跨源话题聚类 clusterHotTopics');
  const clu = await clusterHotTopics();
  // ⚠️ 原断言是 `clu.clusters >= 0` —— 恒真，永远不可能红，等于没测。
  // 换成三条**与数据量无关**的真实不变式（跨源簇数量取决于当天热榜，不能拿来当断言）：
  const dbClusters = await prisma.topicCluster.findMany({ include: { hotItems: { select: { source: true } } } });
  check('产出聚类（报告数与库内一致）', clu.clusters === dbClusters.length, `新增 ${clu.clusters} 个跨源簇 / 库内 ${dbClusters.length} 个`);
  // 每个簇都必须真的跨源（≥2 个不同平台）。硬编码 slice(0,2) 之类的"假聚类"会在这里露馅。
  const notCross = dbClusters.filter(c => new Set(c.hotItems.map(i => i.source)).size < 2);
  check('每个簇都真跨源（≥2 个不同平台）', notCross.length === 0, `不合格 ${notCross.length} 个${notCross[0] ? `（如「${notCross[0].title}」）` : ''}`);
  // 簇是每轮派生物，不该有没有成员的孤儿累积（历史上攒过 73 个）
  const orphans = dbClusters.filter(c => c.hotItems.length === 0);
  check('无孤儿簇（每轮全量重建）', orphans.length === 0, `孤儿 ${orphans.length} 个`);
  // 敏感簇不给摘要（F1-4 AC④）
  const sensitiveWithSummary = dbClusters.filter(c => c.isSensitive && c.summary);
  check('敏感簇 summary 为空（F1-4 AC④）', sensitiveWithSummary.length === 0, `敏感 ${dbClusters.filter(c=>c.isSensitive).length} 个，其中带摘要 ${sensitiveWithSummary.length} 个`);

  // 4. 竞对采集
  console.log('\n【4】竞对采集 crawlCompetitors');
  // 自造监控对象：seed 按设计不建任何演示数据（「登录即开通干净空账号」），
  // 库里本来就不会有 WatchlistItem —— 这里不自造，本检查在全新 setup 后恒为 0/0 恒假。
  // 与 【5】 自造人设同理：被测的是 crawlCompetitors 本身，前置数据该由脚本负责。
  await ensureWatchlist(s.workspaceId);
  const cr = await crawlCompetitors(s.workspaceId);
  check('采集竞对作品', cr.posts > 0, `${cr.accounts} 个账号 / ${cr.posts} 条作品`);

  // 5. 两阶段打分 — 阶段一粗排
  console.log('\n【5】选题打分 阶段一：特征粗排 coarseRank');
  const account = await prisma.creatorAccount.findUnique({ where: { id: s.accountId } });
  // 人设显式构造，不读库：seed 按设计不建演示账号（登录即开通干净空账号，personaCard 为空），
  // 读库会拿到空人设 → 无 2-gram 指纹可匹配 → 只能按热度排 → 本检查恒假。
  // 候选本来就是脚本自造的，人设一并自造才测得到「按人设重排」这个意图本身。
  const persona = { ...readPersona(account!.personaCard), identity: '内容创作者成长教练', niche: '起号涨粉', valueProp: '帮新人起号找选题' };
  const cands = [
    { title: '起号第一周该做什么', heat: 0.9, sourceType: 'hot' },
    { title: '完全无关的体育新闻', heat: 0.95, sourceType: 'hot' },
    { title: '选题没灵感怎么办', heat: 0.6, sourceType: 'hot' },
  ];
  const ranked = coarseRank(cands, persona);
  check('粗排按人设匹配重排（相关选题排到无关新闻之前）',
    ranked.findIndex(c => c.title.includes('起号')) < ranked.findIndex(c => c.title.includes('体育')),
    `首位: ${ranked[0].title}`);

  // 6. 完整推荐管线（阶段二 LLM 精排走 Mock）
  console.log('\n【6】生成今日推荐 generateRecommendations（含LLM精排/Mock）');
  const rec = await generateRecommendations(s.accountId, s.workspaceId, 6);
  check('生成推荐选题', rec.created > 0, `生成 ${rec.created} 条`);
  const recs = await prisma.topicIdea.findMany({ where: { accountId: s.accountId, state: 'recommended' } });
  const withAngle = recs.filter(r => r.angle && r.angle.length > 2);
  check('每条含差异化切入角（强制字段）', withAngle.length === recs.length, `${withAngle.length}/${recs.length} 有 angle`);
  const withSixDim = recs.filter(r => { const sc = JSON.parse(r.scores||'{}'); return sc.traffic!=null && sc.differentiation!=null; });
  check('每条含六维评分', withSixDim.length === recs.length, `${withSixDim.length}/${recs.length} 有六维`);
  check('末位留探索位', recs.some(r => r.isExploration), `探索位 ${recs.filter(r=>r.isExploration).length} 个`);

  // 7. 敏感词合规引擎（DFA 四级词库 + 分平台）
  console.log('\n【7】敏感词合规引擎 checkText（DFA + 四级 + 分平台）');
  const bad = '这是全网最好的教程，加我微信和QQ免费领，100%有效';
  const dy = await checkText(bad, 'douyin', s.tenantId);
  check('抖音检测命中（含法律级"最好/100%有效" + 平台级"微信"）', dy.hits.length >= 2, `命中 ${dy.hits.map(h=>h.word).join('/')}`);
  check('风险等级=block（法律级block词）', dy.riskLevel === 'block', `riskLevel=${dy.riskLevel}`);
  const xhs = await checkText(bad, 'xiaohongshu', s.tenantId);
  // 用 QQ 而不是微信来验分平台差异：词库（prisma/seed.ts:272/323/381）**故意**把「微信」同时挂在
  // douyin/xiaohongshu/bilibili 三个平台上（小红书确实也禁微信导流），拿它当差异化样本是错的样本。
  // 「QQ」只挂 douyin（seed.ts:281），才真的能证明 platform 列在过滤而不是摆设。
  // （原断言写的是「小红书不命中微信」——那是 42 条词库时代的事实，词库扩到 402 条后已不成立。）
  const dyHasQQ = dy.hits.some(h=>h.word==='QQ');
  const xhsHasQQ = xhs.hits.some(h=>h.word==='QQ');
  const xhsHasWx = xhs.hits.some(h=>h.word==='微信');
  check('分平台差异生效（"QQ"只挂抖音，小红书不命中它）', dyHasQQ && !xhsHasQQ, `抖音命中QQ=${dyHasQQ} 小红书命中QQ=${xhsHasQQ}`);
  check('"微信"按词库设计在抖音/小红书都该命中（不是漏，是词库就这么定的）', xhsHasWx, `小红书命中微信=${xhsHasWx}`);
  check('命中项带改写建议', dy.hits.some(h=>h.suggestion), dy.hits.find(h=>h.suggestion)?.suggestion || '');
  const clean = await checkText('分享一些我的真实经验，仅供参考', 'douyin', s.tenantId);
  check('干净文本 → pass', clean.riskLevel === 'pass', `riskLevel=${clean.riskLevel}`);
  check('红线检测 hasRedline 生效', await hasRedline(bad) === true);

  // 8. 长期记忆（置信度累计生效）
  console.log('\n【8】长期记忆 writeMemory（推断类需累计 ≥2 次才生效）');
  await prisma.memoryEntry.deleteMany({ where: { workspaceId: s.workspaceId, content: '__验证用_偏好X' } });
  const m1 = await writeMemory({ workspaceId: s.workspaceId, accountId: s.accountId, type: 'preference', content: '__验证用_偏好X', confidence: 0.3 });
  check('首次写入 → 未生效（active=false）', m1.active === false, `confidence=${m1.confidence} active=${m1.active}`);
  const m2 = await writeMemory({ workspaceId: s.workspaceId, accountId: s.accountId, type: 'preference', content: '__验证用_偏好X' });
  check('第二次累计 → 生效（active=true）', m2.active === true, `hitCount=${m2.hitCount} confidence=${m2.confidence.toFixed(1)}`);
  const inj = await recallForInjection(s.workspaceId, s.accountId);
  check('记忆可召回注入', inj.length > 0, `召回 ${inj.length} 条`);
  const ctx = await buildMemoryContext(s.workspaceId, s.accountId);
  check('记忆上下文块生成', ctx.includes('长期记忆'), `${ctx.length} 字符`);
  await prisma.memoryEntry.deleteMany({ where: { workspaceId: s.workspaceId, content: '__验证用_偏好X' } });

  // 9. LLM 网关（五功能路由 + Mock 兜底）
  console.log('\n【9】LLM 网关 llmComplete（无key→Mock，永不抛错）');
  for (const fn of ['scoring','generation','advisor','compliance','chat'] as const) {
    const r = await llmComplete(s.tenantId, fn, [{ role:'user', content: `测试 ${fn} 功能` }], { json: fn==='scoring'||fn==='advisor' });
    check(`功能 ${fn} 返回内容`, r.text.length > 0, `mocked=${r.mocked} 长度=${r.text.length}`);
  }

  // 10. BYOK 密钥加密
  console.log('\n【10】BYOK 密钥加密 crypto');
  const key = 'sk-test-1234567890abcdef';
  const enc = encryptKey(key);
  check('加解密可逆', decryptKey(enc) === key, `密文 ${enc.slice(0,20)}...`);
  check('脱敏展示', maskKey(key) === 'sk-t····cdef', maskKey(key));
  check('密文非明文', !enc.includes(key));

  console.log(`\n━━━ 结果：${pass} PASS / ${fail} FAIL ━━━`);
  // 恢复干净的演示数据
  console.log('（恢复演示种子数据…）');
}

main().catch(e => { console.error('验证脚本异常:', e); process.exit(1); }).finally(() => prisma.$disconnect());
