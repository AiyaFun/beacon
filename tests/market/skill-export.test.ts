import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from '@/lib/db';
import { exportSkillPack } from '@/lib/market/install';

// 技能包「能装不能导」（2026-08-29 全库「写了没接」扫描查出）。
//
// `exportSkillPack` 建好了、能跑，但**没有任何入口**——而工作流那边是对称通的
// （actExportWorkflow + 界面上的「导出」按钮）。于是用户能从市场装别人的技能，
// 却分享不出自己做的，而市场本来就把技能包当作可分发单位之一（beaconPack:1, kind='skill'）。
//
// 不是空承诺（界面上没说过技能能导出），但是个半成品能力。
// 按这个项目的规矩：要么接上，要么删掉——这里选接上。

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('技能导出：真跑', () => {
  it('🔒 导出的是合法 beaconPack，且剥掉了本地前缀', async () => {
    const t = await prisma.tenant.create({ data: { name: 't' } });
    const skill = await prisma.contentSkill.create({
      data: {
        tenantId: t.id, slug: 'custom-my-skill', name: '我的技能', description: 'd',
        emoji: '✨', platform: 'generic', outputKind: 'text',
        promptTemplate: '把 {{draft}} 改写成…', version: '1',
      },
    });
    const json = await exportSkillPack(t.id, skill.id);
    expect(json).toBeTruthy();
    const pack = JSON.parse(json!) as { beaconPack: number; pack: Record<string, unknown> };
    expect(pack.beaconPack).toBe(1);
    expect(pack.pack.kind).toBe('skill');
    // custom-/mkt- 是本地存储约定，不该带进分享出去的包
    expect(pack.pack.slug).toBe('my-skill');
    expect(pack.pack.promptTemplate).toContain('{{draft}}');
  });

  it('🔒 别的工作区的技能导不出来（否则谁都能把别人的提示词导走）', async () => {
    const a = await prisma.tenant.create({ data: { name: 'a' } });
    const b = await prisma.tenant.create({ data: { name: 'b' } });
    const skill = await prisma.contentSkill.create({
      data: {
        tenantId: a.id, slug: 'custom-secret', name: '别人的', description: 'd',
        platform: 'generic', outputKind: 'text', promptTemplate: 'x', version: '1',
      },
    });
    expect(await exportSkillPack(b.id, skill.id)).toBeNull();
  });
});

describe('技能导出：真的接上了', () => {
  const actions = read('app/(app)/skills/actions.ts');
  const ui = read('app/(app)/skills/SkillCenter.tsx');

  it('🔒 有 server action，且有权限闸（action 就是公开 RPC）', () => {
    expect(actions).toContain('export async function actExportSkill');
    const i = actions.indexOf('export async function actExportSkill');
    expect(actions.slice(i, i + 500)).toContain("requireRole(s, 'content.create')");
  });

  it('🔒 界面上真的有按钮（不然又是一个孤儿）', () => {
    expect(ui).toContain('actExportSkill');
    expect(ui).toContain('导出');
  });

  it('🔒 只给自定义技能（内置的导出去没意义，对方装上还是同一份）', () => {
    // 【锚在调用点，不是 import 那一行】裸名 indexOf 找到的第一个永远是文件顶部的
    // import——本会话第五次栽在同一个形状上。写源码断言时，先问一句
    // 「这个名字在文件里第一次出现是不是 import」。
    const i = ui.indexOf('actExportSkill(skl.id)');
    expect(i, '找不到调用点').toBeGreaterThan(0);
    expect(ui.slice(Math.max(0, i - 600), i)).toContain('!skl.isBuiltin');
  });

  it('🔒 结果就地展示，不做自动下载（沙箱里 <a download> 是无效的，点了没反应更糟）', () => {
    expect(ui).toContain('exported.json');
    const code = ui.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toContain('download');
  });
});
