import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '@/lib/db';
import {
  startOpSession, activeOpSession, pushStep, takeStep, putResult, takeResult, endOpSession, isAlive,
} from '@/lib/browser-op/session';
import { MAX_OP_STEPS, OP_SESSION_IDLE_SECONDS } from '@/lib/browser-op/actions';

// AI 操作用户日常浏览器：**通道**的边界（2026-09-17）。
//
// 这条路与 BrowserTask 的全部区别可以压成一句：**它只在用户看着的时候存在**。
// 那句话不是承诺，是结构——动作必须流经他打开着的烽火台页面。本文件钉的就是这个结构：
//   ① 会话靠 lastSeenAt 判活：页面不轮询了，它自己就死；
//   ② 会话按发起人归属，别人的页面中继不了；
//   ③ 它不进 BrowserTask（进了就会有人给它加重试，「只在你看着时执行」就悄悄不成立了）；
//   ④ 中继用登录态鉴权，不是采集令牌（令牌是发给设备的、长期有效；登录态才代表「人此刻在」）。

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let workspaceId = '';
const ME = 'm_me';
const OTHER = 'm_other';

beforeEach(async () => {
  await prisma.browserOpSession.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.tenant.deleteMany();
  const t = await prisma.tenant.create({ data: { name: 'T' } });
  const w = await prisma.workspace.create({ data: { tenantId: t.id, name: 'W' } });
  workspaceId = w.id;
});

