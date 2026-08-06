import { describe, it, expect } from 'vitest';
import { buildCards, numberCards, wrapText, textWidth, CARD_W, CARD_H, CARD_THEME_LIST, type Card } from '@/lib/deliverable/card';
import { outlineFromMarkdown } from '@/lib/deliverable/outline';
import { injectPngAigcMetadata, readPngAigcMetadata } from '@/lib/deliverable/png-meta';
import { crc32 } from '@/lib/deliverable/crc32';
import { AIGC_LABEL, ensureAigcLabel, aigcMetadataJson } from '@/lib/compliance/aigc';

// 图文卡：服务端只算排版（这份测的就是它），落成 PNG 在浏览器。
// 所以这里能测的、也必须测的，是「换行/分页/标识」这些纯函数——canvas 那几十行只负责描图。

function texts(card: Card): string[] {
  return card.ops.filter((o) => o.kind === 'text').map((o) => (o as { text: string }).text);
}

const MD = [
  '## 成本',
  '- AI 生成最便宜，一张不到一毛，适合批量铺量',
  '- 外包最贵，单张 200 起',
  '## 可控性',
  '- 模板最稳，出图前就知道长什么样',
].join('\n');

describe('buildCards · 版面', () => {
  it('封面 + 每个小节一张，尺寸是小红书 3:4', () => {
    const cards = buildCards(outlineFromMarkdown('三种做图方式对比', MD));
    expect(cards).toHaveLength(3);
    expect(cards[0].w).toBe(CARD_W);
    expect(cards[0].h).toBe(CARD_H);
    expect(texts(cards[0])[0]).toContain('三种');
    expect(texts(cards[1]).join('')).toContain('成本');
    expect(texts(cards[2]).join('')).toContain('模板最稳');
  });

  it('每张卡都带 AIGC 显式标识 —— 由排版代码写死，客户端没有能删掉它的路径', () => {
    const cards = buildCards(outlineFromMarkdown('t', MD));
    for (const c of cards) expect(texts(c)).toContain(AIGC_LABEL);
  });

  it('正文里已有的标识行不会变成一个要点（页脚已经有了）', () => {
    const cards = buildCards(outlineFromMarkdown('t', ensureAigcLabel(MD)));
    for (const c of cards) {
      expect(texts(c).filter((t) => t === AIGC_LABEL)).toHaveLength(1);
    }
  });

  it('账号名作为署名出现在封面（留空则不出现）', () => {
    const withBrand = buildCards(outlineFromMarkdown('t', MD), { brand: '老王聊设计' });
    expect(texts(withBrand[0])).toContain('@老王聊设计');
    expect(texts(buildCards(outlineFromMarkdown('t', MD))[0]).some((t) => t.startsWith('@'))).toBe(false);
  });

  it('内容超过一屏自动翻页，且没有任何一行压到页脚区', () => {
    const many = ['## 很多要点', ...Array.from({ length: 24 }, (_, i) => `- 第${i + 1}条要点，写得长一些好把版面撑开看效果`)];
    const cards = buildCards(outlineFromMarkdown('t', many.join('\n')));
    expect(cards.length).toBeGreaterThan(2); // 封面 + 至少两页正文
    for (const c of cards) {
      for (const op of c.ops) {
        if (op.kind === 'text' && op.text !== AIGC_LABEL) {
          expect(op.y, `「${op.text}」压到页脚了`).toBeLessThan(CARD_H - 190);
        }
      }
    }
  });

  it('长标题自动降字号，不会溢出画布右边', () => {
    const long = '为什么我把做了三年的老客户全部砍掉只留下五个人的一个决定';
    const cover = buildCards({ title: long, slides: [{ title: long, bullets: [] }] })[0];
    for (const op of cover.ops) {
      if (op.kind === 'text' && op.text !== AIGC_LABEL) {
        expect(op.x + textWidth(op.text, op.size)).toBeLessThanOrEqual(CARD_W - 88 + 1);
      }
    }
  });

  it('numberCards 给每张补页码，单张时不补（一张图标个 1/1 很傻）', () => {
    const cards = numberCards(buildCards(outlineFromMarkdown('t', MD)));
    expect(texts(cards[0])).toContain('1 / 3');
    expect(texts(cards[2])).toContain('3 / 3');
    const single = numberCards([{ w: 1, h: 1, bg: '#fff', ops: [] }]);
    expect(single[0].ops).toHaveLength(0);
  });
});

