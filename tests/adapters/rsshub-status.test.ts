import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rssHubStatus } from '@/lib/adapters/rsshub';
import { between } from '../helpers/anchor';

// 自建 RSSHub 的状态要看得见（2026-08-31）。
//
// ── 原来的形态 ──
// RssHubAdapter.health() 是个桩：无条件 `ok: true`，只把 URL 回显一遍——
// 容器死了、端口没通，它一律说「好」。而 sourceHealthBoard() 又只对**热榜**适配器
// 调 health()，竞对那半只列名字，所以这个桩连被调用的机会都没有。
//
// 结果是「这个容器到底有没有在干活」在产品里**根本答不了**，
// 而那正是「该配上还是该停掉」这个问题一直悬着的原因。
const ROOT = process.cwd();
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('rssHubStatus：真的探一次，不是回显 URL', () => {
  it('没配地址 → 未配置，且说明这不是故障', async () => {
    vi.stubEnv('BEACON_RSSHUB_BASE_URL', '');
    const r = await rssHubStatus();
    expect(r.configured).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.detail, '要说清这是「不在链上」而不是「坏了」').toContain('不是故障');
  });

  it('🔒 配了地址就真的发请求（不许再回显 URL 了事）', async () => {
    vi.stubEnv('BEACON_RSSHUB_BASE_URL', 'http://rsshub:1200');
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 } as Response);
    vi.stubGlobal('fetch', fetchMock);
    const r = await rssHubStatus();
    expect(fetchMock, '压根没发请求——这就是原来那个桩的行为').toHaveBeenCalled();
    expect(r.ok).toBe(true);
    expect(r.configured).toBe(true);
  });

  it('🔒 连不上要如实说连不上（桩的问题就是死了也说好）', async () => {
    vi.stubEnv('BEACON_RSSHUB_BASE_URL', 'http://rsshub:1200');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const r = await rssHubStatus();
    expect(r.configured).toBe(true);
    expect(r.ok, '容器死了却报 ok').toBe(false);
    expect(r.detail).toContain('连不上');
  });

  it('🔒 404 算活着（RSSHub 对未知路径回 404 是正常的，不该读成故障）', async () => {
    vi.stubEnv('BEACON_RSSHUB_BASE_URL', 'http://rsshub:1200');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 404 } as Response));
    expect((await rssHubStatus()).ok, '判据是「够不够得着」，不是「返回什么」').toBe(true);
  });

  it('🔒 有超时，且探测绝不抛（它挂在设置页渲染上）', async () => {
    const src = readFileSync(join(ROOT, 'lib/adapters/rsshub.ts'), 'utf8');
    // 终点锚取下一个顶层声明，不用 '\n}' —— 那会命中函数签名里内联返回类型的闭合，切早了
    const body = between(src, 'export async function rssHubStatus', 'export function rssHubAdapter');
    expect(body, '没有超时——一个死掉的容器会把整页拖住').toContain('AbortSignal.timeout(');
    expect(body, '没有 try/catch，探测失败会把设置页整页炸掉').toContain('catch');
  });
});

describe('接上了没有', () => {
  it('🔒 sourceHealthBoard 真的把它带出来（写了没接等于没做）', () => {
    const reg = readFileSync(join(ROOT, 'lib/adapters/registry.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(reg).toContain('await rssHubStatus()');
    expect(reg, '算了但没放进返回值').toMatch(/return \{ hot: hotHealth, competitor: competitorHealth, rsshub \}/);
    expect(reg, '探测失败会让整块健康看板炸掉').toContain('.catch(');
  });

  it('🔒 设置页真的渲染了（board 那半此前就是「算了不渲染」栽过一次）', () => {
    const page = readFileSync(join(ROOT, 'app/(app)/settings/page.tsx'), 'utf8');
    expect(page).toContain('board.rsshub');
    // 三态要分开：未配置（不是故障）／在跑／配了但连不上（要人动手）
    for (const t of ['未配置', '在跑', '连不上']) {
      expect(page, `缺少「${t}」这一态`).toContain(t);
    }
    expect(page, '连不上时没告诉用户该怎么办').toContain('BEACON_RSSHUB_BASE_URL');
  });
});
