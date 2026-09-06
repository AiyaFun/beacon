import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '@/lib/db';
import { enqueueBrowserTask, claimNextTask, completeTask, releaseExpiredLeases } from '@/lib/browser-task';
import { MAX_ATTEMPTS } from '@/lib/browser-task/kinds';
import { issueIngestToken, resolveIngestToken } from '@/lib/ingest/token';

// 2026-09-04 多代理审计的中危批（#13/#14/#15/#16/#18/#21/#22/#23/#24/#25/#26/#27/#33/#34/#36/#37）。
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let workspaceId = ''; let memberId = ''; let competitorId = '';
beforeEach(async () => {
  await prisma.tenant.deleteMany();
  await prisma.competitorAccount.deleteMany();
  const t = await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } });
  const w = await prisma.workspace.create({ data: { tenantId: t.id, name: 'W' } });
  workspaceId = w.id;
  memberId = (await prisma.member.create({ data: { tenantId: t.id, name: '张三', role: 'owner' } })).id;
  competitorId = (await prisma.competitorAccount.create({ data: { platform: 'x', handle: 'rival', name: 'R' } })).id;
  await prisma.watchlistItem.create({ data: { workspaceId, competitorId } });
  const { token } = await issueIngestToken({ workspaceId, memberId, label: 'dev' });
  await resolveIngestToken(token, { kinds: 'collect_competitor' });
});
const enq = () => enqueueBrowserTask({ workspaceId, payload: { kind: 'collect_competitor', competitorId, limit: 5 }, createdBy: memberId });

describe('交活：写回带状态条件，被取代/取消的不复活（#13/#15/#32）', () => {
  it('领走之后被取消，再交活 → 不收，状态仍是 cancelled', async () => {
    await enq();
    const c = await claimNextTask(workspaceId, 'A');
    await prisma.browserTask.update({ where: { id: c!.id }, data: { status: 'cancelled' } });
    const r = await completeTask(workspaceId, c!.id, { ok: true, result: '采到 3 条' }, 'A');
    expect(r.ok).toBe(false);
    expect((await prisma.browserTask.findUnique({ where: { id: c!.id } }))?.status, '被取消的活被交活复活了').toBe('cancelled');
  });

  it('租约过期被 B 重领后，A 的迟到结果不收', async () => {
    await enq();
    const a = await claimNextTask(workspaceId, 'A');
    await prisma.browserTask.update({ where: { id: a!.id }, data: { leaseUntil: new Date(Date.now() - 1000) } });
    const b = await claimNextTask(workspaceId, 'B');
    expect(b?.id).toBe(a!.id);
    const late = await completeTask(workspaceId, a!.id, { ok: true, result: 'A 的旧结果' }, 'A');
    expect(late.ok, 'A 的迟到结果被收了').toBe(false);
    expect((await prisma.browserTask.findUnique({ where: { id: a!.id } }))?.status).toBe('claimed');
  });

  it('🔒 交活路由先验状态/持有者再落库，且把 claimerId 传给 completeTask', () => {
    const src = strip(read('app/api/ingest/tasks/route.ts'));
    const guardAt = src.indexOf("cur.status !== 'claimed'");
    const ingestAt = src.indexOf('ingestParsedPage');
    expect(guardAt, '没有先验状态').toBeGreaterThan(-1);
    expect(guardAt, '状态校验在落库之后——作废的活照样改数据').toBeLessThan(ingestAt);
    expect(src).toMatch(/completeTask\([^)]*\}, claimerId\)/);
    // open_and_read 读回空正文不算成功
    expect(src).toMatch(/if \(!accepted\.stored\) \{ okFlag = false/);
  });
});

describe('租约静默过期也计次（#14）', () => {
  it('领了不还满 MAX_ATTEMPTS 次 → 判死，不再无上限重领', async () => {
    await enq();
    let id = '';
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const c = await claimNextTask(workspaceId, `E${i}`);
      expect(c, `第 ${i + 1} 次应该能领到`).toBeTruthy();
      id = c!.id;
      await prisma.browserTask.update({ where: { id }, data: { leaseUntil: new Date(Date.now() - 1000) } });
    }
    await releaseExpiredLeases();
    const row = await prisma.browserTask.findUnique({ where: { id } });
    expect(row?.status, '领了不还满上限仍被放回池子').toBe('failed');
    expect(row?.error).toMatch(/没交回结果/);
    expect(await claimNextTask(workspaceId, 'Z')).toBeNull();
  });
});

describe('文案：通知不叫「插件」，登录提示只在相关时加（#22/#34）', () => {
  it('🔒 源码里没有「插件跑完了 / 插件没跑成」', () => {
    const src = strip(read('lib/browser-task/index.ts'));
    expect(src).not.toMatch(/插件跑完了|插件没跑成/);
    expect(src, '「常见原因是目标平台没登录」还在无差别追加').not.toMatch(/常见原因是目标平台没登录/);
  });
});

