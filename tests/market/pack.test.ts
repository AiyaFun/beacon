import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '@/lib/db';
import { parsePack, compareVersion, versionSatisfied, PACK_VERSION } from '@/lib/market/pack';
import { markInstalled, type MarketEntry } from '@/lib/market/catalog';
import { APP_VERSION } from '@/lib/market/version';

// 技能市场：beaconPack 包格式 + 版本 + 目录。
//
// 【它替掉了什么】此前「从网址导入技能」靠一条**宽松识别链**：把任意 JSON 里
// name/title、prompt/template/instructions/body/content 这些字段挨个试一遍，猜中就收。
// 那在「用户自己贴一个链接」时够用，但市场要回答的是：谁做的？版本几？装了会跑什么？
// 靠猜字段答不了，答不了就做不了「有新版本可更新」。
//
// 【这份用例守的几件事】
//   · 包里只能有数据，不能有代码（那条红线在格式层就要挡住）；
//   · 版本比较不能出错——「1.10 比 1.9 旧」是这类功能的经典 bug；
//   · 人设包**默认不启用**：它直接进每次运行的系统提示词，等于让陌生人给你的 AI 写常驻指令。

const goodSkill = {
  beaconPack: 1,
  pack: {
    kind: 'skill',
    slug: 'xhs-punch',
    name: '小红书爆改',
    description: '把平铺直叙的文案改成小红书调性',
    emoji: '📕',
    version: '1.2.0',
    author: '某人',
    platform: 'xiaohongshu',
    outputKind: 'text',
    promptTemplate: '请把下面的正文改写成小红书风格：\n{{content}}',
  },
};

