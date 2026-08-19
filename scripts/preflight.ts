/**
 * 上线体检（preflight）。在正式对外开放注册前跑一遍：
 *   npx tsx scripts/preflight.ts        # 按当前 .env
 *   BEACON_ENV=prod npx tsx scripts/preflight.ts   # 以生产口径严格体检
 *
 * 它把「配了但没验过」里**能自动查的部分**一次性挡在启动前：配置完整性、连通性、
 * 以及几个「代码正确但默认部署形态不可用」的危险组合（如 prod 且 hops=0 = 全站单桶 DoS）。
 *
 * ⚠️ 它**不做破坏性动作**：不发真实短信、不下真实订单、不写业务库。那几条唯一算数的证据
 * （真手机号收码、真商户号走一笔真单再退、从备份恢复一次）必须由人手动做——见 VERIFICATION.md §四。
 * 本脚本的价值是：在你去做那几件事之前，先把「连不上/没配齐/配错组合」这类低级坑清干净。
 *
 * 退出码：有任何 FAIL → 1（可挂 CI / 部署门禁）；只有 WARN → 0。
 */
import { isProd } from '../lib/env';
import { edition, can } from '../lib/edition';
import { prisma } from '../lib/db';
import { hotSourceMode } from '../lib/adapters/registry';
import { assertMasterKey } from '../lib/crypto';
import { getSmsProvider } from '../lib/sms/provider';
import { readWxPayEnv } from '../lib/pay/provider';

type Level = 'PASS' | 'WARN' | 'FAIL';
const results: { name: string; level: Level; detail: string }[] = [];
const add = (name: string, level: Level, detail: string) => results.push({ name, level, detail });

const PROD = isProd();
// 形态：企业版（appliance/private）交付出去后没有平台主体，
// 下面几条 SaaS 专属检查对它们不成立，硬套会让装机体检满屏红。
const ED = edition();

