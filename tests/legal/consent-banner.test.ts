import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LEGAL_VERSION } from '@/lib/legal';

// 政策更新告知 —— 隐私政策第九节「重大变更时会通过站内通知或弹窗方式告知」的兑现。
//
// 【为什么这条守卫值得存在】`Member.consentVersion` 从建库起就在**写**（注册、公众号登录、
// 装机向导三处），却**从来没有一行代码读过它**。政策改了多少次，用户那边一次提示都没有。
// 与 lib/legal/removal.ts 文件头记的缺口（申请页收下申请、采集链路从不查）同一形状：
// 对外写好的话，代码不接就是假的。这里钉住「有人读它」这件事本身。

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const BANNER = read('components/LegalUpdateBanner.tsx');
const SHELL = read('components/TenantShell.tsx');
const ACTION = read('lib/legal/consent-actions.ts');

describe('🔒 consentVersion 不再是只写不读', () => {
  it('有组件真的读它并与当前版本比较', () => {
    expect(BANNER).toContain('consentVersion: true');
    expect(BANNER).toMatch(/consentVersion === LEGAL_VERSION/);
  });

  it('🔒 挂在唯一那份外壳上 —— 挂在某个页面里等于大部分页面看不到', () => {
    // 外壳收成 TenantShell 唯一一份是 2026-08-20 的结论（见该文件头）。
    // 告知类横幅必须挂这儿，否则「(public) 组是所有壳层守卫的天然盲区」那个坑会再踩一次。
    expect(SHELL).toContain('<LegalUpdateBanner');
    expect(SHELL).toContain("from '@/components/LegalUpdateBanner'");
  });

  it('🔒 建号早于该字段的老用户不打扰（consentVersion 为空时不显示）', () => {
    // 我们不知道他当时看到的是哪一版，拿「政策更新了」去打扰他，说的是我们自己也不确定的事。
    expect(BANNER).toMatch(/!me\?\.consentVersion/);
  });

  it('🔒 演示租户不打扰', () => {
    const at = SHELL.indexOf('<LegalUpdateBanner');
    expect(SHELL.slice(Math.max(0, at - 120), at)).toContain('!demo');
  });
});

describe('🔒 「我知道了」的留痕不能被人替按', () => {
  it('memberId 只从 session 取，不出现在 action 的形参里', () => {
    // 这是公开可达的 server action。形参上放个 memberId 就等于「谁都能替别人按下已阅」，
    // 而被人替按过的合规留痕比没有留痕更坏——它看起来是真的。
    expect(ACTION).toMatch(/export async function ackLegalVersion\(\)/);
    expect(ACTION).toContain('await getSession()');
    expect(ACTION).toContain('session.memberId');
  });

  it('按完要 revalidate，否则横幅原地不动、用户会反复点', () => {
    expect(ACTION).toContain('revalidatePath');
  });

  it('写进去的是当前版本常量，不是硬编码的字符串', () => {
    expect(ACTION).toContain('consentVersion: LEGAL_VERSION');
    expect(ACTION).not.toContain(`consentVersion: '${LEGAL_VERSION}'`);
  });
});

describe('🔒 横幅文案说清这次改了什么', () => {
  // 只写「政策更新了，请查看」等于没告知——用户不会去逐字比对两版全文。
  const MUST_SAY: [string, RegExp][] = [
    ['公众号采集的风险', /公众号.{0,20}(登录态|平台协议)/],
    ['补披露了数据来源方', /来源方|第三方来源/],
    ['评论表述更正', /去标识化/],
    ['处理范围有没有扩大', /没有扩大|未扩大/],
  ];
  for (const [what, re] of MUST_SAY) {
    it(`说清了「${what}」`, () => {
      expect(re.test(BANNER)).toBe(true);
    });
  }

  it('给出全文入口', () => {
    expect(BANNER).toContain('/legal/privacy');
  });
});
