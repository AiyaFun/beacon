import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  edition,
  can,
  assertCan,
  isEnterpriseEdition,
  knownEditions,
  UnknownEditionError,
  CapabilityDisabledError,
  type Capability,
} from '@/lib/edition';

// 部署形态开关。这张矩阵是三个交付版本的产品定义，用例逐格钉死 ——
// 改动能力面时测试必须跟着改，避免「顺手打开一个格子」把支付/短信漏进客户机器。

afterEach(() => vi.unstubAllEnvs());

describe('edition()', () => {
  it('未设置时是 saas —— 现有生产一个字都没配，必须保持原样', () => {
    vi.stubEnv('BEACON_EDITION', '');
    expect(edition()).toBe('saas');
  });

  it('认得三种形态，且大小写/空白不敏感', () => {
    for (const ed of knownEditions()) {
      vi.stubEnv('BEACON_EDITION', `  ${ed.toUpperCase()} `);
      expect(edition()).toBe(ed);
    }
  });

  it('拼错要抛，不许静默回落 saas', () => {
    // 回落的后果：卖出去的机器跑 SaaS 版，支付路由活着、登录页要短信而机器上没短信通道。
    vi.stubEnv('BEACON_EDITION', 'applaince');
    expect(() => edition()).toThrow(UnknownEditionError);
    expect(() => edition()).toThrow(/applaince/);
  });
});

describe('能力矩阵', () => {
  const EXPECTED: Record<string, Partial<Record<Capability, boolean>>> = {
    saas: {
      payment: true,
      smsLogin: true,
      oaLogin: false,
      platformLlmChannel: true,
      quotaBilling: true,
      setupWizard: false,
      botInboundWs: false,
    },
    appliance: {
      payment: false,
      smsLogin: false,
      oaLogin: true,
      platformLlmChannel: false,
      quotaBilling: false,
      setupWizard: true,
      botInboundWs: true,
    },
    private: {
      payment: false,
      smsLogin: false,
      oaLogin: true,
      platformLlmChannel: false,
      quotaBilling: false,
      setupWizard: true,
      botInboundWs: false,
    },
  };

  for (const [ed, caps] of Object.entries(EXPECTED)) {
    for (const [cap, want] of Object.entries(caps)) {
      it(`${ed}.${cap} = ${want}`, () => {
        vi.stubEnv('BEACON_EDITION', ed);
        expect(can(cap as Capability)).toBe(want);
      });
    }
  }

  it('两个企业版除基础设施项外能力面必须一致 —— 不许分叉成两个产品', () => {
    // botInboundWs 是唯一允许的差异：整机在 NAT 后要长连接，客户云上有公网地址走 webhook。
    const INFRA_ONLY: Capability[] = ['botInboundWs'];
    const caps = Object.keys(EXPECTED.appliance) as Capability[];
    for (const cap of caps) {
      if (INFRA_ONLY.includes(cap)) continue;
      vi.stubEnv('BEACON_EDITION', 'appliance');
      const a = can(cap);
      vi.stubEnv('BEACON_EDITION', 'private');
      expect(can(cap), `${cap} 在两个企业版里不一致`).toBe(a);
    }
  });

  it('收钱与短信只在 saas —— 客户机器上不许留这两个面', () => {
    for (const ed of ['appliance', 'private'] as const) {
      vi.stubEnv('BEACON_EDITION', ed);
      expect(can('payment')).toBe(false);
      expect(can('smsLogin')).toBe(false);
      expect(isEnterpriseEdition()).toBe(true);
    }
    vi.stubEnv('BEACON_EDITION', 'saas');
    expect(isEnterpriseEdition()).toBe(false);
  });
});

describe('assertCan()', () => {
  it('能力缺席时抛 CapabilityDisabledError，消息里带形态名', () => {
    vi.stubEnv('BEACON_EDITION', 'appliance');
    expect(() => assertCan('payment')).toThrow(CapabilityDisabledError);
    expect(() => assertCan('payment')).toThrow(/appliance/);
  });

  it('能力在场时不抛', () => {
    vi.stubEnv('BEACON_EDITION', 'saas');
    expect(() => assertCan('payment')).not.toThrow();
  });
});

