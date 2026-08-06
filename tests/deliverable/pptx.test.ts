import { describe, it, expect } from 'vitest';
import { buildPptxLocal } from '@/lib/deliverable/pptx';
import { outlineFromMarkdown, parseDeckJson, type Deck } from '@/lib/deliverable/outline';
import { readZipEntries } from '@/lib/deliverable/zip';
import { verifyAigcLabelInFile, injectAigcDocProps } from '@/lib/llm/skills';
import { AIGC_LABEL, ensureAigcLabel } from '@/lib/compliance/aigc';

// 本地 pptx 渲染器：把「导出演示文稿」从 Anthropic Agent Skills 上摘下来的那条路。
// 关键断言不是「能生成个 zip」，而是：
//   ① 部件图完整（少一个 PowerPoint 就报「需要修复」，而 python-pptx 之类宽松读者照样能读）；
//   ② AIGC 显式标识由**渲染器**写入，不看模型脸色 —— 这是 Skills 路径唯一真实的合规风险点；
//   ③ 标识不重复、控制字符不入包（这两样都会让文件在 PowerPoint 里出洋相）。

function names(buf: Buffer): string[] {
  return readZipEntries(buf).map((e) => e.name);
}

function slideText(buf: Buffer, index: number): string {
  const part = readZipEntries(buf).find((e) => e.name === `ppt/slides/slide${index}.xml`);
  if (!part) throw new Error(`没有第 ${index} 页`);
  return [...part.data.toString('utf8').matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join('\n');
}

const deck: Deck = {
  title: '三种做图方式对比',
  slides: [
    { title: '三种做图方式对比', bullets: [] },
    { title: '成本', bullets: ['AI 生成最便宜', '外包最贵'] },
    { title: '可控性', bullets: ['模板最稳'] },
  ],
};

describe('buildPptxLocal · 部件图', () => {
  it('最小可用 pptx 的骨架一个不少', () => {
    const n = names(buildPptxLocal(deck, 'tenant-draft-1'));
    for (const required of [
      '[Content_Types].xml',
      '_rels/.rels',
      'ppt/presentation.xml',
      'ppt/_rels/presentation.xml.rels',
      'ppt/slideMasters/slideMaster1.xml',
      'ppt/slideMasters/_rels/slideMaster1.xml.rels',
      'ppt/slideLayouts/slideLayout1.xml',
      'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
      'ppt/theme/theme1.xml',
      'docProps/custom.xml',
    ]) {
      expect(n, `缺部件 ${required}`).toContain(required);
    }
    // 每页都要有自己的 rels（指向版式），漏了这条 PowerPoint 直接判损坏
    expect(n).toContain('ppt/slides/slide1.xml');
    expect(n).toContain('ppt/slides/_rels/slide1.xml.rels');
    expect(n.filter((x) => /^ppt\/slides\/slide\d+\.xml$/.test(x))).toHaveLength(3);
  });

  it('页数与 sldIdLst / Content_Types / 关系表三处对齐', () => {
    const buf = buildPptxLocal(deck, 'p1');
    const entries = readZipEntries(buf);
    const pres = entries.find((e) => e.name === 'ppt/presentation.xml')!.data.toString('utf8');
    const rels = entries.find((e) => e.name === 'ppt/_rels/presentation.xml.rels')!.data.toString('utf8');
    const ct = entries.find((e) => e.name === '[Content_Types].xml')!.data.toString('utf8');
    expect([...pres.matchAll(/<p:sldId /g)]).toHaveLength(3);
    expect([...rels.matchAll(/\/slide"/g)]).toHaveLength(3);
    expect([...ct.matchAll(/presentationml\.slide\+xml/g)]).toHaveLength(3);
    // 每个 r:id 都要在关系表里能查到，否则那一页在 PowerPoint 里直接消失
    for (const m of pres.matchAll(/r:id="(rId\d+)"/g)) {
      expect(rels, `${m[1]} 没有对应关系`).toContain(`Id="${m[1]}"`);
    }
  });

  it('隐式标识既进 Content_Types 也挂包级关系（只写前者，Word/PPT 属性面板里看不到）', () => {
    const entries = readZipEntries(buildPptxLocal(deck, 'tenant-x'));
    const rels = entries.find((e) => e.name === '_rels/.rels')!.data.toString('utf8');
    expect(rels).toContain('custom-properties');
    const props = entries.find((e) => e.name === 'docProps/custom.xml')!.data.toString('utf8');
    expect(props).toContain('AIGC_Label');
    expect(props).toContain('tenant-x');
  });

  it('injectAigcDocProps 对本地产物幂等（构建时已打包，不做事后偏移修补）', () => {
    const buf = buildPptxLocal(deck, 'p1');
    expect(injectAigcDocProps(buf, 'p1')).toBe(buf);
  });
});

describe('buildPptxLocal · AIGC 标识', () => {
  it('标识由渲染器强制写入，且每页都有 —— verifyAigcLabelInFile 必过', () => {
    const buf = buildPptxLocal(deck, 'p1');
    const check = verifyAigcLabelInFile('pptx', buf);
    expect(check.verifiable).toBe(true);
    expect(check.found).toBe(true);
    for (let i = 1; i <= 3; i++) expect(slideText(buf, i)).toContain(AIGC_LABEL);
  });

  it('大纲里已带标识行时不重复（上游 ensureAigcLabel 追加过的那条要被吃掉）', () => {
    const labeled = ensureAigcLabel('讲讲做图方式。');
    const d = outlineFromMarkdown('做图', labeled);
    const buf = buildPptxLocal(d, 'p1');
    const all = readZipEntries(buf)
      .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
      .map((e) => e.data.toString('utf8'))
      .join('');
    // 页脚一页一条，正文里不该再冒出第二条
    const slideCount = names(buf).filter((x) => /^ppt\/slides\/slide\d+\.xml$/.test(x)).length;
    expect([...all.matchAll(new RegExp(AIGC_LABEL, 'g'))]).toHaveLength(slideCount);
  });

  it('控制字符与 XML 元字符不会污染包体', () => {
    const buf = buildPptxLocal(
      { title: 'a\u0000b', slides: [{ title: '<script>&', bullets: ['x\u001fy'] }] },
      'p1',
    );
    const xml = slideText(buf, 1);
    expect(xml).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
    const raw = readZipEntries(buf).find((e) => e.name === 'ppt/slides/slide1.xml')!.data.toString('utf8');
    expect(raw).toContain('&lt;script&gt;&amp;'); // 转义过，没把 XML 打断
    expect(verifyAigcLabelInFile('pptx', buf).found).toBe(true);
  });

  it('空大纲也出一页且带标识（导出永远有产出，不返回坏文件）', () => {
    const buf = buildPptxLocal({ title: '', slides: [] }, 'p1');
    expect(names(buf)).toContain('ppt/slides/slide1.xml');
    expect(verifyAigcLabelInFile('pptx', buf).found).toBe(true);
  });
});

describe('outlineFromMarkdown · 稿子自带结构时不烧 token', () => {
  it('按标题切页，列表与段落都变要点，行内标记剥掉', () => {
    const d = outlineFromMarkdown('对比', [
      '# 三种做图方式对比',
      '',
      '## 成本',
      '- **AI 生成**最便宜',
      '- 外包最贵',
      '',
      '## 可控性',
      '模板最稳，见 [文档](https://x.com)。',
    ].join('\n'));
    // 首页是封面（标题居中），正文页跟在后面
    expect(d.slides[0]).toEqual({ title: '对比', bullets: [] });
    const titles = d.slides.slice(1).map((s) => s.title);
    expect(titles).toEqual(['三种做图方式对比', '成本', '可控性']);
    expect(d.slides[2].bullets).toEqual(['AI 生成最便宜', '外包最贵']);
    expect(d.slides[3].bullets[0]).toBe('模板最稳，见 文档。');
  });

  it('一页要点超上限自动开「（续）」页，不让文字溢出版心', () => {
    const lines = Array.from({ length: 9 }, (_, i) => `- 要点${i + 1}`);
    const d = outlineFromMarkdown('t', ['## 很多要点', ...lines].join('\n'));
    const body = d.slides.slice(1);
    expect(body.map((s) => s.title)).toEqual(['很多要点', '很多要点（续）']);
    expect(body[0].bullets).toHaveLength(6);
    expect(body[1].bullets).toHaveLength(3);
  });

  it('无结构长文切不出页 —— 这正是要请模型规划的信号', () => {
    const d = outlineFromMarkdown('t', '就一段话，没有任何标题。');
    expect(d.slides).toHaveLength(2); // 封面 + 一页，isUsable() 判 false
  });
});

describe('parseDeckJson · 模型返回的大纲', () => {
  it('合法 JSON → 自动补封面页', () => {
    const d = parseDeckJson('{"slides":[{"title":"成本","bullets":["便宜"]},{"title":"可控","bullets":[]}]}', '对比');
    expect(d?.slides.map((s) => s.title)).toEqual(['对比', '成本', '可控']);
  });

  it('带 ``` 围栏也能解（部分端点没有原生 json 模式，只能靠提示词约束）', () => {
    const d = parseDeckJson('```json\n{"slides":[{"title":"a","bullets":["b"]}]}\n```', 't');
    expect(d?.slides).toHaveLength(2);
  });

  it('不是大纲的 JSON / 纯文本 → null，交给调用方降级，不做「尽量抢救」', () => {
    expect(parseDeckJson('{"ok":true}', 't')).toBeNull();
    expect(parseDeckJson('好的，我来帮你做', 't')).toBeNull();
    expect(parseDeckJson('{"slides":[]}', 't')).toBeNull();
  });

  it('要点里混进非字符串不会把整份大纲拖垮', () => {
    const d = parseDeckJson('{"slides":[{"title":"a","bullets":["ok",null,3,{"x":1}]}]}', 't');
    expect(d?.slides[1].bullets).toEqual(['ok']);
  });
});
