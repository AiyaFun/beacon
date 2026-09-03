import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '@/lib/db';

const ROOT = path.resolve(__dirname, '..');
import {
  enqueueBrowserTask, claimNextTask, completeTask, releaseExpiredLeases, expireStaleTasks,
  BROWSER_TASK_KINDS, MAX_ATTEMPTS, retriable,
} from '@/lib/browser-task';

// 派给浏览器的活。
//
// 【这份用例真正防的是「同一个活被两个浏览器同时领走」】用户很可能在公司和家里
// 各装一个插件，两边同时醒来。领重了 = 同一批数据采两遍、指标算两次。
// 防重靠的是带 status 条件的 updateMany（乐观锁），不是 findFirst + update。

let wsId = '';
const enq = (payload: unknown, extra: Record<string, unknown> = {}) =>
  enqueueBrowserTask({ workspaceId: wsId, payload, createdBy: 'm1', ...extra });

beforeEach(async () => {
  await prisma.tenant.deleteMany();
  await prisma.workspace.deleteMany();
  const t = await prisma.tenant.create({ data: { name: 't' } });
  const w = await prisma.workspace.create({ data: { tenantId: t.id, name: 'w' } });
  wsId = w.id;
});

describe('白名单：没注册的动作就是做不了', () => {
  it('只认注册过的 kind', async () => {
    const bad = await enq({ kind: 'open_url', url: 'https://evil.example' });
    expect(bad.ok).toBe(false);
    // 关键是**拒收**，不是拒收时说了什么
    expect(BROWSER_TASK_KINDS).not.toContain('open_url' as never);
  });

  it('参数形状不对也拒收（limit 超过服务端一批上限）', async () => {
    const bad = await enq({ kind: 'collect_competitor', competitorId: 'c1', limit: 500 });
    expect(bad.ok).toBe(false);
    const ok = await enq({ kind: 'collect_competitor', competitorId: 'c1', limit: 20 });
    expect(ok.ok).toBe(true);
  });

  it('会产生对外动作的任务将来不许可重试——现在两项都是幂等读', () => {
    for (const k of BROWSER_TASK_KINDS) expect(retriable(k)).toBe(true);
  });
});

