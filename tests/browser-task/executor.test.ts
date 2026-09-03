import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '@/lib/db';
import { parseKindsHeader, resolveIngestToken, issueIngestToken } from '@/lib/ingest/token';
import { collectorKinds, claimNextTask, enqueueBrowserTask, completeTask, LEGACY_PLUGIN_KINDS } from '@/lib/browser-task';
import { vetBrowserTaskArgs } from '@/lib/browser-task/vet';
import { orderedBefore, between } from '../helpers/anchor';

// 执行器能力自报 + 桌面客户端执行器（2026-09-03）。
//
// 真机事故：服务端新加了 collect_self_profile，派给用户机器上的旧插件，它领了回「不认识」，
// 重试三次判死，AI 执行挂着等了半天。修法不是按版本号判，是按**能力**判：执行器领活时自报会做哪些 kind，
// 服务端记在令牌上、只派它会做的；没自报的按老三种。

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let workspaceId = '';
let memberId = '';
let competitorId = '';
beforeEach(async () => {
  await prisma.tenant.deleteMany();
  await prisma.competitorAccount.deleteMany();
  const t = await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } });
  const w = await prisma.workspace.create({ data: { tenantId: t.id, name: 'W' } });
  workspaceId = w.id;
  const m = await prisma.member.create({ data: { tenantId: t.id, name: '张三', role: 'owner' } });
  memberId = m.id;
  const c = await prisma.competitorAccount.create({ data: { platform: 'x', handle: 'rival', name: 'R' } });
  competitorId = c.id;
  await prisma.watchlistItem.create({ data: { workspaceId, competitorId } });
});

describe('能力头', () => {
  it('只认白名单里的 kind，去重排序；没带头 = null（老插件）', () => {
    expect(parseKindsHeader('collect_self_profile, collect_competitor,bogus,collect_competitor')).toEqual(['collect_competitor', 'collect_self_profile']);
    expect(parseKindsHeader(null)).toBeNull();
    expect(parseKindsHeader('')).toEqual([]);
  });

  it('领活时自报的能力立刻写到令牌上（不受 lastUsedAt 节流管），下次派活按它判', async () => {
    const { token } = await issueIngestToken({ workspaceId, memberId, label: 'dev' });
    expect(Array.from(await collectorKinds(workspaceId)).sort()).toEqual([...LEGACY_PLUGIN_KINDS].sort());
    await resolveIngestToken(token, { kinds: 'collect_competitor,collect_self_profile' });
    expect(Array.from(await collectorKinds(workspaceId)).sort()).toEqual(['collect_competitor', 'collect_self_profile']);
    // 紧接着又报一次不同的（插件更新了）：节流不能挡住能力变化
    await resolveIngestToken(token, { kinds: 'collect_competitor' });
    expect(Array.from(await collectorKinds(workspaceId))).toEqual(['collect_competitor']);
  });
});

describe('派活按能力过滤', () => {
  it('旧插件（没自报）：回填自己的 X 主页被拒，说清去更新插件或登记桌面客户端；采竞对照派', async () => {
    await issueIngestToken({ workspaceId, memberId, label: 'dev' });
    await prisma.creatorAccount.create({ data: { workspaceId, name: '我的X', platform: 'x', handle: 'me' } });
    const r = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_self_profile', platform: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.error).toContain('版本旧了'); expect(r.error).toContain('桌面客户端'); }
    expect((await vetBrowserTaskArgs(workspaceId, { kind: 'collect_competitor', competitorId })).ok).toBe(true);
  });

  it('自报了 collect_self_profile 的执行器在：放行', async () => {
    const { token } = await issueIngestToken({ workspaceId, memberId, label: 'dev' });
    await resolveIngestToken(token, { kinds: 'collect_self_profile' });
    await prisma.creatorAccount.create({ data: { workspaceId, name: '我的X', platform: 'x', handle: 'me' } });
    expect((await vetBrowserTaskArgs(workspaceId, { kind: 'collect_self_profile', platform: 'x' })).ok).toBe(true);
  });

  it('本机浏览器就绪时不看插件能力（当场跑，与插件无关）', async () => {
    await issueIngestToken({ workspaceId, memberId, label: 'dev' });
    await prisma.creatorAccount.create({ data: { workspaceId, name: '我的X', platform: 'x', handle: 'me' } });
    const r = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_self_profile', platform: 'x' }, { localCdpUrl: 'http://127.0.0.1:9222' });
    expect(r.ok).toBe(true);
  });

  it('领活：只给这个执行器会做的 kind；没自报的按老三种', async () => {
    const acc = await prisma.creatorAccount.create({ data: { workspaceId, name: '我的X', platform: 'x', handle: 'me' } });
    await enqueueBrowserTask({ workspaceId, payload: { kind: 'collect_self_profile', platform: 'x', accountId: acc.id, handle: 'me' }, origin: 'agent', createdBy: memberId });
    expect(await claimNextTask(workspaceId, 'old-plugin', null)).toBeNull();
    const t = await claimNextTask(workspaceId, 'desktop', ['collect_self_profile']);
    expect(t?.kind).toBe('collect_self_profile');
  });

  it('「不认识」这种失败不重试，直接判死（再试三次也是同一句）', async () => {
    const r = await enqueueBrowserTask({ workspaceId, payload: { kind: 'collect_competitor', competitorId, limit: 20 }, origin: 'agent', createdBy: memberId });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await claimNextTask(workspaceId, 'p', null);
    const done = await completeTask(workspaceId, r.id, { ok: false, error: '这个版本的插件还不认识「collect_competitor」，请更新插件' });
    expect(done.status).toBe('failed');
  });
});

