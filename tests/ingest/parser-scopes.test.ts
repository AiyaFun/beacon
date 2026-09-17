import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from '@/lib/db';
import { INGEST_TOKEN_HEADER } from '@/lib/ingest/competitor';
import {
  PARSER_SCOPES, PARSER_FIELDS, FIELD_HINTS, SCOPE_LABEL, scopeLabel, isElementTarget, isParserScope,
} from '@/lib/ingest/parser-scopes';
import { incidentFingerprint, recordParserIncident, proposeSelectors } from '@/lib/ingest/parser-learn';
import { POST } from '@/app/api/ingest/parser/route';

// 解析自学习扩到三块从没自校准过的地方（2026-09-15）：发布填表 / 评论读取 / 后台表格行。
//
// 【钉死的四件事】
// ① 上报入口认 publish / comments 两个新范围，不认识的范围照旧 400；
// ② 指纹带 scope：同平台同字段名、不同范围是两件事，不许合并成一条；
// ③ 诊断提示词对命名空间字段带上「要找什么元素」那一句，且说清目标是元素不是数字——
//    否则模型会给一条指向某个 NUM 位的选择器，类名真在骨架里、验证照过、填表填不进去；
// ④ 插件端引用的字段字面量与 parser-scopes.ts 同步（插件是纯 JS，import 不到常量）。

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
/** 剥掉注释再看：字面量只在注释里出现不算「引用」——那是假绿。 */
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// 剧本模型：记下每次诊断收到的消息，按 reply 回。vi.mock 会被提升，状态必须 vi.hoisted。
const llm = vi.hoisted(() => ({
  calls: [] as { role: string; content: string }[][],
  reply: '{"selectors":[],"anchors":[]}',
}));
vi.mock('@/lib/llm/gateway', async (orig) => {
  const real = await orig<typeof import('@/lib/llm/gateway')>();
  return {
    ...real,
    llmComplete: async (_tenant: unknown, _fn: unknown, messages: { role: string; content: string }[]) => {
      llm.calls.push(messages);
      return { text: llm.reply, provider: 'scripted', model: 'scripted', mocked: false };
    },
  };
});

const TOKEN = 'bcn_scopes_test_token';
let workspaceId: string;

beforeEach(async () => {
  llm.calls.length = 0;
  llm.reply = '{"selectors":[],"anchors":[]}';
  await prisma.parserRule.deleteMany();
  await prisma.parserIncident.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.tenant.deleteMany();
  const tenant = await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'W', ingestToken: TOKEN } });
  workspaceId = ws.id;
});

function post(body: Record<string, unknown>) {
  return POST(new Request('http://localhost/api/ingest/parser', {
    method: 'POST',
    headers: { 'content-type': 'application/json', [INGEST_TOKEN_HEADER]: TOKEN },
    body: JSON.stringify(body),
  }));
}

describe('常量本身：范围、字段、文案、提示三边对齐', () => {
  it('四个范围，且每个都有中英文案（运维台不再各写一份三元）', () => {
    expect([...PARSER_SCOPES]).toEqual(['rival', 'self', 'publish', 'comments']);
    for (const s of PARSER_SCOPES) {
      expect(SCOPE_LABEL[s].zh, `${s} 缺中文文案`).toBeTruthy();
      expect(SCOPE_LABEL[s].en, `${s} 缺英文文案`).toBeTruthy();
    }
    expect(scopeLabel('publish', 'zh')).toBe(SCOPE_LABEL.publish.zh);
    expect(scopeLabel('publish', 'en')).toBe(SCOPE_LABEL.publish.en);
    // 库里存的是 string：不认识的原样回显，不许偷偷显示成「竞对」
    expect(scopeLabel('whatever', 'zh')).toBe('whatever');
    expect(isParserScope('comments')).toBe(true);
    expect(isParserScope('button')).toBe(false);
  });

  it('字段字面量就是插件端上报用的那几个字符串（改一个字就是另一个键）', () => {
    expect(PARSER_FIELDS.publishTitle).toBe('publish.title');
    expect(PARSER_FIELDS.publishBody).toBe('publish.body');
    expect(PARSER_FIELDS.commentsContainer).toBe('comments.container');
    expect(PARSER_FIELDS.commentsItem).toBe('comments.item');
    expect(PARSER_FIELDS.backendRows).toBe('backend.rows');
  });

  it('每个命名空间字段都有一句提示，且都装得进上报入口的 40 字符上限', () => {
    for (const f of Object.values(PARSER_FIELDS)) {
      expect(FIELD_HINTS[f], `${f} 没有 FIELD_HINTS`).toBeTruthy();
      expect(f.length).toBeLessThanOrEqual(40);
      expect(f, '命名空间字段必须带前缀，否则会和旧字段（followers/title）同键').toMatch(/^(publish|comments|backend)\./);
    }
  });

  it('🔒 发布按钮永远不是可学习字段（学歪一条会点错按钮，没有「回滚就好」）', () => {
    for (const f of Object.values(PARSER_FIELDS)) expect(f).not.toMatch(/button|submit/i);
    expect(read('lib/ingest/parser-scopes.ts')).toContain('发布按钮不进规则包');
  });

  it('元素目标的判据：publish / comments 全是元素，self 里只有 backend.rows 是', () => {
    expect(isElementTarget('publish', PARSER_FIELDS.publishTitle)).toBe(true);
    expect(isElementTarget('comments', PARSER_FIELDS.commentsItem)).toBe(true);
    expect(isElementTarget('self', PARSER_FIELDS.backendRows)).toBe(true);
    expect(isElementTarget('self', 'followers')).toBe(false);
    expect(isElementTarget('rival', 'followers')).toBe(false);
  });

  it('parser-scopes.ts 是纯常量文件（client 组件 ParserPanel 直接引它，带上服务端 import 就炸）', () => {
    expect(code('lib/ingest/parser-scopes.ts')).not.toMatch(/^\s*import\s/m);
  });
});

