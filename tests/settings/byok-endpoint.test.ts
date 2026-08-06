import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { checkVendorEndpoint, LLM_VENDORS, canUseOverseas } from '@/lib/constants';

// F12-1 端点锁定（PRD §6 F12-1 验收①③ / §10.5-④「任意端点永不开放」/ §13-18）。
// 两层都要测：
//   ① checkVendorEndpoint 本身 —— 绕过 payload 往死里打；
//   ② actAddProvider 端到端 —— 因为这条红线的历史故障不是「函数不对」，
//      而是「函数在客户端、服务端根本没调用」。只测纯函数发现不了那个。
const session = { memberId: 'm1', tenantId: '', workspaceId: 'w1', accountId: 'a1', memberName: '张三', role: 'owner', plan: 'free' };
vi.mock('@/lib/session', () => ({ getSession: async () => session, getSessionOrNull: async () => session }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { actAddProvider } = await import('@/app/(app)/settings/actions');

const DS = 'https://api.deepseek.com';

beforeEach(async () => {
  await prisma.modelProvider.deleteMany();
  const t = await prisma.tenant.create({ data: { name: '测试租户', plan: 'free' } });
  session.tenantId = t.id;
  session.plan = 'free';
});

function add(over: Partial<{ vendor: string; baseUrl: string }> = {}) {
  return actAddProvider({
    label: '渠道',
    vendor: over.vendor ?? 'deepseek',
    baseUrl: over.baseUrl ?? DS,
    apiKey: 'sk-test-123',
    model: 'deepseek-chat',
  });
}

describe('F12-1 · 白名单内端点放行', () => {
  for (const [key, v] of Object.entries(LLM_VENDORS)) {
    it(`${key} 官方端点通过`, () => {
      expect(checkVendorEndpoint(key, v.baseUrl)).toEqual({ ok: true, vendor: v });
    });
  }

  it('末尾斜杠等价（/v1/ === /v1）', () => {
    expect(checkVendorEndpoint('kimi', 'https://api.moonshot.cn/v1/').ok).toBe(true);
  });

  it('host 大小写等价（DNS 本就大小写不敏感）', () => {
    expect(checkVendorEndpoint('deepseek', 'https://API.DeepSeek.COM').ok).toBe(true);
  });

  it('显式 443 端口等价', () => {
    expect(checkVendorEndpoint('deepseek', 'https://api.deepseek.com:443').ok).toBe(true);
  });
});

// ── 绕过 payload 全家桶：任何一条漏网 = 租户内容可被发往任意服务器 ──
const BYPASS: [string, string][] = [
  ['后缀域名', 'https://api.deepseek.com.evil.com'],
  ['后缀域名·带路径', 'https://api.deepseek.com.evil.com/v1'],
  ['userinfo 陷阱', 'https://api.deepseek.com@evil.com'],
  ['userinfo 陷阱·带密码', 'https://api.deepseek.com:sk-x@evil.com/v1'],
  ['userinfo 陷阱·反斜杠', 'https://api.deepseek.com\\@evil.com'],
  ['前缀域名', 'https://evil-api.deepseek.com.attacker.net'],
  ['子域名', 'https://evil.api.deepseek.com'],
  ['host 里嵌白名单串', 'https://evil.com/api.deepseek.com'],
  ['非默认端口', 'https://api.deepseek.com:8443'],
  ['明文 http 降级', 'http://api.deepseek.com'],
  ['路径穿越', 'https://api.deepseek.com/v1/../../../evil'],
  ['路径穿越·qwen', 'https://dashscope.aliyuncs.com/compatible-mode/v1/../../evil'],
  ['多挂一段路径', 'https://api.deepseek.com/proxy'],
  ['路径大小写', 'https://api.moonshot.cn/V1'],
  ['查询串夹带', 'https://api.deepseek.com/?next=https://evil.com'],
  ['锚点夹带', 'https://api.deepseek.com/#@evil.com'],
  ['协议改 file', 'file:///etc/passwd'],
  ['协议改 javascript', 'javascript:fetch("https://evil.com")'],
  ['无协议裸域名', 'api.deepseek.com'],
  ['空串', ''],
  ['纯空白', '   '],
  ['内网 SSRF', 'https://127.0.0.1:8080'],
  ['内网 SSRF·元数据', 'https://169.254.169.254/latest/meta-data'],
  ['IDN 同形字（punycode 后不同 host）', 'https://api.deepsеek.com'],
];

describe('F12-1 · 绕过尝试必须全部拒绝', () => {
  for (const [name, url] of BYPASS) {
    it(`拒绝 ${name}：${url}`, () => {
      const r = checkVendorEndpoint('deepseek', url);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('白名单');
    });
  }

  it('拒绝白名单外的 vendor（custom 入口已删除，服务端也不认）', () => {
    for (const v of ['custom', 'ollama', '', '__proto__', 'constructor', 'toString']) {
      expect(checkVendorEndpoint(v, DS).ok).toBe(false);
    }
  });

  it('vendor 白名单内但端点串了另一家 —— 也拒绝（端点必须与 vendor 一一对应）', () => {
    expect(checkVendorEndpoint('deepseek', LLM_VENDORS.openai.baseUrl).ok).toBe(false);
    expect(checkVendorEndpoint('kimi', LLM_VENDORS.glm.baseUrl).ok).toBe(false);
  });
});

// ── 端到端：server action 是公开 RPC，绕过 UI 直接打它 ──
describe('F12-1 · actAddProvider 服务端强校验（绕过 UI 直打 server action）', () => {
  it('白名单端点入库成功', async () => {
    expect(await add()).toEqual({ ok: true });
    const p = await prisma.modelProvider.findFirst({ where: { tenantId: session.tenantId } });
    expect(p?.baseUrl).toBe(DS);
    expect(p?.region).toBe('cn');
  });

  it('每个绕过 payload 都被 server action 拒绝且零入库', async () => {
    for (const [, url] of BYPASS) {
      const r = await add({ baseUrl: url });
      expect(r.ok, `本该被拒: ${url}`).toBe(false);
    }
    await add({ vendor: 'custom' });
    expect(await prisma.modelProvider.count()).toBe(0);
  });

  it('入库的是平台预置值，不是用户提交的字符串', async () => {
    // 大小写变体虽等价放行，但存进去的必须是规范预置值
    expect((await add({ baseUrl: 'https://API.DEEPSEEK.COM/' })).ok).toBe(true);
    const p = await prisma.modelProvider.findFirst({});
    expect(p?.baseUrl).toBe(DS);
  });

  it('拒绝时返回可读中文错误', async () => {
    const r = await add({ baseUrl: 'https://api.deepseek.com.evil.com' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/端点不在白名单内/);
    expect(r.error).toContain('https://api.deepseek.com');
  });
});

describe('F12-1 · region 强绑 vendor + overseas 卡企业版', () => {
  it('region 由 vendor 推导，用户传什么都没用（旧签名的 region 入参已删）', async () => {
    // @ts-expect-error 故意多传 region：攻击者会这么干，必须被忽略而不是被采信
    const r = await actAddProvider({ label: 'x', vendor: 'deepseek', baseUrl: DS, apiKey: 'sk-1', model: 'm', region: 'overseas' });
    expect(r.ok).toBe(true);
    expect((await prisma.modelProvider.findFirst({}))?.region).toBe('cn');
  });

  it('free 版加海外端点被拒（overseas = L2，企业版才行）', async () => {
    const r = await add({ vendor: 'openai', baseUrl: LLM_VENDORS.openai.baseUrl });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('企业版');
    expect(await prisma.modelProvider.count()).toBe(0);
  });

  it('personal/team 也不行，只有 enterprise 放行', async () => {
    for (const plan of ['free', 'personal', 'team']) {
      session.plan = plan;
      expect((await add({ vendor: 'claude', baseUrl: LLM_VENDORS.claude.baseUrl })).ok, plan).toBe(false);
    }
    session.plan = 'enterprise';
    expect((await add({ vendor: 'claude', baseUrl: LLM_VENDORS.claude.baseUrl })).ok).toBe(true);
    expect((await prisma.modelProvider.findFirst({}))?.region).toBe('overseas');
  });

  it('canUseOverseas 只认 enterprise', () => {
    expect(['free', 'personal', 'team', 'pro', '', 'ENTERPRISE'].some(canUseOverseas)).toBe(false);
    expect(canUseOverseas('enterprise')).toBe(true);
  });
});