describe('包格式：严格，不再猜字段', () => {
  it('合法的技能包解析得了', () => {
    const r = parsePack(goodSkill);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pack.name).toBe('小红书爆改');
  });

  it('没有 beaconPack 版本标记的一律不认（这是「是不是烽火台的包」的唯一判据）', () => {
    const r = parsePack({ pack: goodSkill.pack });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('beaconPack');
  });

  it('技能模板必须含 {{content}}——没有它技能无处安放输入', () => {
    // 样本要足够长，否则先撞长度下限、验不到占位符这条
    const r = parsePack({
      ...goodSkill,
      pack: { ...goodSkill.pack, promptTemplate: '请把这段文字改写得更活泼一些，多用短句，少用书面语。' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('content');
  });

  it('slug 只认小写字母数字连字符（它是「同一个东西的新版本」的认人依据）', () => {
    for (const bad of ['Has Space', '中文', 'UPPER', 'a', '-lead']) {
      const r = parsePack({ ...goodSkill, pack: { ...goodSkill.pack, slug: bad } });
      expect(r.ok, `slug「${bad}」不该通过`).toBe(false);
    }
  });

  it('版本号必须三段式（两段的话没法跟三段的比大小）', () => {
    for (const bad of ['1.0', 'v1.0.0', '1.0.0-beta', 'latest']) {
      const r = parsePack({ ...goodSkill, pack: { ...goodSkill.pack, version: bad } });
      expect(r.ok, `版本「${bad}」不该通过`).toBe(false);
    }
  });

  it('工作流包的步骤过的是同一份 zod——**不许有自由脚本步**', () => {
    const withShell = {
      beaconPack: 1,
      pack: {
        kind: 'workflow', slug: 'evil', name: '坏模板', version: '1.0.0',
        steps: [{ kind: 'shell', cmd: 'rm -rf /' }],
      },
    };
    // 这一条守的是那条红线：包是可以被任意人分享的，
    // 一旦步骤类型能自定义，市场就成了一个任意代码执行通道
    expect(parsePack(withShell).ok).toBe(false);
  });

  it('认不出的 kind 直接拒（能力与浏览器动作永远不进包）', () => {
    const r = parsePack({ beaconPack: 1, pack: { ...goodSkill.pack, kind: 'tool' } });
    expect(r.ok).toBe(false);
  });
});

describe('版本比较：「1.10 比 1.9 新」这类经典 bug', () => {
  it('按段比，不是按字符串比', () => {
    expect(compareVersion('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersion('1.0.0', '1.0.1')).toBeLessThan(0);
    expect(compareVersion('2.0.0', '1.99.99')).toBeGreaterThan(0);
    expect(compareVersion('1.2.3', '1.2.3')).toBe(0);
  });

  it('缺段按 0 补（存量行的 "1.0" 要能跟 "1.0.0" 比）', () => {
    expect(compareVersion('1.0', '1.0.0')).toBe(0);
    expect(compareVersion('1.0', '1.0.1')).toBeLessThan(0);
  });

  it('minAppVersion 不满足时装不上', () => {
    expect(versionSatisfied('99.0.0', APP_VERSION)).toBe(false);
    expect(versionSatisfied('0.1.0', APP_VERSION)).toBe(true);
    expect(versionSatisfied(undefined, APP_VERSION), '没声明就是不限制').toBe(true);
  });

  it('产品版本号与 package.json 一致（漂了会让 minAppVersion 判错）', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')) as { version: string };
    expect(APP_VERSION, 'lib/market/version.ts 与 package.json 的版本号对不上').toBe(pkg.version);
  });
});

describe('目录：三态要在服务端算好', () => {
  const entries: MarketEntry[] = [
    { kind: 'skill', slug: 'a', name: 'A', description: '', emoji: '🧩', version: '2.0.0', author: '', platform: 'generic', url: 'https://x/a.json' },
    { kind: 'skill', slug: 'b', name: 'B', description: '', emoji: '🧩', version: '1.0.0', author: '', platform: 'generic', url: 'https://x/b.json' },
    { kind: 'skill', slug: 'c', name: 'C', description: '', emoji: '🧩', version: '1.0.0', author: '', platform: 'generic', url: 'https://x/c.json' },
  ];

  it('没装 / 已最新 / 有新版本，三态分得开', () => {
    const marked = markInstalled(entries, [
      { slug: 'mkt-a', version: '1.0.0' }, // 目录里是 2.0.0 → 有新版本
      { slug: 'mkt-b', version: '1.0.0' }, // 一样 → 已最新
    ]);
    expect(marked.find((e) => e.slug === 'a')?.state).toBe('update_available');
    expect(marked.find((e) => e.slug === 'b')?.state).toBe('installed');
    expect(marked.find((e) => e.slug === 'c')?.state).toBe('not_installed');
  });

  it('本地 slug 的 mkt- 前缀在比对时要剥掉（不剥就永远显示「没装」）', () => {
    const marked = markInstalled(entries, [{ slug: 'mkt-b', version: '1.0.0' }]);
    expect(marked.find((e) => e.slug === 'b')?.state).not.toBe('not_installed');
  });
});

describe('装进来之后', () => {
  const h = vi.hoisted(() => ({}));
  void h;
  let tenantId: string;
  let memberId: string;

  beforeEach(async () => {
    await prisma.skillInstall.deleteMany();
    await prisma.contentSkill.deleteMany();
    const tenant = await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } });
    tenantId = tenant.id;
    const m = await prisma.member.create({ data: { tenantId, name: '张三', role: 'owner' } });
    memberId = m.id;
  });

  it('技能包装完即可用（与「自建技能创建即安装」同一口径）', async () => {
    const { installPack } = await import('@/lib/market/install');
    const r = await installPack(tenantId, memberId, goodSkill, 'https://x/a.json');
    expect(r.ok).toBe(true);

    const skill = await prisma.contentSkill.findFirstOrThrow({ where: { tenantId } });
    expect(skill.slug, '市场装的用 mkt- 前缀，与用户自建的 custom- 一眼可分').toBe('mkt-xhs-punch');
    expect(skill.version).toBe('1.2.0');
    expect(skill.sourceUrl, '不记来源就没法检查更新，也说不清「这东西哪来的」').toBe('https://x/a.json');
    const installed = await prisma.skillInstall.count({ where: { tenantId } });
    expect(installed, '装完还要再点一次「启用」是多余的一步').toBe(1);
  });

  it('**人设包默认不启用**——它直接进每次运行的系统提示词', async () => {
    const { installPack } = await import('@/lib/market/install');
    const personaPack = {
      beaconPack: 1,
      pack: {
        kind: 'persona', slug: 'sharp-editor', name: '毒舌编辑', version: '1.0.0',
        persona: '你是一个非常挑剔的编辑，说话直接不绕弯子，专挑逻辑漏洞。',
      },
    };
    const r = await installPack(tenantId, memberId, personaPack, 'https://x/p.json');
    expect(r.ok).toBe(true);

    expect(await prisma.contentSkill.count({ where: { tenantId } })).toBe(1);
    // 人设等于让一个陌生人给你的 AI 写常驻指令——必须用户看过全文再自己打开
    expect(
      await prisma.skillInstall.count({ where: { tenantId } }),
      '人设包不该装完就生效',
    ).toBe(0);
  });

  it('旧版本盖不掉新版本（市场最容易出的静默倒退）', async () => {
    const { installPack } = await import('@/lib/market/install');
    await installPack(tenantId, memberId, goodSkill, 'https://x/a.json');

    const older = { ...goodSkill, pack: { ...goodSkill.pack, version: '1.0.0', name: '旧版本' } };
    const r = await installPack(tenantId, memberId, older, 'https://x/a.json');
    expect(r.ok).toBe(false);

    const skill = await prisma.contentSkill.findFirstOrThrow({ where: { tenantId } });
    expect(skill.version, '被旧版盖回去了').toBe('1.2.0');
    expect(skill.name).toBe('小红书爆改');
  });

  it('新版本装得上，且算作「更新」而不是新增一条', async () => {
    const { installPack } = await import('@/lib/market/install');
    await installPack(tenantId, memberId, goodSkill, 'https://x/a.json');

    const newer = { ...goodSkill, pack: { ...goodSkill.pack, version: '2.0.0', name: '小红书爆改 Pro' } };
    const r = await installPack(tenantId, memberId, newer, 'https://x/a.json');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.updated).toBe(true);

    expect(await prisma.contentSkill.count({ where: { tenantId } }), '不该多出一条').toBe(1);
    const skill = await prisma.contentSkill.findFirstOrThrow({ where: { tenantId } });
    expect(skill.version).toBe('2.0.0');
  });

  it('产品版本不够时明说，而不是装完在运行时炸', async () => {
    const { installPack } = await import('@/lib/market/install');
    const future = { ...goodSkill, pack: { ...goodSkill.pack, minAppVersion: '99.0.0' } };
    const r = await installPack(tenantId, memberId, future);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('升级');
    expect(await prisma.contentSkill.count()).toBe(0);
  });
});

describe('包格式版本', () => {
  it('PACK_VERSION 是 1（改它意味着老包全部装不上，要有迁移方案）', () => {
    expect(PACK_VERSION).toBe(1);
  });
});