describe('🔒 接线', () => {
  it('领活路由：能力头传给鉴权与领活；采主页类任务附带 target；交活时 parsed 先落库再 completeTask', () => {
    const r = strip(read('app/api/ingest/tasks/route.ts'));
    expect(r).toContain('resolveIngestToken(req.headers.get(INGEST_TOKEN_HEADER), { kinds: kindsHeader })');
    expect(r).toContain('parseKindsHeader(kindsHeader))');
    expect(r).toContain('executorTarget(task)');
    orderedBefore(r, 'ingestParsedPage({', 'await completeTask(auth.workspace.id, taskId');
    // 解析结果落库失败 = 这次任务失败，不能把回执写成成功
    expect(between(r, 'ingestParsedPage({', 'await completeTask(')).toContain('okFlag = false; errorText = r.error');
  });

  it('执行器脚本端点：同一把令牌鉴权；脚本来自 local-collect（三条路一个解析器）', () => {
    const r = strip(read('app/api/ingest/executor/route.ts'));
    orderedBefore(r, 'resolveIngestToken(', 'loadParserSources(platform)');
    expect(r).toContain("from '@/lib/browser/local-collect'");
    expect(r).toContain('loginWall: LOGIN_WALL_FN');
  });

  it('插件轮询自报能力，且与 runBrowserTask 的分支一一对应', () => {
    const sw = read('extension/sw.js');
    expect(sw).toContain("'x-beacon-ingest-kinds': SUPPORTED_TASK_KINDS.join(',')");
    const listed = sw.match(/const SUPPORTED_TASK_KINDS = \[([^\]]+)\]/)![1].match(/'(\w+)'/g)!.map((s) => s.replace(/'/g, ''));
    const branches = Array.from(sw.matchAll(/task\.kind === '(\w+)'/g)).map((m) => m[1]);
    for (const k of new Set(branches)) expect(listed, `runBrowserTask 会做 ${k} 但没自报`).toContain(k);
    for (const k of listed) expect(branches, `自报了 ${k} 但 runBrowserTask 没这个分支`).toContain(k);
  });

  it('桌面登记卡：只在 Tauri 壳里渲染；令牌签出后直接交给壳，页面不存', () => {
    const c = read('components/DesktopExecutorCard.tsx');
    expect(c).toContain('__TAURI_INTERNALS__');
    expect(c).toContain('if (!inDesktop) return null');
    orderedBefore(c, 'await actIssueIngestToken()', "invoke('register_executor', { base: location.origin, token })");
    for (const bad of ['localStorage', 'sessionStorage', 'document.cookie']) expect(c).not.toContain(bad);
    expect(read('app/(app)/extension/page.tsx')).toContain('<DesktopExecutorCard />');
  });

  it('本机浏览器与桌面执行器共用同一份落库（ingestParsedPage），runBrowserTaskLocally 不再自己落库', () => {
    const r = strip(read('lib/browser-task/local-run.ts'));
    expect(r).toContain('export async function ingestParsedPage');
    const run = r.slice(r.indexOf('export async function runBrowserTaskLocally'));
    expect(run).toContain("ingestParsedPage({ workspaceId, payload, parsed: r.payload, channel: 'local_browser'");
    expect(run).not.toContain('ingestOwnPostData(');
    expect(run).not.toContain('ingestCompetitorData(');
  });
});