describe('服务端不许排一个插件不会做的活', () => {
  const sw = fs.readFileSync(path.join(ROOT, 'extension/sw.js'), 'utf8');

  it('collect_self 已随公众号采集一起删除——服务端不许再排这个 kind', async () => {
    // 它唯一支持的平台是公众号（插件开用户自己的后台步进采）。整条通道 2026-09-03 撤掉后，
    // 这个 kind 没有任何平台可派；留着就是能排一个插件不会做的活。
    for (const p of ['wechat', 'douyin', 'xiaohongshu', 'bilibili', 'x']) {
      expect((await enq({ kind: 'collect_self', platform: p })).ok, `${p} 不该放行`).toBe(false);
    }
    expect(sw, '插件里还留着公众号后台那条路').not.toMatch(/mp\.weixin\.qq\.com/);
  });

  it('collect_self_profile：只放行插件 SELF_COLLECT_URL 里有入口的平台，且必须带账号与 handle', async () => {
    const good = await enq({ kind: 'collect_self_profile', platform: 'x', accountId: 'acc1', handle: 'aiyafun' });
    expect(good.ok).toBe(true);
    expect((await enq({ kind: 'collect_self_profile', platform: 'tiktok', accountId: 'acc1', handle: 'me' })).ok).toBe(true);
    for (const p of ['wechat', 'douyin', 'xiaohongshu', 'bilibili']) {
      expect((await enq({ kind: 'collect_self_profile', platform: p, accountId: 'acc1', handle: 'h' })).ok, `${p} 不该放行`).toBe(false);
    }
    // 没有账号/handle 的不许入队：插件那头不再猜归属，也拼不出主页地址
    expect((await enq({ kind: 'collect_self_profile', platform: 'x', handle: 'h' })).ok).toBe(false);
    expect((await enq({ kind: 'collect_self_profile', platform: 'x', accountId: 'acc1' })).ok).toBe(false);
  });

  it('插件那张 SELF_COLLECT_URL 真的有 x 与 tiktok——SELF_PROFILE_PLATFORMS 只能是它的子集', async () => {
    const { SELF_PROFILE_PLATFORMS } = await import('@/lib/browser-task/kinds');
    const block = sw.slice(sw.indexOf('const SELF_COLLECT_URL'), sw.indexOf('function selfCollectUrl'));
    for (const p of SELF_PROFILE_PLATFORMS) expect(block, `插件没有 ${p} 的主页入口`).toMatch(new RegExp(`^\\s{2}${p}:`, 'm'));
  });

  it('collect_self_profile 在插件里核对 handle，对不上一条都不回填', () => {
    const fn = sw.slice(sw.indexOf('async function collectSelfProfileTask'), sw.indexOf('/**\n * 打开一个网页、把正文读回来'));
    expect(fn).toMatch(/norm\(payload\.handle\) !== norm\(handle\)/);
    expect(fn).toContain('accountId: task.accountId || task.payload.accountId');
    expect(fn).toContain('active: false');
  });

  it('插件认识白名单里的每一种 kind', () => {
    for (const k of BROWSER_TASK_KINDS) {
      expect(sw, `插件的 runBrowserTask 不认识 ${k}`).toMatch(new RegExp(`task\\.kind === '${k}'`));
    }
  });

  it('插件对不认识的 kind 要如实交回失败，不能傻等到超时', () => {
    const fn = sw.slice(sw.indexOf('async function runBrowserTask'), sw.indexOf('async function drainBrowserTasks'));
    expect(fn).toMatch(/还不认识/);
  });

  it('每条活都当场交回结果——没有「先报成功、真实结果稍后再说」的分支', () => {
    // 曾经有一条 deferred（公众号后台回填由 finishSelfAuto 收尾）。那条通道删掉之后，
    // 留着 deferred 就是留一条「开了个标签页」会被记成最终结果的路。
    const drain = sw.slice(sw.indexOf('async function drainBrowserTasks'));
    expect(drain, '还留着 deferred 分支').not.toMatch(/deferred/);
    expect(drain).toMatch(/await reportBrowserTask\(task\.id, outcome\.ok/);
  });
});

describe('领活：两个浏览器同时来，只能有一个领走', () => {
  it('并发领取同一条，只有一个拿到', async () => {
    await enq({ kind: 'collect_competitor', competitorId: 'c1', limit: 5 });
    const [a, b] = await Promise.all([claimNextTask(wsId, 'browser-A'), claimNextTask(wsId, 'browser-B')]);
    const got = [a, b].filter(Boolean);
    expect(got, '同一条活被领了两次').toHaveLength(1);
  });

  it('两条活两个浏览器各领一条，不会都盯着同一条', async () => {
    await enq({ kind: 'collect_competitor', competitorId: 'c1', limit: 5 });
    await enq({ kind: 'collect_competitor', competitorId: 'c9', limit: 5 });
    const [a, b] = await Promise.all([claimNextTask(wsId, 'A'), claimNextTask(wsId, 'B')]);
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a!.id).not.toBe(b!.id);
  });

  it('没活时返回 null，不抛', async () => {
    expect(await claimNextTask(wsId, 'A')).toBeNull();
  });

  it('别的工作区的活领不到', async () => {
    await enq({ kind: 'collect_competitor', competitorId: 'c1', limit: 5 });
    const other = await prisma.workspace.create({
      data: { tenantId: (await prisma.tenant.findFirst())!.id, name: 'w2' },
    });
    expect(await claimNextTask(other.id, 'A')).toBeNull();
  });

  it('过期的活不许再被领走', async () => {
    const r = await enq({ kind: 'collect_competitor', competitorId: 'c1', limit: 5 });
    await prisma.browserTask.update({
      where: { id: (r as { id: string }).id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await claimNextTask(wsId, 'A')).toBeNull();
  });
});

describe('租约：领了不还是常态，不是异常', () => {
  it('租约到期自动放回池子，下一个浏览器能领到', async () => {
    await enq({ kind: 'collect_competitor', competitorId: 'c1', limit: 5 });
    const first = await claimNextTask(wsId, 'A');
    expect(first).toBeTruthy();
    // 领了就走人（关标签页/关机/崩溃）
    expect(await claimNextTask(wsId, 'B'), '租约没到期就被别人领走了').toBeNull();

    await prisma.browserTask.updateMany({ where: { id: first!.id }, data: { leaseUntil: new Date(Date.now() - 1000) } });
    const second = await claimNextTask(wsId, 'B');
    expect(second, '租约到期了却没放回池子').toBeTruthy();
    expect(second!.id).toBe(first!.id);
  });

  it('releaseExpiredLeases 只动过期的，没到期的一条不碰', async () => {
    await enq({ kind: 'collect_competitor', competitorId: 'c1', limit: 5 });
    const t = await claimNextTask(wsId, 'A');
    expect(await releaseExpiredLeases()).toBe(0);
    expect((await prisma.browserTask.findUnique({ where: { id: t!.id } }))!.status).toBe('claimed');
  });
});

describe('交活', () => {
  it('成功就结案', async () => {
    await enq({ kind: 'collect_competitor', competitorId: 'c1', limit: 5 });
    const t = await claimNextTask(wsId, 'A');
    const r = await completeTask(wsId, t!.id, { ok: true, result: '采到 12 条' });
    expect(r.ok).toBe(true);
    expect(r.status).toBe('done');
    expect((await prisma.browserTask.findUnique({ where: { id: t!.id } }))!.result).toContain('12');
  });

  it('失败且还能重试就放回池子', async () => {
    await enq({ kind: 'collect_competitor', competitorId: 'c1', limit: 5 });
    const t = await claimNextTask(wsId, 'A');
    const r = await completeTask(wsId, t!.id, { ok: false, error: '没登录' });
    expect(r.status).toBe('pending');
    expect(await claimNextTask(wsId, 'B'), '放回池子了却领不到').toBeTruthy();
  });

  it('重试到上限就判死，别让一个死任务把每一轮都占掉', async () => {
    await enq({ kind: 'collect_competitor', competitorId: 'c1', limit: 5 });
    let last = '';
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const t = await claimNextTask(wsId, 'A');
      expect(t, `第 ${i + 1} 次应该还能领到`).toBeTruthy();
      last = (await completeTask(wsId, t!.id, { ok: false, error: 'boom' })).status ?? '';
    }
    expect(last).toBe('failed');
    expect(await claimNextTask(wsId, 'A')).toBeNull();
  });

  it('别的工作区改不动我的任务状态', async () => {
    await enq({ kind: 'collect_competitor', competitorId: 'c1', limit: 5 });
    const t = await claimNextTask(wsId, 'A');
    const other = await prisma.workspace.create({
      data: { tenantId: (await prisma.tenant.findFirst())!.id, name: 'w2' },
    });
    const r = await completeTask(other.id, t!.id, { ok: true });
    expect(r.ok).toBe(false);
  });

  it('没领就交活会被拒（租约过期被放回之后再交，不能覆盖别人的结果）', async () => {
    const e = await enq({ kind: 'collect_competitor', competitorId: 'c1', limit: 5 });
    const r = await completeTask(wsId, (e as { id: string }).id, { ok: true });
    expect(r.ok).toBe(false);
  });
});

describe('插件够得着这个接口吗', () => {
  it('/api/ingest/tasks 必须在中间件白名单里', () => {
    // 插件的 service worker 没有登录 cookie。漏登记 = 拿到 307→登录页 HTML，
    // JSON 解析失败被 catch 吞掉，插件**以为「没有活」**——任务一直 pending 到过期，
    // 而界面上还显示「等你的浏览器打开插件」。2026-08-20 上线时真漏了，靠线上探测才发现
    const mw = fs.readFileSync(path.join(ROOT, 'middleware.ts'), 'utf8');
    expect(mw, '中间件没放行领活接口').toMatch(/'\/api\/ingest\/tasks'/);
  });

  it('每个 app/api/ingest 下的路由都在白名单里（插件都够不着登录态）', () => {
    const mw = fs.readFileSync(path.join(ROOT, 'middleware.ts'), 'utf8');
    const dir = path.join(ROOT, 'app/api/ingest');
    const walk = (p: string, url: string, out: string[] = []): string[] => {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(p, e.name), `${url}/${e.name}`, out);
        else if (e.name === 'route.ts') out.push(url);
      }
      return out;
    };
    // 中间件是**前缀匹配**（middleware.ts: `pathname === p || pathname.startsWith(p + '/')`），
    // 所以 /api/ingest/self/accounts 由 '/api/ingest/self' 覆盖。守卫要用同一个口径，
    // 否则会把已经放行的子路径误报成漏登记（第一版就这么误报了三条）
    const listed = [...mw.matchAll(/'(\/api\/ingest\/[^']+)'/g)].map((m) => m[1]);
    const covered = (r: string) => listed.some((p) => r === p || r.startsWith(p + '/'));
    const routes = walk(dir, '/api/ingest');
    // 遍历或正则任何一头失效，missing 都会恒为空数组——而那时插件全线 307，守卫却是绿的
    expect(routes.length, '一个 ingest 路由都没扫到，遍历坏了').toBeGreaterThan(3);
    expect(listed.length, '中间件里一条 ingest 白名单都没解析出来，正则坏了').toBeGreaterThan(0);
    const missing = routes.filter((r) => !covered(r));
    expect(missing, `这些 ingest 路由没在中间件白名单里，插件会被 307 到登录页：${missing.join('、')}`).toEqual([]);
  });
});