// ── 耦合点守卫 ───────────────────────────────────────────────────────────────
// 「能力矩阵写对了」和「代码真的去问了它」是两件事。上面那组只验前者，
// 这一组验后者：既断言源码里守卫在场（防止有人重构时顺手删掉），
// 也断言行为真的变了（防止守卫写了却没接上）。缺一就是假绿。

describe('支付面在企业版必须消失', () => {
  const PAY_ROUTES = [
    'app/api/pay/notify/route.ts',
    'app/api/pay/refund-notify/route.ts',
    'app/api/internal/pay/refund/route.ts',
  ];

  it.each(PAY_ROUTES)('%s 里有形态闸', async (rel) => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(rel, 'utf-8');
    expect(src).toMatch(/can\('payment'\)/);
    expect(src).toMatch(/status: 404/);
  });

  it('getPayProvider() 在 appliance 下抛 —— 所有下单/退款路径的共同入口', async () => {
    const { getPayProvider } = await import('@/lib/pay/provider');
    vi.stubEnv('BEACON_EDITION', 'appliance');
    expect(() => getPayProvider()).toThrow(CapabilityDisabledError);
    vi.stubEnv('BEACON_EDITION', 'private');
    expect(() => getPayProvider()).toThrow(CapabilityDisabledError);
  });

  it('计费 server action 每一个都带闸（server action 即公开 RPC）', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('app/(app)/billing/actions.ts', 'utf-8');
    const actions = src.match(/export async function act\w+/g) ?? [];
    expect(actions.length).toBeGreaterThan(0);
    const guards = src.match(/assertCan\('payment'\)/g) ?? [];
    expect(guards.length, '每个 action 都要有一道闸').toBe(actions.length);
  });
});

describe('短信登录在企业版必须消失', () => {
  it('requestLoginCode 直接回「走扫码」而不是发短信', async () => {
    const { requestLoginCode } = await import('@/lib/auth');
    vi.stubEnv('BEACON_EDITION', 'appliance');
    // 手机号故意给合法值：要验的是形态闸排在格式校验**之前**，
    // 否则企业版用户输入非法号会先看到「格式不正确」，误以为填对了就能收到短信。
    const r = await requestLoginCode('13800138000');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/扫码/);
  });
});

