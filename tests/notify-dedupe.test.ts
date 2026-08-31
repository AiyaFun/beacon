import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { between } from './helpers/anchor';

// notify() 从来不按 refId 去重，而三处注释都写着它会（2026-08-30 修）。
//
// ── 错误信念的源头在 schema ──
// `refId String? // 关联对象（如 publishId），用于同一对象去重`
// ——DB 上没有唯一约束，notify() 也只是个裸 create。这句话被照字面理解，
// 传播到了至少两处调用点的注释里，两处都据此写了「所以这里不用自己去重」的代码：
//
//   · lib/scrape/recipe.ts noticeStaleRecipes：refId 特意带天数「免得被合并」，
//     而每 6 小时那条 cron 一天跑 4 轮 → 同一天发 4 条一模一样的；
//   · lib/skill/distill.ts：refId 是做法指纹、**没有天数分量**，
//     注释写「同一种做法只提醒一次」，实际由 optimize_memory 每天 05:30 发，
//     只要用户不去存成技能就**永远天天发**，一轮最多 3 条，而且**没有形态闸**（SaaS 也发）。
//
// 后果不是丢数据，是把「等你确认」「套餐到期」这类真正要人动手的通知挤出可见列表
//（Topbar 的下拉只取最近 12 条）——正是 distill 自己注释里写的「三天后就没人看通知」。
const ROOT = process.cwd();
const code = (p: string) => readFileSync(join(ROOT, p), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('notify 的去重是 opt-in，且真正需要的调用点都传了', () => {
  const notify = code('lib/notify.ts');

  it('🔒 传了 once 才查重（默认不动，否则表现异常那类会被一起掐掉）', () => {
    expect(notify).toContain('if (params.once && params.refId)');
    expect(notify, '没有真的去查').toContain('notification.count');
    const seg = between(notify, 'if (params.once && params.refId)', 'notification\n    .create');
    expect(seg, '查了却没有据此提前返回').toContain('return;');
  });

  it('🔒 默认仍然照发（这个改动不许悄悄改变既有调用点的行为）', () => {
    // once 缺省为 undefined → 短路 → 走到 create。表现异常/爆款加速这些
    // 本来就该在情况变化时再响一次。
    expect(notify).toMatch(/once\?: boolean/);
    expect(notify, 'once 变成默认开了').not.toMatch(/once\s*=\s*true/);
  });

  const CALLERS: [string, string, string][] = [
    ['lib/scrape/recipe.ts', 'recipe-stale', '配方久未成功'],
    ['lib/skill/distill.ts', 'procedure-suggest', '做法可存成技能'],
  ];

  it.each(CALLERS)('%s 的 %s 传了 once（%s）', (file, refIdPrefix) => {
    const src = code(file);
    const i = src.indexOf(refIdPrefix);
    expect(i, `${file} 里找不到 ${refIdPrefix}，这条守卫要跟着改`).toBeGreaterThan(0);
    // 就在这条 notify 调用里，不是文件别处
    expect(
      src.slice(i, i + 400),
      `${file} 的 ${refIdPrefix} 没传 once——notify 不会自己合并，这条会重复发`,
    ).toContain('once: true');
  });

  it('🔒 没有天数分量的那条尤其不能少 once（少了就是永远天天发）', () => {
    const distill = code('lib/skill/distill.ts');
    const i = distill.indexOf('procedure-suggest');
    const refIdLine = distill.slice(i - 40, i + 60);
    expect(refIdLine, 'refId 里没有天数——那么去重完全靠 once').not.toContain('days');
    expect(distill.slice(i, i + 400)).toContain('once: true');
  });

  it('🔒 schema 的注释不许再说「refId 用于去重」（错误信念的源头）', () => {
    for (const f of ['prisma/schema.prisma', 'prisma/schema.postgres.prisma']) {
      const raw = readFileSync(join(ROOT, f), 'utf8');
      const i = raw.indexOf('refId       String?');
      expect(i, `${f} 里找不到 Notification.refId`).toBeGreaterThan(0);
      const seg = raw.slice(i, i + 300);
      expect(seg, `${f} 又写成「refId 用于去重」了——DB 上没有唯一约束，notify 也不自动合并`)
        .toContain('**本身不去重**');
    }
  });
});