describe('没装插件就别排——排了也没人领', () => {
  it('一枚未吊销的令牌都没有时，hasCollector 是 false', async () => {
    const { hasCollector } = await import('@/lib/browser-task');
    expect(await hasCollector(wsId)).toBe(false);
  });

  it('按设备签发的令牌算，吊销掉的不算', async () => {
    const { hasCollector } = await import('@/lib/browser-task');
    // memberId 可空（旧的工作区级令牌迁进来时没有签发人可考），这里就不建 Member 了
    const tok = await prisma.ingestToken.create({
      data: { workspaceId: wsId, token: `tk-${wsId}`, label: '我的电脑' },
    });
    expect(await hasCollector(wsId)).toBe(true);
    await prisma.ingestToken.update({ where: { id: tok.id }, data: { revokedAt: new Date() } });
    expect(await hasCollector(wsId), '吊销了的令牌不该还算「装了插件」').toBe(false);
  });

  it('老式的工作区令牌也算——存量用户没有按设备签发的那种', async () => {
    const { hasCollector } = await import('@/lib/browser-task');
    await prisma.workspace.update({ where: { id: wsId }, data: { ingestToken: `legacy-${wsId}` } });
    expect(await hasCollector(wsId)).toBe(true);
  });

  it('AI 的派活工具会先问一句，并把用户指到安装页', () => {
    // 2026-08-26 起这道闸收口到 lib/browser-task/vet.ts（对外调用面 /api/v1/browser-tasks
    // 也要走同一份）；派活工具必须调 vet，vet 里必须先查有没有插件
    const src = fs.readFileSync(path.join(ROOT, 'lib/agent/tools.ts'), 'utf8');
    const fn = src.slice(src.indexOf('const dispatchBrowserTask'), src.indexOf('const listBrowserTasks'));
    expect(fn, '派活工具没走统一的闸').toMatch(/vetBrowserTaskArgs\(ctx\.workspaceId/);
    const vet = fs.readFileSync(path.join(ROOT, 'lib/browser-task/vet.ts'), 'utf8');
    expect(vet, '派活前没查有没有插件').toMatch(/collectorKinds\(workspaceId\)/);
    expect(vet, '没告诉用户去哪装').toMatch(/采集助手/);
  });
});

describe('干完要说一声——派活到干完中间可能隔了几小时', () => {
  const notes = () => prisma.notification.findMany({ where: { workspaceId: wsId }, orderBy: { createdAt: 'asc' } });

  it('成功完成会发通知，带上做了什么', async () => {
    await enq({ kind: 'collect_competitor', competitorId: 'c1', limit: 5 });
    const t = await claimNextTask(wsId, 'A');
    await completeTask(wsId, t!.id, { ok: true, result: '更新 8 新增 2' });

    const rows = await notes();
    expect(rows, '干完了却没通知发起的人').toHaveLength(1);
    expect(rows[0].title).toContain('去采一个竞对');
    expect(rows[0].body).toContain('更新 8');
    // 点得回来。2026-08-26 落点从插件页改到运行中心（那里才有「这一次跑成什么样」）
    expect(rows[0].link).toBe('/runs');
  });

  it('还能重试时不吵——每次失败都推一条只会让人把通知关掉', async () => {
    await enq({ kind: 'collect_competitor', competitorId: 'c1', limit: 5 });
    const t = await claimNextTask(wsId, 'A');
    await completeTask(wsId, t!.id, { ok: false, error: '没登录' });
    expect(await notes(), '第一次失败就推了').toHaveLength(0);
  });

  it('判死了才说，并给出常见原因', async () => {
    await enq({ kind: 'collect_competitor', competitorId: 'c1', limit: 5 });
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const t = await claimNextTask(wsId, 'A');
      await completeTask(wsId, t!.id, { ok: false, error: '没登录' });
    }
    const rows = await notes();
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toContain('没跑成');
    expect(rows[0].body, '没告诉用户多半是什么原因').toMatch(/没登录/);
  });
});

