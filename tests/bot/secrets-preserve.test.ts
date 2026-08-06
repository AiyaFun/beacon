import { describe, it, expect } from 'vitest';
import { readBotSecrets, writeBotSecrets } from '@/lib/bot';
import type { BotSecrets } from '@/lib/bot/types';

// 「点编辑，密钥框全空了」——密钥不回显是有意为之，但必须保证：
// 留空提交 ≠ 清空已存密钥。下面把服务端的合并规则原样钉死。
// 规则来源：app/(app)/settings/bot-actions.ts 的 nextSecrets（(输入 ?? '').trim() || 旧值）。

function mergeSecrets(prev: BotSecrets, input: Partial<Record<keyof BotSecrets, string>>, provider = 'feishu'): BotSecrets {
  return {
    signSecret: (input.signSecret ?? '').trim() || prev.signSecret,
    appSecret: (input.appSecret ?? '').trim() || prev.appSecret,
    verificationToken: (input.verificationToken ?? '').trim() || prev.verificationToken,
    encryptKey: (input.encryptKey ?? '').trim() || prev.encryptKey,
    corpId: provider === 'wecom' ? ((input.corpId ?? '').trim() || prev.corpId) : prev.corpId,
    agentId: (input.agentId ?? '').trim() || prev.agentId,
  };
}

const SAVED: BotSecrets = {
  signSecret: 'sign-old',
  appSecret: 'secret-old',
  verificationToken: 'vt-old',
  encryptKey: 'ek-old',
  corpId: 'ww-old',
  agentId: '1000002',
};

describe('编辑时留空 → 沿用已存密钥（不会被清空）', () => {
  it('全部留空提交 → 六个字段一个不丢', () => {
    expect(mergeSecrets(SAVED, {})).toEqual(SAVED);
  });

  it('只改 App Secret → 其余保持原值', () => {
    const next = mergeSecrets(SAVED, { appSecret: 'secret-new' });
    expect(next.appSecret).toBe('secret-new');
    expect(next.verificationToken).toBe('vt-old');
    expect(next.encryptKey).toBe('ek-old');
    expect(next.agentId).toBe('1000002');
  });

  it('纯空格视同留空（不会把密钥改成空白）', () => {
    expect(mergeSecrets(SAVED, { appSecret: '   ', verificationToken: '\t' })).toEqual(SAVED);
  });

  it('钉钉 AgentId 留空 → 沿用旧值（编辑框没回显也不会丢）', () => {
    expect(mergeSecrets(SAVED, { agentId: '' }, 'dingtalk').agentId).toBe('1000002');
  });

  it('加密落库后再读回，值仍一致（round-trip 不损）', () => {
    const merged = mergeSecrets(SAVED, {});
    expect(readBotSecrets(writeBotSecrets(merged))).toEqual(SAVED);
  });
});

describe('回传给前端的标记与明文字段', () => {
  // page.tsx / notifications/page.tsx 只回传「有没有密钥」+ 非密钥的 agentId
  function toRow(secrets: BotSecrets) {
    return {
      agentId: secrets.agentId ?? null,
      hasAppSecret: !!secrets.appSecret,
      hasVerificationToken: !!secrets.verificationToken,
      hasEncryptKey: !!secrets.encryptKey,
    };
  }

  it('AgentId 回显（不是密钥，编辑时要能还原）', () => {
    expect(toRow(SAVED).agentId).toBe('1000002');
  });

  it('真密钥只回传布尔标记，明文一律不出现在回传结构里', () => {
    const row = toRow(SAVED);
    const dumped = JSON.stringify(row);
    expect(dumped).not.toContain('secret-old');
    expect(dumped).not.toContain('vt-old');
    expect(dumped).not.toContain('ek-old');
    expect(row.hasAppSecret).toBe(true);
    expect(row.hasVerificationToken).toBe(true);
    expect(row.hasEncryptKey).toBe(true);
  });

  it('没存过的密钥 → 标记为 false（表单该提示「必填」而非「留空=不改」）', () => {
    const row = toRow({ appSecret: 'x' });
    expect(row.hasAppSecret).toBe(true);
    expect(row.hasVerificationToken).toBe(false);
    expect(row.hasEncryptKey).toBe(false);
    expect(row.agentId).toBeNull();
  });
});