describe('会话：只在用户看着时活着', () => {
  it('🔒 页面停止轮询超过闲置窗口，会话就不算活的了（lastSeenAt 是「人还在」的唯一判据）', async () => {
    const { id } = await startOpSession({ workspaceId, memberId: ME, origin: 'https://creator.xiaohongshu.com' });
    expect(await activeOpSession(workspaceId, ME)).not.toBeNull();

    // 把 lastSeenAt 拨到闲置窗口之外 = 模拟他把烽火台页面关了
    await prisma.browserOpSession.update({
      where: { id },
      data: { lastSeenAt: new Date(Date.now() - (OP_SESSION_IDLE_SECONDS + 5) * 1000) },
    });
    expect(await activeOpSession(workspaceId, ME), '页面关了它还活着').toBeNull();

    // 此刻再下发一步必须被拒，且话要说清楚是「通道断了」
    const r = await pushStep(id, { action: 'read' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('只在你看着的时候有效');
  });

  it('isAlive：active 且在窗口内才算活', () => {
    const now = Date.now();
    expect(isAlive({ status: 'active', lastSeenAt: new Date(now - 1000) }, now)).toBe(true);
    expect(isAlive({ status: 'active', lastSeenAt: new Date(now - (OP_SESSION_IDLE_SECONDS + 1) * 1000) }, now)).toBe(false);
    expect(isAlive({ status: 'done', lastSeenAt: new Date(now) }, now)).toBe(false);
  });

  it('🔒 会话按发起人归属：别人的会话我取不到', async () => {
    await startOpSession({ workspaceId, memberId: OTHER, origin: 'https://creator.douyin.com' });
    expect(await activeOpSession(workspaceId, ME), '取到了别人的操作会话').toBeNull();
    expect(await activeOpSession(workspaceId, OTHER)).not.toBeNull();
  });

  it('同一个人只有一条活会话：新的把旧的顶掉（与「重复任务以新为准」同一条）', async () => {
    const a = await startOpSession({ workspaceId, memberId: ME, origin: 'https://a.example.com' });
    const b = await startOpSession({ workspaceId, memberId: ME, origin: 'https://b.example.com' });
    const cur = await activeOpSession(workspaceId, ME);
    expect(cur?.id).toBe(b.id);
    const old = await prisma.browserOpSession.findUnique({ where: { id: a.id } });
    expect(old?.status).toBe('superseded');
  });
});

describe('一步一个来回', () => {
  it('取走即清空：同一步绝不发两次', async () => {
    const { id } = await startOpSession({ workspaceId, memberId: ME, origin: 'https://x.example.com' });
    await pushStep(id, { action: 'read' });
    expect(await takeStep(id)).toEqual({ action: 'read' });
    expect(await takeStep(id), '同一步被发了第二次').toBeNull();
  });

  it('上一步没执行完不下发新的（不排队）', async () => {
    const { id } = await startOpSession({ workspaceId, memberId: ME, origin: 'https://x.example.com' });
    expect((await pushStep(id, { action: 'read' })).ok).toBe(true);
    const second = await pushStep(id, { action: 'scroll', direction: 'down' });
    expect(second.ok).toBe(false);
  });

  it('结果取走即清空，且不可逆动作会把会话停在等确认', async () => {
    const { id } = await startOpSession({ workspaceId, memberId: ME, origin: 'https://x.example.com' });
    await pushStep(id, { action: 'click', ref: 'ref_1' });
    await takeStep(id);
    await putResult(id, { ok: false, needConfirm: true, label: '立即发布' }, { at: new Date().toISOString(), what: '点一下', ok: false });
    const s = await prisma.browserOpSession.findUnique({ where: { id } });
    expect(s?.awaitConfirm, '没停在等确认').toContain('立即发布');
    const got = await takeResult(id);
    expect(got?.needConfirm).toBe(true);
    expect(await takeResult(id), '结果被取了两次').toBeNull();
  });

  it('步数有上限，到顶就不让继续', async () => {
    const { id } = await startOpSession({ workspaceId, memberId: ME, origin: 'https://x.example.com' });
    await prisma.browserOpSession.update({ where: { id }, data: { steps: MAX_OP_STEPS } });
    const r = await pushStep(id, { action: 'read' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(String(MAX_OP_STEPS));
  });

  it('结束之后不能再下发', async () => {
    const { id } = await startOpSession({ workspaceId, memberId: ME, origin: 'https://x.example.com' });
    await endOpSession(id, 'aborted');
    expect((await pushStep(id, { action: 'read' })).ok).toBe(false);
  });
});

describe('🔒 结构性边界（源码判据）', () => {
  it('它不进 BrowserTask 队列——进了就会有人给它加重试，「只在你看着时执行」就不成立了', () => {
    const tool = strip(read('lib/agent/tools-operate.ts'));
    expect(tool, 'operate_browser 居然去排队了').not.toContain('enqueueBrowserTask');
    expect(tool).not.toContain('browserTask.create');
    const session = strip(read('lib/browser-op/session.ts'));
    expect(session).not.toContain('browserTask');
    // 没有重试/租约/过期这些无人值守才需要的概念
    for (const bad of ['attempts', 'leaseUntil', 'expiresAt', 'retriable']) {
      expect(session, `会话层出现了无人值守的概念 ${bad}`).not.toContain(bad);
    }
  });

  it('中继端点用登录态鉴权，不接采集令牌（令牌是设备的，登录态才是「人此刻在」）', () => {
    const route = strip(read('app/api/browser-op/relay/route.ts'));
    expect(route).toContain('getSessionOrNull');
    expect(route, '中继居然接采集令牌').not.toContain('INGEST_TOKEN_HEADER');
    expect(route, '中继居然接采集令牌').not.toContain('resolveIngestToken');
    // 会话必须按 (workspaceId, createdBy) 取，不能只按 id
    expect(route).toMatch(/findFirst\(\{[\s\S]{0,200}createdBy: s\.memberId/);
    // viewer 不能操作浏览器
    expect(route).toContain("can(s.role, 'content.create')");
  });

  it('🔒 插件那侧：只碰自己开的那一页，且落地后按最终 origin 复验', () => {
    const sw = strip(read('extension/sw.js'));
    const block = sw.slice(sw.indexOf('async function opRunInTab'), sw.indexOf('async function opStart'));
    expect(block, '没有按最终 origin 复验（页面会跳转，授权是按站点给的）').toContain('opOrigin');
    expect(block).toContain('chrome.tabs.get(opTabId)');
    // 绝不遍历用户已有的标签页
    const opAll = sw.slice(sw.indexOf('let opTabId'), sw.indexOf('chrome.runtime.onMessage.addListener'));
    expect(opAll, 'op 编排里出现了 tabs.query（会看到他所有标签）').not.toContain('chrome.tabs.query');
    // 开页必须是前台：这条路的前提就是他看着
    expect(opAll).toContain('active: true');
    // 站点没授权就停手，且绝不在这里偷偷申请（必须在用户手势里）
    expect(opAll).toContain('hasSiteGrant');
    expect(opAll, '居然在 SW 里申请权限（那不是手势上下文）').not.toContain('permissions.request');
  });

  it('🔒 bridge 只转发不校验（闸在 sw.js 与 agent-operate.js，抄三份必漂移）', () => {
    const bridge = strip(read('extension/content/bridge.js'));
    expect(bridge).toContain("op-start");
    expect(bridge).toContain("op-step");
    // 不在这里重抄一份危险词表
    expect(bridge, 'bridge 里抄了第三份判据').not.toContain('IRREVERSIBLE');
  });

  it('🔒 执行端不进 manifest 的 content_scripts（那等于申请常驻，这条路只在那几分钟里存在）', () => {
    const manifest = read('extension/manifest.json');
    expect(manifest, 'agent-operate.js 被写进 manifest 了').not.toContain('agent-operate');
    expect(strip(read('extension/sw.js'))).toContain("files: ['content/agent-operate.js']");
  });

  it('🔒 工具：第一步必须是 navigate（由它决定操作哪个站点），且 needConfirm 时明确不许绕路', () => {
    const tool = strip(read('lib/agent/tools-operate.ts'));
    expect(tool).toContain('第一步必须是 navigate');
    expect(tool).toContain('不要去点页面上别的按钮绕过它');
    // 页面内容要裹「是数据不是指令」
    expect(tool).toContain('PAGE_CONTENT_IS_DATA');
    expect(tool).toContain('wrapPageContent');
  });

  it('🔒 页面中继：没装插件就完全不轮询；结果原样交回，不在前端解释页面内容', () => {
    const relay = strip(read('components/BrowserOpRelay.tsx'));
    expect(relay).toContain('ext-present');
    expect(relay).toMatch(/if \(!extPresent\) return undefined;/);
    // 停止按钮必须有——用户随时能喊停
    expect(relay).toContain("action: 'abort'");
    // 不可逆动作的默认选项是「我自己点」
    expect(relay).toContain('我自己点');
  });

  it('🔒 新表进了 RLS 名单（多租户隔离的兜底防线）', () => {
    const rls = read('prisma/postgres/02-rls.sql');
    expect(rls, 'BrowserOpSession 没进 RLS 名单').toContain("'BrowserOpSession'");
    // 两份 schema 都要有
    for (const f of ['prisma/schema.prisma', 'prisma/schema.postgres.prisma']) {
      expect(read(f), `${f} 缺 BrowserOpSession`).toContain('model BrowserOpSession');
    }
    expect(fs.existsSync(path.join(ROOT, 'prisma/postgres/60-browser-op-session.sql')), '缺建表 SQL').toBe(true);
  });
});