describe('数据：北京时间逻辑日、回填、合并（#25/#26/#27/#36/#37）', () => {
  it('🔒 local-run 的逻辑日用 beijingDayKey，不用容器本地时区', () => {
    const src = strip(read('lib/browser-task/local-run.ts'));
    expect(src).toMatch(/function todayStr\(\): string \{\s*return beijingDayKey\(\);/);
  });
  it('🔒 竞对入库：已存在的行回填空标题/发布时间/链接，hotScore 按合并后的 views', () => {
    const src = strip(read('lib/ingest/competitor.ts'));
    expect(src).toMatch(/backfill\.publishedAt = post\.publishedAt/);
    expect(src).toMatch(/const merged = \{ \.\.\.prev, \.\.\.metrics \};\s*const hotScore = Math\.round\(\(\(\(merged/);
  });
  it('🔒 定时抓取通道合并而非覆盖；适配器缺席字段不填 0', () => {
    expect(strip(read('lib/pipeline.ts'))).toMatch(/const merged = \{ \.\.\.prev, \.\.\.p\.metrics \}/);
    const ad = strip(read('lib/adapters/competitor-real.ts'));
    expect(ad).toMatch(/function num\(v: unknown\): number \| undefined/);
    expect(ad).toMatch(/metrics: compact\(\{/);
  });
  it('🔒 xhs.js 无标题且无指标的卡片整条丢掉', () => {
    expect(strip(read('extension/content/xhs.js'))).toMatch(/if \(!title && likes == null\) continue;/);
  });
});

describe('整机版启动器与桌面执行器（#24/#16/#18/#28/#33）', () => {
  it('🔒 整机版 ensureLocalBrowser 用独立 profile，不再要求用户退出 Chrome', () => {
    const src = strip(read('lib/browser/launch.ts'));
    expect(src).toMatch(/--user-data-dir=\$\{dir\}/);
    expect(src, '还在要求 ⌘Q').not.toMatch(/完全退出 Chrome/);
    expect(src, '还在指向已删除的托盘项').not.toMatch(/「启动采集浏览器」/);
  });
  it('🔒 执行器交活看回应：401 清登记、非 2xx 不记成功；托盘不在主线程阻塞；子进程被回收；按 pid 抬窗口', () => {
    const ex = strip(read('desktop/src-tauri/src/executor.rs'));
    expect(ex, '交活结果又被 let _ 吞了').not.toMatch(/let _ = client\s*\.post\(/);
    expect(ex).toMatch(/status\(\)\.as_u16\(\) == 401 => \{[\s\S]{0,200}clear_config\(app\)/);
    expect(ex).toMatch(/!r\.status\(\)\.is_success\(\)/);
    const cb = strip(read('desktop/src-tauri/src/collect_browser.rs'));
    expect(cb).toMatch(/SPAWNED_PID\.store\(child\.id\(\)/);
    expect(cb, '子进程没人 wait，会挂成 defunct').toMatch(/std::thread::spawn\(move \|\| \{ let mut c = child; let _ = c\.wait\(\); \}\)/);
    expect(cb, '抬窗口没按 pid，会把用户日常的 Chrome 抬起来').toMatch(/first process whose unix id is \{pid\}/);
    const main = strip(read('desktop/src-tauri/src/main.rs'));
    const arm = main.slice(main.indexOf('"collect" => {'), main.indexOf('"shortcut" => {'));
    expect(arm, '托盘「打开采集浏览器」仍在主线程阻塞').toMatch(/std::thread::spawn\(move \|\| \{/);
  });
});

describe('审计低危三条（2026-09-05 下午，客户端 1.2.18）：#29 机器名 / #35 profile 命名 / #17 Windows 抬窗口', () => {
  it('🔒 壳报机器名，网页把它拼进令牌标签；老客户端不报就退回原样', () => {
    const ex = strip(read('desktop/src-tauri/src/executor.rs'));
    expect(ex).toMatch(/pub host: String/);
    expect(ex).toMatch(/s\.host = host_name\(\);/);
    expect(ex, 'mac 上要用系统设置里的电脑名，不是 xxx.local').toMatch(/scutil.*ComputerName/);
    const act = strip(read('app/(app)/settings/actions.ts'));
    expect(act).toMatch(/host\?: string/);
    expect(act).toMatch(/\$\{host \? ` · \$\{host\}` : ''\}/);
    for (const p of ['components/DesktopBrowserUsePrompt.tsx', 'components/DesktopExecutorCard.tsx']) {
      expect(strip(read(p)), `${p} 没把 host 传给签令牌`).toMatch(/agent: 'desktop', host: status\?\.host/);
    }
  });
  it('🔒 采集浏览器 profile 首次建时命名，之后绝不再碰 Preferences（覆盖会抹掉登录态）', () => {
    const cb = strip(read('desktop/src-tauri/src/collect_browser.rs'));
    expect(cb).toMatch(/name_profile\(&dir\);/);
    const fn = cb.slice(cb.indexOf('fn name_profile'), cb.indexOf('pub fn wipe'));
    expect(fn).toMatch(/if prefs\.exists\(\) \{\s*return;/);
    expect(fn).toContain('烽火台采集浏览器');
  });
  it('🔒 Windows 按 pid 抬窗口，不引额外 crate、不闪黑框；只在等登录时调', () => {
    const cb = strip(read('desktop/src-tauri/src/collect_browser.rs'));
    const win = cb.slice(cb.indexOf('#[cfg(target_os = "windows")]'), cb.indexOf('// Linux：'));
    expect(win).toMatch(/AppActivate\(\{pid\}\)/);
    expect(win).toMatch(/creation_flags\(0x0800_0000\)/);
    expect(read('desktop/src-tauri/Cargo.toml')).not.toMatch(/winapi|windows-sys/);
  });
});
