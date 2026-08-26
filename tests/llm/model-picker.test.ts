import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
/** 源码断言前先剥注释——注释里正好在解释这些词，不剥会被自己的说明骗（本仓踩过两次） */
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// 新任务页的「用哪个模型」（2026-08-26）：自接入(BYOK) / 外接入(平台) 都能选。
// 这三条钉的是「选了真的生效」与「别人的 id 选不动」，不是某句文案。

describe('模型选择：选了必须真的生效', () => {
  it('🔒 请求体带上 modelId，且 send 的依赖里有它', () => {
    const chat = code('app/(app)/assistant/Chat.tsx');
    expect(chat, '请求体没带 modelId').toMatch(/body: JSON\.stringify\(\{[^}]*modelId[^}]*\}\)/);
    // useCallback 闭包捕获旧值 = 「选了别的模型，发出去还是自动档」，且不报任何错
    const deps = /\}, \[([^\]]*)\]\);/g;
    const all = [...chat.matchAll(deps)].map((m) => m[1]);
    expect(all.some((d) => d.includes('modelId')), 'send 的依赖数组里没有 modelId').toBe(true);
  });

  it('🔒 网关认 providerId，且只在本租户那批里找', () => {
    const gw = code('lib/llm/gateway.ts');
    expect(gw, 'resolveWithSource 不认 providerId').toMatch(/providerId\?: string/);
    // 关键安全性质：查的是 providers（已按 tenantId 查出），不是全库按 id 查。
    // 写成 prisma.modelProvider.findUnique({ where: { id: opts.providerId } }) 就成了
    // 「填别人租户的 id 就能用别人的 Key」
    expect(gw).toMatch(/providers\.find\(\(p\) => p\.id === opts\.providerId\)/);
    expect(gw, '不许按 id 直查全库').not.toMatch(/findUnique\(\{\s*where:\s*\{\s*id:\s*opts\??\.?providerId/);
  });

  it('🔒 选了「平台渠道」就必须跳过 BYOK，否则选项没生效', () => {
    const gw = code('lib/llm/gateway.ts');
    expect(gw).toMatch(/const forcePlatform = opts\?\.providerId === PLATFORM_PROVIDER_ID/);
    expect(gw, 'BYOK 段没被 forcePlatform 跳过').toMatch(/if \(tenantId && !forcePlatform\)/);
  });

  it('企业版不列平台渠道——那台机器上根本没有平台垫付这回事', () => {
    const sel = code('lib/llm/selectable.ts');
    expect(sel).toMatch(/can\('platformLlmChannel'\)/);
  });

  it('坏掉的渠道不进清单（列了点了必报错）', () => {
    const sel = code('lib/llm/selectable.ts');
    expect(sel).toMatch(/status:\s*\{\s*not:\s*'failed'\s*\}/);
  });
});
