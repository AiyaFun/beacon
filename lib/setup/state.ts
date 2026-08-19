import { timingSafeEqual } from 'node:crypto';
import { prisma } from '@/lib/db';
import { can } from '@/lib/edition';
import { DEMO_TENANT_ID } from '@/lib/demo/guard';

// 首次启动配置向导的状态判定。
//
// 【为什么不新建一张 InstanceConfig 表】
// 这套系统每加一张表都要在生产手动建表（历史上 MediaAsset / CollectionRun / IngestToken /
// AccountDeletion 都是这么来的），而向导恰恰是**客户自己装机时跑的第一段代码**——
// 那时候没有任何人能帮他执行一条 CREATE TABLE。所以判定必须只用现有表：
// **库里有没有 Member** 就是「装没装过」的唯一事实来源，向导写入的也全部落在既有表上
// （Tenant / Member / Workspace / BotIntegration / ModelProvider）。
// 结论：企业版首次启动 = `prisma db push` + seed，不需要任何手动 SQL。

// 「已初始化」一旦为真就永远为真：向导的作用是把 0 个成员变成 1 个，这条边不会回头。
// 因此只缓存 true —— 缓存 false 会让装机那一刻的并发请求各自看到过期状态。
let initializedCache = false;

/** 这台实例装过没有（库里已经有成员）。 */
export async function isInitialized(): Promise<boolean> {
  if (initializedCache) return true;
  // findFirst 而不是 count()：只要证明「存在至少一个」，不必扫全表。
  // 表还不存在时（db push 之前）catch 成 null —— 那当然是「没装过」。
  //
  // ⚠️ 必须排除演示租户。`prisma/seed.ts` 会种一个演示工作台（含 role=viewer 的「演示访客」），
  //    而 seed 正是安装脚本的必经步骤 —— 不排除的话，机器刚装完就被判成「已初始化」，
  //    向导永远不出现，客户开机看到的是一个他根本登不进去的登录页（企业版没有短信通道）。
  //    2026-08-18 首次真机跑安装脚本时抓到，此前单测因为用的是空库而一路绿。
  const one = await prisma.member
    .findFirst({ where: { tenantId: { not: DEMO_TENANT_ID } }, select: { id: true } })
    .catch(() => null);
  if (one) initializedCache = true;
  return initializedCache;
}

/** 仅供测试：清掉「已初始化」的进程内缓存。 */
export function resetInitializedCache(): void {
  initializedCache = false;
}

/**
 * 装机口令。安装脚本随机生成后写进 .env，并打印在终端 + 桌面说明文件里。
 *
 * 【为什么必须有它】
 * 向导是**未登录可访问**的（那时还没有任何账号），而它做的事是「创建 owner」。
 * 没有口令的话，同一个局域网里谁先打开这一页谁就是管理员——在办公室场景里
 * 这不是理论风险，是默认结果。
 *
 * 【为什么没配就拒绝而不是放行】
 * 失败要往安全的方向倒。没配 = 装机脚本没跑或被跳过，此时放行等于把 owner 送给先到的人。
 */
export function setupTokenConfigured(): boolean {
  return (process.env.BEACON_SETUP_TOKEN ?? '').trim().length >= 8;
}

/** 常量时间比较装机口令。 */
export function setupTokenOk(input: string): boolean {
  const want = (process.env.BEACON_SETUP_TOKEN ?? '').trim();
  if (want.length < 8) return false; // 没配 = 一律不通过（fail closed）
  const a = Buffer.from(want, 'utf-8');
  const b = Buffer.from((input ?? '').trim(), 'utf-8');
  // timingSafeEqual 要求等长，长度本身不是秘密（口令由我们自己生成，长度固定）。
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * 现在该不该把人送去 /setup。
 *
 * saas 形态下 can('setupWizard') 恒为 false → 这个函数恒为 false，
 * 线上行为一个字都不变（向导对 SaaS 不存在）。
 */
export async function needsSetup(): Promise<boolean> {
  if (!can('setupWizard')) return false;
  return !(await isInitialized());
}

export class SetupClosedError extends Error {
  readonly code = 'SETUP_CLOSED';
  constructor(message: string) {
    super(message);
    this.name = 'SetupClosedError';
  }
}

/**
 * 向导写操作的硬闸：形态不对、已经装过、或口令不对，一律拒绝。
 * 放在**每一个**向导 server action 的第一行 —— server action 是公开 RPC，
 * 页面上走到第几步拦不住直接打端点的人。
 */
export async function assertSetupAllowed(token: string): Promise<void> {
  if (!can('setupWizard')) throw new SetupClosedError('本版本没有装机向导');
  if (await isInitialized()) throw new SetupClosedError('这台实例已经初始化过了');
  if (!setupTokenConfigured()) {
    throw new SetupClosedError('未配置装机口令（BEACON_SETUP_TOKEN），请重新运行安装脚本');
  }
  if (!setupTokenOk(token)) throw new SetupClosedError('装机口令不正确');
}