describe('列表按紧急度排，不是按字母', () => {
  it('等你动手的排最前，已经过期的排后面', async () => {
    const { listBrowserTasksForUi } = await import('@/lib/browser-task');
    // 数据库 orderBy: status 是字母序（cancelled < claimed < done < expired < failed < pending），
    // 正好把最该看的 pending 排到最后。真机上第一眼看到的会是三天前那条没跑成的
    const mk = async (status: string, id: string) => {
      const e = await enq({ kind: 'collect_competitor', competitorId: id, limit: 5 });
      await prisma.browserTask.update({ where: { id: (e as { id: string }).id }, data: { status } });
    };
    await mk('expired', 'c1');
    await mk('done', 'c2');
    await mk('pending', 'c3');
    await mk('failed', 'c4');

    const rows = await listBrowserTasksForUi(wsId);
    expect(rows.map((r) => r.status)).toEqual(['pending', 'failed', 'expired', 'done']);
  });
});

describe('去重与过期', () => {
  it('一模一样的活不排两遍——AI 一轮里问两次不该跑两次', async () => {
    const a = await enq({ kind: 'collect_competitor', competitorId: 'c1', limit: 20 });
    const b = await enq({ kind: 'collect_competitor', competitorId: 'c1', limit: 20 });
    expect((a as { id: string }).id).toBe((b as { id: string }).id);
    expect(await prisma.browserTask.count({ where: { workspaceId: wsId } })).toBe(1);
  });

  it('参数不同就是两个活', async () => {
    await enq({ kind: 'collect_competitor', competitorId: 'c1', limit: 20 });
    await enq({ kind: 'collect_competitor', competitorId: 'c2', limit: 20 });
    expect(await prisma.browserTask.count({ where: { workspaceId: wsId } })).toBe(2);
  });

  it('过期标 expired 不标 failed——「没做」和「做失败」对用户是两件事', async () => {
    const e = await enq({ kind: 'collect_competitor', competitorId: 'c1', limit: 5 });
    await prisma.browserTask.update({
      where: { id: (e as { id: string }).id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await expireStaleTasks()).toBe(1);
    const row = await prisma.browserTask.findUnique({ where: { id: (e as { id: string }).id } });
    expect(row!.status).toBe('expired');
    expect(row!.error).toMatch(/没打开过|未被浏览器执行/);
  });
});