async function run() {
  // 0. 运行口径
  add('运行环境', 'PASS', `isProd=${PROD}（NODE_ENV=${process.env.NODE_ENV ?? '-'} / BEACON_ENV=${process.env.BEACON_ENV ?? '-'}）`);
  add('部署形态', 'PASS', `${ED}${ED === 'saas' ? '' : '（企业版：无支付/无短信/AI 全 BYOK）'}`);

  // 1. 主密钥（BYOK 加解密的根）——prod 缺失/占位即拒绝启动
  try {
    assertMasterKey();
    add('主密钥 BEACON_MASTER_KEY', 'PASS', PROD ? '已注入且通过校验' : 'dev 态用默认密钥（生产必须换）');
  } catch (e) {
    add('主密钥 BEACON_MASTER_KEY', 'FAIL', (e as Error).message.split('\n')[0]);
  }

  // 2. 数据库连通 + 参考数据是否灌好
  try {
    await prisma.$queryRawUnsafe('SELECT 1');
    add('数据库连通', 'PASS', '可连接');
    try {
      const words = await prisma.sensitiveWord.count();
      const rules = await prisma.algorithmRule.count();
      if (words === 0) add('参考数据·敏感词库', 'WARN', '词库为 0 条——合规检测形同虚设，需先 npm run db:seed');
      else add('参考数据', 'PASS', `敏感词 ${words} 条 · 算法规则 ${rules} 条`);
    } catch (e) {
      add('参考数据', 'WARN', `无法统计（表可能未迁移）：${(e as Error).message.slice(0, 60)}`);
    }
  } catch (e) {
    add('数据库连通', 'FAIL', `连不上：${(e as Error).message.slice(0, 100)}`);
  }

  // 3. Redis（多实例限流/队列的原子性）——配了就必须连得上；prod 未配是隐患
  if (process.env.REDIS_URL) {
    try {
      const IORedis = (await import('ioredis')).default;
      const redis = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 3000, lazyConnect: true });
      await redis.connect();
      const pong = await redis.ping();
      await redis.quit();
      add('Redis 连通', pong === 'PONG' ? 'PASS' : 'FAIL', pong === 'PONG' ? 'PING/PONG 正常' : `异常应答：${pong}`);
    } catch (e) {
      add('Redis 连通', 'FAIL', `连不上：${(e as Error).message.slice(0, 100)}`);
    }
  } else {
    add('Redis 连通', PROD ? 'WARN' : 'PASS', PROD
      ? '未配 REDIS_URL：多实例部署下限流按每实例独立计数（实际放行量≈limit×实例数），单实例可接受'
      : 'dev 未配，走进程内实现（正常）');
  }

  // 4. 可信反代层数——prod 的头号「配了也不可用」陷阱
  const hops = process.env.BEACON_TRUSTED_PROXY_HOPS?.trim();
  // 【企业整机是例外】appliance 直接由 Next 监听 localhost，**前面没有反代**，
  // 也就不存在「XFF 可被伪造」这个威胁（请求根本不经过任何会追加转发头的东西）。
  // 但代价是真的：getClientIp 在 prod+hops=0 时一律返回 'unknown'，
  // 于是全公司共用一个限流桶。对十来人的内部机器可以接受，所以降为 WARN 而不是放行 ——
  // 放行会让这行从报告里消失，装机的人就不知道有这回事了。
  if (edition() === 'appliance') {
    add('反代层数 HOPS', 'WARN',
      '整机直连无反代：IP 限流退化为全公司共用一个桶（十来人内部使用可接受；若要按人限流，请在前面加一层反代并设为其层数）');
  } else {
  if (PROD) {
    if (!hops || hops === '0') {
      add('反代层数 HOPS', 'FAIL', 'prod 下 hops=0/未设 → 全站 IP 判 unknown → 共用一个限流桶（约 30 请求瘫痪全站登录，fail-close 型 DoS）。必须精确设为实际反代层数');
    } else if (!/^\d+$/.test(hops)) {
      add('反代层数 HOPS', 'FAIL', `值非法：${hops}`);
    } else {
      add('反代层数 HOPS', 'PASS', `=${hops}（务必等于真实反代层数：配大了会重新打开 XFF 伪造绕过）`);
    }
  } else {
    add('反代层数 HOPS', 'PASS', `dev 无需（当前 ${hops ?? '未设'}）`);
  }
  }

  // 5. 短信通道——prod 未配真实 vendor 会在此抛错（安全不变式：prod 绝不回退 Mock）
  //    企业版没有短信登录（lib/auth.ts 的 requestLoginCode 已在形态闸上直接返回），
  //    getSmsProvider() 在生产态会因为没配 vendor 而抛 —— 那个抛对 SaaS 是对的，
  //    对客户机器却是「体检因为一个不存在的功能而失败」。
  if (!can('smsLogin')) {
    add('短信通道', 'PASS', '企业版无短信登录（登录走企业应用），无需短信凭证');
  } else try {
    const sms = getSmsProvider();
    if (PROD && sms.mocked) add('短信通道', 'FAIL', '生产态竟是 Mock 通道（= 认证旁路）——不应发生');
    else add('短信通道', 'PASS', PROD ? `真实通道 ${sms.name}（提醒：过审+真手机号收码仍需人工验一次）` : `dev Mock（${sms.name}）`);
  } catch (e) {
    add('短信通道', 'FAIL', (e as Error).message.split('\n')[0]);
  }

  // 6. 平台默认 LLM——prod 未配则全站生成走 Mock 假数据
  //    企业版没有"平台垫付"这回事：AI 走客户在装机向导里填的 BYOK 渠道（存在 ModelProvider 表），
  //    env 里配不配都不是问题，所以这条整段跳过而不是降级成 WARN（降级仍会在报告里占一行红字，
  //    让装机的人以为漏了东西）。
  if (!can('platformLlmChannel')) {
    add('模型渠道', 'PASS', '企业版：AI 由客户自带 Key（装机向导写入），不使用平台垫付渠道');
  } else if (process.env.BEACON_DEFAULT_LLM_API_KEY?.trim()) {
    add('平台默认 LLM', 'PASS', `已配 key（base=${process.env.BEACON_DEFAULT_LLM_BASE_URL ?? '默认'}；仅查存在，真实可用性建议实际发一次生成确认）`);
  } else {
    add('平台默认 LLM', PROD ? 'WARN' : 'PASS', PROD
      ? '未配 BEACON_DEFAULT_LLM_API_KEY：全站选题/生成/智囊团输出确定性假数据，用户第一天即识破'
      : 'dev 未配，走 Mock（正常）');
  }

  // 7. 微信支付——启用了就必须配齐且格式正确（未启用不算硬阻塞，可先上免费档）
  const wxpayOn = process.env.BEACON_PAY_VENDOR?.trim() === 'wxpay' || !!process.env.BEACON_WXPAY_MCHID?.trim();
  if (!can('payment')) {
    // 企业版不收钱。这里顺手当一道**反向**闸：客户机器上要是真配了支付凭证，那是配错了文件，
    // 该在装机时就喊出来，而不是等到某天有人发现机器上躺着一副商户密钥。
    add('微信支付配置', wxpayOn ? 'FAIL' : 'PASS',
      wxpayOn ? '企业版不应配置微信支付凭证：请从 .env 里删掉 BEACON_WXPAY_* / BEACON_PAY_VENDOR' : '企业版无支付面（正常）');
  } else if (wxpayOn) {
    try {
      const env = readWxPayEnv();
      add('微信支付配置', 'PASS', `商户号 ${env.mchid} 配置齐全且格式校验通过（提醒：真商户号走一笔真单+退款仍需人工验）`);
    } catch (e) {
      add('微信支付配置', 'FAIL', (e as Error).message.split('\n')[0]);
    }
  } else {
    add('微信支付配置', 'WARN', '未启用微信支付（BEACON_PAY_VENDOR≠wxpay）——只能上免费档，收费前需接入');
  }

  // 8. 热榜数据源——prod 若是 mock 则首页满屏假数据
  const hot = hotSourceMode();
  add('热榜数据源', PROD && hot === 'mock' ? 'WARN' : 'PASS',
    hot === 'mock' ? (PROD ? '当前 Mock：生产建议配 DailyHotApi 或开 60s，否则首页假数据' : 'dev Mock（正常）') : `真实源：${hot}`);

  // 9. 竞对数据源——没接就别展示假数据
  const competitorKey = process.env.BEACON_TIKHUB_KEY?.trim() || process.env.BEACON_NEWRANK_KEY?.trim();
  add('竞对数据源', competitorKey ? 'PASS' : 'WARN',
    competitorKey ? '已接入至少一个真实竞对源' : '未接入（竞对监控页为假数据）——建议接入前从导航隐藏或明确标演示');

  // ── 汇总 ──
  // ── 凭证清单：把「还差哪些 key」一次性列清楚 ──────────────────────
  // 上面的检查各管一件事，散着看数不清到底还缺什么。这一段专门回答那个问题，
  // 口径与 docs/凭证清单.md 一一对应（改这里记得同步那份）。
  const has = (k: string) => Boolean(process.env[k]?.trim());
  // 客服渠道：不配会在 billing 页展示「（待配置客服微信号）」——等于给用户假联系方式
  if (!can('payment')) {
    // 客服渠道是 billing 页（付费/发票/退款）上的联系方式。企业版没有那一页，
    // 缺它不会让任何用户看到占位符。
    add('客服渠道', 'PASS', '企业版无计费页，不需要对外客服渠道');
  } else if (!has('BEACON_CS_WECHAT') && !has('BEACON_CS_EMAIL')) {
    add('客服渠道', PROD ? 'FAIL' : 'WARN', 'BEACON_CS_WECHAT / BEACON_CS_EMAIL 都没配 → billing 页会展示占位符，等于给用户假联系方式');
  } else {
    add('客服渠道', 'PASS', '已配置至少一个联系方式');
  }

  // 可选能力：不配只是该能力走 Mock/不可用，不阻塞上线。列出来是为了「一眼数清还差什么」。
  const OPTIONAL: [string, string][] = [
    ['BEACON_EMBED_API_KEY', '向量嵌入（不配降级为关键词匹配）'],
    ['BEACON_TIKHUB_KEY', '抖音/小红书竞对数据'],
    ['BEACON_NEWRANK_KEY', '公众号竞对数据（你自己的公众号走插件读后台，不需要它）'],
    ['BEACON_YOUTUBE_API_KEY', 'YouTube 竞对/热榜'],
    ['BEACON_TWITTERAPI_KEY', 'X 竞对数据'],
    ['BEACON_ANTHROPIC_API_KEY', 'Agent Skills 导出'],
    ['BEACON_WECHAT_APPID', '微信扫码登录（手机号登录不受影响）'],
    ['BEACON_SENTRY_DSN', '错误上报（不配只打本地日志）'],
    ['BEACON_HTTP_PROXY', '出海代理（国内服务器接 YouTube 必需）'],
  ];
  const missing = OPTIONAL.filter(([k]) => !has(k));
  if (missing.length === 0) {
    add('可选能力凭证', 'PASS', '全部已配置');
  } else {
    add(
      '可选能力凭证',
      'WARN',
      `${OPTIONAL.length - missing.length}/${OPTIONAL.length} 已配置；未配（该能力走 Mock/不可用，不阻塞）：\n` +
        missing.map(([k, why]) => `      · ${k} — ${why}`).join('\n'),
    );
  }
  add('凭证清单全文', 'PASS', 'docs/凭证清单.md（是什么 / 去哪申请 / 不填会怎样）');

  const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - [...s].reduce((w, c) => w + (c.charCodeAt(0) > 255 ? 2 : 1), 0)));
  const icon: Record<Level, string> = { PASS: '✅', WARN: '⚠️ ', FAIL: '❌' };
  console.log('\n烽火台上线体检（preflight）\n' + '─'.repeat(64));
  for (const r of results) console.log(`${icon[r.level]} ${pad(r.name, 20)} ${r.detail}`);
  console.log('─'.repeat(64));

  const fails = results.filter((r) => r.level === 'FAIL').length;
  const warns = results.filter((r) => r.level === 'WARN').length;
  console.log(`结果：${results.length - fails - warns} PASS · ${warns} WARN · ${fails} FAIL`);
  if (fails > 0) {
    console.log('\n❌ 有硬阻塞项，未通过。修掉 FAIL 再上线。');
  } else if (warns > 0) {
    console.log('\n⚠️  无硬阻塞，但有需知晓的 WARN（多为「真实链路仍需人工各验一次」的提醒）。');
  } else {
    console.log('\n✅ 自动可查项全通过。仍需人工完成：真手机号收码、真单+退款、恢复演练、RLS 真验、XFF 伪造实测。');
  }
  await prisma.$disconnect();
  process.exit(fails > 0 ? 1 : 0);
}

run().catch(async (e) => {
  console.error('preflight 自身异常：', e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