describe('配额与平台 AI 渠道在企业版必须让路', () => {
  it('quotaEnabled() 在企业版默认关，但显式配置仍然优先', async () => {
    const { quotaEnabled } = await import('@/lib/quota');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('BEACON_QUOTA_ENABLED', '');
    vi.stubEnv('BEACON_EDITION', 'appliance');
    expect(quotaEnabled()).toBe(false);
    vi.stubEnv('BEACON_EDITION', 'saas');
    expect(quotaEnabled(), 'SaaS 生产态行为不许变').toBe(true);
    // 客户想给内部成员设上限：显式打开压过形态默认
    vi.stubEnv('BEACON_EDITION', 'appliance');
    vi.stubEnv('BEACON_QUOTA_ENABLED', '1');
    expect(quotaEnabled()).toBe(true);
  });

  it('gateway 源码里平台渠道被形态闸包住，且 env 兜底在企业版标成 byok', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('lib/llm/gateway.ts', 'utf-8');
    // 平台渠道查询必须在闸内（读侧函数 2026-08-19 抽到 lib/llm/platform-providers.ts，改名为 pickPlatformProvider）
    expect(src).toMatch(/if \(can\('platformLlmChannel'\)\) \{[\s\S]*?pickPlatformProvider/);
    // env 兜底的来源标记必须随形态走：标成 platform 会把客户自己的 Key 送进平台预算闸
    expect(src).toMatch(/source: can\('platformLlmChannel'\) \? 'platform' : 'byok'/);
  });

  // 2026-08-19：生图接上平台渠道后，这条链路有了与 gateway 完全相同的泄漏面——
  // 企业版机器上没有「平台」这个主体，却去读一张平台渠道表、还把来源标成 platform
  // 送进一个不存在的预算闸。同一条闸要钉两处，漏一处就是「文本挡住了、封面没挡住」。
  it('image 源码里平台渠道同样被形态闸包住，env 兜底同口径', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('lib/llm/image.ts', 'utf-8');
    expect(src).toMatch(/if \(can\('platformLlmChannel'\)\) \{[\s\S]*?pickPlatformProvider\('image'/);
    expect(src).toMatch(/source: can\('platformLlmChannel'\) \? 'platform' : 'byok'/);
  });
});

// ── 导航与状态栏不许泄漏 SaaS 专属入口 ─────────────────────────────────
// 2026-08-18 首次真机跑通整机版时发现的两处：侧栏还挂着「套餐与计费」（点进去撞 assertCan 抛错页），
// 右上角显示「平台默认模型」（企业版根本没有平台渠道，等于告诉用户一个不存在的东西在为他工作）。
describe('企业版界面不泄漏计费与平台渠道', () => {
  it('visibleNav() 在企业版里去掉 /billing，其余条目一个不少', async () => {
    const { visibleNav, NAV } = await import('@/lib/nav');
    const flat = (gs: { items: { href: string }[] }[]) => gs.flatMap((g) => g.items.map((i) => i.href));

    vi.stubEnv('BEACON_EDITION', 'saas');
    const saas = flat(visibleNav());
    expect(saas, 'SaaS 必须仍然有计费入口').toContain('/billing');
    expect(saas.length).toBe(flat(NAV).length);

    for (const ed of ['appliance', 'private'] as const) {
      vi.stubEnv('BEACON_EDITION', ed);
      const got = flat(visibleNav());
      expect(got, `${ed} 不该有计费入口`).not.toContain('/billing');
      expect(got.length, `${ed} 只该少掉计费这一项`).toBe(saas.length - 1);
    }
  });

  it('Topbar 源码：平台默认模型徽标被形态闸包住', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('components/Topbar.tsx', 'utf-8');
    expect(src).toMatch(/can\('platformLlmChannel'\) && process\.env\.BEACON_DEFAULT_LLM_API_KEY/);
    // 装机写入的渠道是 untested，只认 'ok' 会让刚装完的机器显示「演示模型」
    expect(src).toMatch(/can\('platformLlmChannel'\) \? 'ok' : \{ not: 'failed' \}/);
  });

  it('侧栏是客户端组件：导航必须由服务端算好传进去，不许出现第二个形态真相源', async () => {
    const fs = await import('node:fs');
    const sidebar = fs.readFileSync('components/Sidebar.tsx', 'utf-8');
    expect(sidebar).toMatch(/'use client'/);
    // NEXT_PUBLIC_ 版本的形态变量 = 两个真相源，迟早不一致（侧栏藏了入口而端点还活着）
    expect(sidebar).not.toMatch(/NEXT_PUBLIC_BEACON_EDITION/);
    expect(sidebar).not.toMatch(/from '@\/lib\/edition'/);
  });
});