describe('① 上报入口认新范围', () => {
  it('publish / comments 两个范围 200 入库，scope 原样落库', async () => {
    const a = await post({ platform: 'douyin', scope: 'publish', field: PARSER_FIELDS.publishTitle });
    expect(a.status).toBe(200);
    const aj = await a.json();
    expect(aj.ok).toBe(true);
    expect(aj.first).toBe(true);

    const b = await post({ platform: 'bilibili', scope: 'comments', field: PARSER_FIELDS.commentsItem });
    expect(b.status).toBe(200);

    const rows = await prisma.parserIncident.findMany({ orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => [r.scope, r.field])).toEqual([
      ['publish', 'publish.title'],
      ['comments', 'comments.item'],
    ]);
  });

  it('self + backend.rows（后台表格行走既有的 self 范围）也收', async () => {
    const r = await post({ platform: 'shipinhao', scope: 'self', field: PARSER_FIELDS.backendRows });
    expect(r.status).toBe(200);
    expect((await prisma.parserIncident.findFirst())?.field).toBe('backend.rows');
  });

  it('不认识的范围 400，一条都不入库', async () => {
    const r = await post({ platform: 'douyin', scope: 'button', field: 'publish.submit' });
    expect(r.status).toBe(400);
    expect(await prisma.parserIncident.count()).toBe(0);
  });

  it('route 的 zod 用的是 PARSER_SCOPES 常量，不是另抄一份字面量（两份会走散）', () => {
    const route = code('app/api/ingest/parser/route.ts');
    expect(route).toMatch(/scope: z\.enum\(PARSER_SCOPES\)/);
    expect(route).not.toMatch(/z\.enum\(\['rival'/);
  });
});

describe('② 指纹带范围', () => {
  it('同平台同字段名、不同范围 → 两个指纹', () => {
    expect(incidentFingerprint('douyin', 'publish', 'publish.title'))
      .not.toBe(incidentFingerprint('douyin', 'self', 'publish.title'));
    expect(incidentFingerprint('douyin', 'publish', 'publish.title')).toBe('douyin:publish:publish.title');
  });

  it('入库不合并：两条各自 created=true，samples 各 1', async () => {
    const a = await recordParserIncident({ workspaceId, platform: 'douyin', scope: 'publish', field: PARSER_FIELDS.publishTitle });
    const b = await recordParserIncident({ workspaceId, platform: 'douyin', scope: 'self', field: PARSER_FIELDS.publishTitle });
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(a.id).not.toBe(b.id);
    expect(await prisma.parserIncident.count()).toBe(2);
    // 同范围再报一次才合并
    const c = await recordParserIncident({ workspaceId, platform: 'douyin', scope: 'publish', field: PARSER_FIELDS.publishTitle });
    expect(c.created).toBe(false);
    expect(c.id).toBe(a.id);
  });
});

describe('③ 诊断提示词：命名空间字段带元素提示', () => {
  const FORM_SKELETON = {
    tag: 'form', cls: ['publish-form'],
    children: [
      { tag: 'input', cls: ['title-input'], attrs: ['data-placeholder'] },
      { tag: 'div', cls: ['editor-body'], attrs: ['contenteditable'] },
    ],
  };

  function lastPrompt() {
    const msgs = llm.calls.at(-1)!;
    return {
      system: msgs.find((m) => m.role === 'system')!.content,
      user: msgs.find((m) => m.role === 'user')!.content,
    };
  }

  it('publish.title：用户消息里有 FIELD_HINTS 那句，系统消息说清「元素不是数字」且允许 anchors 为空', async () => {
    const inc = await recordParserIncident({
      workspaceId, platform: 'douyin', scope: 'publish', field: PARSER_FIELDS.publishTitle, skeleton: FORM_SKELETON,
    });
    llm.reply = JSON.stringify({ selectors: ['.publish-form .title-input'], anchors: [], note: '标题框' });
    const r = await proposeSelectors(inc.id, null);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(llm.calls).toHaveLength(1);

    const { system, user } = lastPrompt();
    expect(user).toContain(`字段说明：${FIELD_HINTS[PARSER_FIELDS.publishTitle]}`);
    expect(user).toContain('目标字段：publish.title');
    expect(system).toContain('不是某个数字');
    expect(system).toContain('anchors 通常用不上');
    // 旧措辞（找数字、锚点是紧挨数字的标签）不该出现在元素目标的提示里
    expect(system).not.toContain('紧挨着目标数字');

    // 规则照常产出：锚点为空不拦（元素目标下 anchors 允许为空），选择器仍过了骨架验证
    const rule = await prisma.parserRule.findFirst({ where: { field: 'publish.title' } });
    expect(rule?.selectors).toBe(JSON.stringify(['.publish-form .title-input']));
    expect(rule?.anchors).toBe('[]');
  });

  it('self + backend.rows 同样按元素目标措辞（self 范围里只有它是元素）', async () => {
    const inc = await recordParserIncident({
      workspaceId, platform: 'shipinhao', scope: 'self', field: PARSER_FIELDS.backendRows,
      skeleton: { tag: 'table', cls: ['data-table'], children: [{ tag: 'tr', cls: ['data-row'] }] },
    });
    llm.reply = JSON.stringify({ selectors: ['.data-table .data-row'], anchors: [] });
    expect((await proposeSelectors(inc.id, null)).ok).toBe(true);
    const { system, user } = lastPrompt();
    expect(user).toContain(`字段说明：${FIELD_HINTS[PARSER_FIELDS.backendRows]}`);
    expect(system).toContain('不是某个数字');
  });

  it('对照：rival + followers 走原来的数字措辞，没有「字段说明」', async () => {
    const inc = await recordParserIncident({
      workspaceId, platform: 'douyin', scope: 'rival', field: 'followers',
      skeleton: { tag: 'div', cls: ['user-info'], children: [{ tag: 'span', cls: ['count-item'], text: '粉丝 328.3万' }] },
    });
    llm.reply = JSON.stringify({ selectors: ['.user-info .count-item'], anchors: ['粉丝'] });
    expect((await proposeSelectors(inc.id, null)).ok).toBe(true);
    const { system, user } = lastPrompt();
    expect(user).not.toContain('字段说明：');
    expect(system).toContain('紧挨着目标数字');
    expect(system).not.toContain('不是某个数字');
  });

  it('🔒 骨架验证对元素目标不放松：编造的选择器照样丢', async () => {
    const inc = await recordParserIncident({
      workspaceId, platform: 'douyin', scope: 'publish', field: PARSER_FIELDS.publishBody, skeleton: FORM_SKELETON,
    });
    llm.reply = JSON.stringify({ selectors: ['.made-up-editor'], anchors: [] });
    const r = await proposeSelectors(inc.id, null);
    expect(r.ok).toBe(false);
    expect(await prisma.parserRule.count()).toBe(0);
  });
});

describe('④ 插件端与服务端常量同步', () => {
  // 哪个内容脚本负责上报哪些字段。插件是纯 JS，import 不到 PARSER_FIELDS，
  // 所以只能靠这条守卫：常量从 parser-scopes.ts 读，去源码里（剥掉注释后）找字面量。
  const OWNERS: [string, string[]][] = [
    ['extension/content/publish-fill.js', [PARSER_FIELDS.publishTitle, PARSER_FIELDS.publishBody]],
    ['extension/content/comments.js', [PARSER_FIELDS.commentsContainer, PARSER_FIELDS.commentsItem]],
    ['extension/content/self-backend.js', [PARSER_FIELDS.backendRows]],
  ];

  for (const [file, fields] of OWNERS) {
    it(`${file} 引用了 ${fields.join(' / ')}`, () => {
      const src = code(file);
      for (const f of fields) {
        // 断言布尔而不是 toContain：失败时打印一句话，而不是把 78KB 源码整个 diff 出来
        expect(src.includes(f), `${file} 里没有字段字面量「${f}」——插件端上报的字段名与 parser-scopes.ts 脱节`).toBe(true);
      }
    });
  }

  it('运维台两处文案都从 scopeLabel 取，不再各写 scope === \'self\' 三元', () => {
    for (const p of ['app/(ops)/ops/parser/ParserPanel.tsx', 'app/(ops)/ops/health/page.tsx']) {
      const src = code(p);
      expect(src, `${p} 还留着手写三元`).not.toMatch(/scope === 'self'/);
      expect(src, `${p} 没接 scopeLabel`).toMatch(/scopeLabel\(/);
    }
  });
});