describe('模板', () => {
  it('四套都在，且换模板不改版面骨架（只改颜色与封面构图）', () => {
    const counts = CARD_THEME_LIST.map(
      (t) => buildCards(outlineFromMarkdown('t', MD), { theme: t.key }).length,
    );
    expect(CARD_THEME_LIST.map((t) => t.key)).toEqual(['plain', 'magazine', 'night', 'note']);
    expect(new Set(counts).size, '不同模板排出的张数不一样，说明版面骨架被风格带跑了').toBe(1);
  });

  it('每套模板的每张卡都带 AIGC 标识，且标识颜色在该底色上不是同色隐身', () => {
    for (const t of CARD_THEME_LIST) {
      for (const c of buildCards(outlineFromMarkdown('t', MD), { theme: t.key })) {
        const label = c.ops.find((o) => o.kind === 'text' && o.text === AIGC_LABEL);
        expect(label, `${t.name} 缺标识`).toBeTruthy();
        expect((label as { color: string }).color.toLowerCase()).not.toBe(c.bg.toLowerCase());
      }
    }
  });

  it('杂志红：封面整块主色 + 反白标题；正文页回到白底（保证可读）', () => {
    const cards = buildCards(outlineFromMarkdown('标题', MD), { theme: 'magazine' });
    expect(cards[0].bg).toBe('#D7263D');
    const coverTitle = cards[0].ops.find((o) => o.kind === 'text' && o.bold);
    expect((coverTitle as { color: string }).color).toBe('#FFFFFF');
    expect(cards[1].bg).toBe('#FFFFFF');
  });

  it('深色夜间：整套都是深底浅字（正文页也要深，不然翻页闪瞎）', () => {
    for (const c of buildCards(outlineFromMarkdown('t', MD), { theme: 'night' })) {
      expect(c.bg).toBe('#14181D');
    }
  });

  it('未知模板名回落到默认，不抛也不出空白卡', () => {
    const cards = buildCards(outlineFromMarkdown('t', MD), { theme: 'nope' as never });
    expect(cards[0].bg).toBe('#FFFFFF');
    expect(cards.length).toBeGreaterThan(1);
  });
});

describe('wrapText · 中英混排', () => {
  it('按宽度折行，中文逐字断', () => {
    const lines = wrapText('中文测试文本重复内容', 40, 200); // 200/40 = 5 字一行
    expect(lines).toEqual(['中文测试文', '本重复内容']);
  });

  it('英文单词不拦腰折断', () => {
    const lines = wrapText('use canvas render', 40, 260);
    expect(lines.every((l) => !/[a-z]$/.test(l) || ['use canvas', 'render'].includes(l))).toBe(true);
    expect(lines.join(' ')).toContain('canvas');
  });

  it('行首不出现收尾标点（简版禁则）', () => {
    const lines = wrapText('这是一句话，后面还有', 40, 200);
    expect(lines.some((l) => l.startsWith('，'))).toBe(false);
  });

  it('保留手动换行', () => {
    expect(wrapText('第一行\n第二行', 40, 1000)).toEqual(['第一行', '第二行']);
  });
});

describe('PNG 隐式标识（第五条）', () => {
  // 最小合法 PNG：签名 + IHDR + IEND。够验分块插入位置与 CRC 了。
  function tinyPng(): Uint8Array {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const ihdrData = new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
    const chunk = (type: string, data: Uint8Array) => {
      const t = new TextEncoder().encode(type);
      const out = new Uint8Array(12 + data.length);
      new DataView(out.buffer).setUint32(0, data.length);
      out.set(t, 4);
      out.set(data, 8);
      const crcIn = new Uint8Array(4 + data.length);
      crcIn.set(t, 0);
      crcIn.set(data, 4);
      new DataView(out.buffer).setUint32(8 + data.length, crc32(crcIn));
      return out;
    };
    const ihdr = chunk('IHDR', ihdrData);
    const iend = chunk('IEND', new Uint8Array(0));
    const out = new Uint8Array(sig.length + ihdr.length + iend.length);
    out.set(sig, 0);
    out.set(ihdr, sig.length);
    out.set(iend, sig.length + ihdr.length);
    return out;
  }

  it('写进去读得出来，中文不乱码（用 iTXt 而不是只能存 Latin-1 的 tEXt）', () => {
    const meta = aigcMetadataJson('t1-draft1');
    const png = injectPngAigcMetadata(tinyPng(), meta);
    expect(readPngAigcMetadata(png)).toBe(meta);
    expect(meta).toContain('烽火台');
  });

  it('插在 IHDR 之后，且不动原有分块', () => {
    const src = tinyPng();
    const png = injectPngAigcMetadata(src, '{"a":1}');
    expect(png.length).toBeGreaterThan(src.length);
    expect(new TextDecoder().decode(png.subarray(12, 16))).toBe('IHDR');
    expect(new TextDecoder().decode(png.subarray(37, 41))).toBe('iTXt');
    // IEND 仍在最后
    expect(new TextDecoder().decode(png.subarray(png.length - 8, png.length - 4))).toBe('IEND');
  });

  it('每个分块的 CRC 都对（算错了看图软件直接判文件损坏）', () => {
    const png = injectPngAigcMetadata(tinyPng(), '{"a":1}');
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    let p = 8;
    let checked = 0;
    while (p + 12 <= png.length) {
      const len = view.getUint32(p);
      const stored = view.getUint32(p + 8 + len);
      expect(crc32(png.subarray(p + 4, p + 8 + len))).toBe(stored);
      checked++;
      p += 12 + len;
    }
    expect(checked).toBe(3); // IHDR + iTXt + IEND
  });

  it('不是 PNG 就原样返回（元数据失败不该把导出带崩）', () => {
    const junk = new Uint8Array([1, 2, 3]);
    expect(injectPngAigcMetadata(junk, '{}')).toBe(junk);
    expect(readPngAigcMetadata(junk)).toBeNull();
  });
});