// ── 登录页不许把 SaaS 的东西印在客户机器上 ────────────────────────────
// 2026-08-19 真机跑企业版登录页时抓到三处：试用促销横幅（企业版没有套餐也没有配额，
// 是空承诺）、游客访问入口（演示租户是 SaaS 获客入口，在客户机器上等于开了一扇免身份的门）、
// 以及页脚**我们公司**的 ICP / 公网安备 / 增值电信 / 广播电视许可证 ——
// 印在客户自建的实例上是拿我们的资质给别人的服务背书。
describe('企业版登录页不泄漏 SaaS 内容', () => {
  it('促销横幅 / 游客入口 / 资质页脚都被形态闸包住', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('app/login/page.tsx', 'utf-8');

    // 试用促销
    expect(src).toMatch(/!invite && !inviteInvalid && !oaOnly \?/);
    // 游客访问
    expect(src).toMatch(/\{!invite && !oaOnly && <GuestButton \/>\}/);
    // 资质页脚：ICP 号必须落在 oaOnly 的**否定**分支里
    const icpAt = src.indexOf('闽ICP备');
    const branchAt = src.indexOf('{oaOnly ? (');
    expect(icpAt, '登录页应当还有 SaaS 的资质页脚').toBeGreaterThan(0);
    expect(branchAt, '资质页脚必须放在形态分支里').toBeGreaterThan(0);
    expect(icpAt).toBeGreaterThan(branchAt);
  });

  it('OA 登录面板只讲企业应用，不提手机号/验证码', async () => {
    const fs = await import('node:fs');
    const raw = fs.readFileSync('app/login/OaLoginPanel.tsx', 'utf-8');
    // ⚠️ 必须先剥注释再断言：这个文件的注释里就写着「这里没有手机号表单」，
    // 直接对全文匹配会被自己的注释判红（第一版就是这么挂的）。
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(src, '面板正文不该出现短信登录的字眼').not.toMatch(/验证码|手机号/);
    expect(src).toMatch(/私聊/);
  });

  it('一次性登录链接的端点带形态闸（SaaS 上不存在这条通道）', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('app/api/auth/oa/magic/route.ts', 'utf-8');
    expect(src).toMatch(/if \(!can\('oaLogin'\)\) return new NextResponse\('Not Found', \{ status: 404 \}\)/);
    // 票据不能留在地址栏：换到 cookie 后必须 302 到不带查询串的地址
    expect(src).toMatch(/NextResponse\.redirect\(siteUrl\(\) \+ '\/'\)/);
  });
});

// ── 权限分配：企业版只留两档 ─────────────────────────────────────────────
describe('企业版权限只有两档', () => {
  it('assignableRoles()：企业版 管理员/编辑；SaaS 保持三档不变', async () => {
    const { assignableRoles, ASSIGNABLE_ROLES } = await import('@/lib/rbac');
    vi.stubEnv('BEACON_EDITION', 'saas');
    expect(assignableRoles()).toEqual(ASSIGNABLE_ROLES);
    for (const ed of ['appliance', 'private'] as const) {
      vi.stubEnv('BEACON_EDITION', ed);
      expect(assignableRoles()).toEqual(['admin', 'editor']);
    }
  });

  it('🔒 服务端校验用的是同一个函数 —— 只在下拉框里少渲染一项等于「藏起来但打得通」', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('app/(app)/members/actions.ts', 'utf-8');
    expect(src).toMatch(/!assignableRoles\(\)\.includes\(role\)/);
    expect(src, '服务端不该再直接引用未经形态过滤的常量').not.toMatch(/ASSIGNABLE_ROLES/);
  });

  it('成员 UI 是客户端组件：角色列表必须由服务端传入', async () => {
    const fs = await import('node:fs');
    for (const f of ['app/(app)/members/MemberRow.tsx', 'app/(app)/members/InviteForm.tsx']) {
      const src = fs.readFileSync(f, 'utf-8');
      expect(src).toMatch(/'use client'/);
      expect(src, `${f} 不该自己算角色列表`).not.toMatch(/assignableRoles|ASSIGNABLE_ROLES/);
      expect(src).toMatch(/roles/);
    }
  });
});

describe('钉钉群/单聊判定要 fail-closed', () => {
  it('只有显式 conversationType==="1" 才当私聊 —— 判错方向会把登录链接发进群', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('app/api/bot/dingtalk/events/[key]/route.ts', 'utf-8');
    expect(src).toMatch(/isGroup = String\(payload\?\.conversationType \?\? ''\) !== '1'/);
    // 身份用 senderStaffId（企业内稳定 userid），不是会话级的 senderId
    expect(src).toMatch(/senderStaffId/);
  });

  it('企微回调显式标 isGroup: false（自建应用只有一对一会话）', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('app/api/bot/wecom/events/[key]/route.ts', 'utf-8');
    expect(src).toMatch(/isGroup: false/);
  });
});
