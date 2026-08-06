// 本地 PPTX 渲染器（零依赖，不需要任何大模型 Key）。
//
// 为什么有这个文件：此前「导出演示文稿」唯一路径是 Anthropic Agent Skills——挂 pptx skill、
// 在官方容器里跑代码生成文件。那条路把三件事绑死在一起：必须有 Claude 官方 Key、内容必须出境、
// 版式由模型即兴发挥（同一篇稿子两次导出排版可能不同）。
//
// 拆开之后：**模型只负责「说什么」（产出大纲，见 outline.ts，任意模型可用），
// 渲染只负责「排成什么样」（本文件，纯确定性代码，零模型参与）**。
// 好处是模型可替换、内容不出境、版式可控可复现；代价是版式得自己写死，就是下面这些常量。
//
// 部件图（最小可用 pptx 就这些，其中 6 个是**一次写死的骨架**，每次导出只有 slides/slideN.xml 在变）：
//   [Content_Types].xml
//   _rels/.rels                       → ppt/presentation.xml + docProps/custom.xml
//   docProps/custom.xml               ← AIGC 隐式标识（第五条）
//   ppt/presentation.xml (+ .rels)    → slideMaster1 / theme1 / slideN
//   ppt/slideMasters/slideMaster1.xml (+ .rels → slideLayout1 / theme1)
//   ppt/slideLayouts/slideLayout1.xml (+ .rels → slideMaster1)
//   ppt/theme/theme1.xml
//   ppt/slides/slideN.xml (+ .rels → slideLayout1)
//
// 注：skills.ts 里那句「不本地拼 pptx，出错面大」说的是**对已有 zip 做事后偏移修补**那条路；
// 从零 buildZip 没有偏移问题，所以这里可以拼。

import { AIGC_LABEL, hasAigcLabel } from '../compliance/aigc';
import { buildZip, escapeXml } from './zip';
import { AIGC_PROPS_PART, AIGC_PROPS_CONTENT_TYPE, aigcCustomPropsXml } from './aigc-props';
import type { Deck, DeckSlide } from './outline';

// 16:9，EMU（1 英寸 = 914400 EMU）
const SLIDE_W = 12192000;
const SLIDE_H = 6858000;
const MARGIN_X = 838200;
const BODY_W = SLIDE_W - MARGIN_X * 2;

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const REL_NS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';
const REL_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/**
 * 把大纲渲染成 .pptx 字节。
 *
 * AIGC 显式标识（第四条）**由渲染器强制写入每一页的页脚文本框**，不依赖模型「听话」——
 * 这正是本地路径比 Skills 路径可靠的地方：标识是代码写的，verifyAigcLabelInFile 必定能验到。
 * 大纲里若已带标识行（上游 ensureAigcLabel 追加过），这里会剔除，避免一页出现两条。
 */
export function buildPptxLocal(deck: Deck, produceId?: string): Buffer {
  const slides = normalizeDeck(deck);
  const withProps = produceId != null;

  const files: { name: string; data: Buffer }[] = [
    { name: '[Content_Types].xml', data: buf(contentTypesXml(slides.length, withProps)) },
    { name: '_rels/.rels', data: buf(packageRelsXml(withProps)) },
    { name: 'ppt/presentation.xml', data: buf(presentationXml(slides.length)) },
    { name: 'ppt/_rels/presentation.xml.rels', data: buf(presentationRelsXml(slides.length)) },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: buf(SLIDE_MASTER_XML) },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: buf(SLIDE_MASTER_RELS) },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: buf(SLIDE_LAYOUT_XML) },
    { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: buf(SLIDE_LAYOUT_RELS) },
    { name: 'ppt/theme/theme1.xml', data: buf(THEME_XML) },
  ];

  slides.forEach((s, i) => {
    files.push({ name: `ppt/slides/slide${i + 1}.xml`, data: buf(slideXml(s, i === 0)) });
    files.push({ name: `ppt/slides/_rels/slide${i + 1}.xml.rels`, data: buf(SLIDE_RELS) });
  });

  if (withProps) {
    files.push({ name: AIGC_PROPS_PART, data: buf(aigcCustomPropsXml(produceId!)) });
  }
  return buildZip(files);
}

function buf(s: string): Buffer {
  return Buffer.from(s, 'utf8');
}

// 大纲 → 可渲染的页序列：剔重复标识行、去空页、兜底保证至少有一页。
function normalizeDeck(deck: Deck): DeckSlide[] {
  const slides = deck.slides
    .map((s) => ({
      title: clean(s.title),
      // 剔掉「整行就是一句 AIGC 声明」的要点：页脚已经统一写了，留着就是重复
      bullets: s.bullets.map(clean).filter((b) => b.length > 0 && !hasAigcLabel(b)),
    }))
    .filter((s) => s.title.length > 0 || s.bullets.length > 0);
  if (slides.length) return slides;
  return [{ title: clean(deck.title) || '未命名', bullets: [] }];
}

// XML 1.0 不允许的 C0 控制字符（\t\n\r 除外）会让整个包变成「文件已损坏」——正文来自模型输出或
// 用户粘贴，混进 \u0000 / \u001F 并不罕见，在入口一次性剔除。顺带把连续空白压成单空格（一个文本框一行）。
// eslint-disable-next-line no-control-regex
const XML_ILLEGAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

function clean(s: string): string {
  return (s ?? '').replace(XML_ILLEGAL, '').replace(/\s+/g, ' ').trim();
}

// ── 各部件 ──

function contentTypesXml(slideCount: number, withProps: boolean): string {
  const slides = Array.from(
    { length: slideCount },
    (_, i) =>
      `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
  ).join('');
  return (
    XML_HEAD +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
    slides +
    (withProps ? `<Override PartName="/${AIGC_PROPS_PART}" ContentType="${AIGC_PROPS_CONTENT_TYPE}"/>` : '') +
    '</Types>'
  );
}

// 包级关系：除了主文档，还要把 docProps/custom.xml 挂上——只写 Content_Types 而不挂关系，
// PowerPoint/Word 的「属性 → 自定义」里根本看不到这几个隐式标识属性。
function packageRelsXml(withProps: boolean): string {
  return (
    XML_HEAD +
    `<Relationships ${REL_NS}>` +
    `<Relationship Id="rId1" Type="${REL_BASE}/officeDocument" Target="ppt/presentation.xml"/>` +
    (withProps
      ? `<Relationship Id="rId2" Type="${REL_BASE}/custom-properties" Target="${AIGC_PROPS_PART}"/>`
      : '') +
    '</Relationships>'
  );
}

// rId1 = slideMaster，rId2.. = 各页，最后一位 = theme
function presentationXml(slideCount: number): string {
  const ids = Array.from(
    { length: slideCount },
    (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`,
  ).join('');
  return (
    XML_HEAD +
    `<p:presentation ${NS} saveSubsetFonts="1">` +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
    `<p:sldIdLst>${ids}</p:sldIdLst>` +
    `<p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}"/>` +
    '<p:notesSz cx="6858000" cy="9144000"/>' +
    '</p:presentation>'
  );
}

function presentationRelsXml(slideCount: number): string {
  const slides = Array.from(
    { length: slideCount },
    (_, i) => `<Relationship Id="rId${i + 2}" Type="${REL_BASE}/slide" Target="slides/slide${i + 1}.xml"/>`,
  ).join('');
  return (
    XML_HEAD +
    `<Relationships ${REL_NS}>` +
    `<Relationship Id="rId1" Type="${REL_BASE}/slideMaster" Target="slideMasters/slideMaster1.xml"/>` +
    slides +
    `<Relationship Id="rId${slideCount + 2}" Type="${REL_BASE}/theme" Target="theme/theme1.xml"/>` +
    '</Relationships>'
  );
}

// 空的组合形状树：母版/版式/每页的 spTree 都以它开头（id=1 是保留给树根的）
const EMPTY_SP_TREE_HEAD =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
  '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

const SLIDE_MASTER_XML =
  XML_HEAD +
  `<p:sldMaster ${NS}>` +
  '<p:cSld>' +
  '<p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>' +
  `<p:spTree>${EMPTY_SP_TREE_HEAD}</p:spTree>` +
  '</p:cSld>' +
  '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3"' +
  ' accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
  '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
  '</p:sldMaster>';

const SLIDE_MASTER_RELS =
  XML_HEAD +
  `<Relationships ${REL_NS}>` +
  `<Relationship Id="rId1" Type="${REL_BASE}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
  `<Relationship Id="rId2" Type="${REL_BASE}/theme" Target="../theme/theme1.xml"/>` +
  '</Relationships>';

// 只用 blank 版式：所有文本框都由渲染器显式定位，不依赖占位符继承。
// 占位符（ph）虽然更「正统」，但一旦母版/版式与页面的 idx 对不上，PowerPoint 会静默丢内容——
// 显式文本框没有这个失配面。
const SLIDE_LAYOUT_XML =
  XML_HEAD +
  `<p:sldLayout ${NS} type="blank" preserve="1">` +
  '<p:cSld name="空白">' +
  `<p:spTree>${EMPTY_SP_TREE_HEAD}</p:spTree>` +
  '</p:cSld>' +
  '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>' +
  '</p:sldLayout>';

const SLIDE_LAYOUT_RELS =
  XML_HEAD +
  `<Relationships ${REL_NS}>` +
  `<Relationship Id="rId1" Type="${REL_BASE}/slideMaster" Target="../slideMasters/slideMaster1.xml"/>` +
  '</Relationships>';

const SLIDE_RELS =
  XML_HEAD +
  `<Relationships ${REL_NS}>` +
  `<Relationship Id="rId1" Type="${REL_BASE}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
  '</Relationships>';

// 主题：clrScheme(12) + fontScheme + fmtScheme(各 3 条) 是 schema 的硬性下限，少一条 PowerPoint 就报「需要修复」。
// ea 字体留空 = 用系统默认中文字体（写死「思源黑体」这类在别人机器上不存在，反而会掉字）。
const THEME_XML =
  XML_HEAD +
  '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="烽火台">' +
  '<a:themeElements>' +
  '<a:clrScheme name="烽火台">' +
  '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
  '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
  '<a:dk2><a:srgbClr val="1F2933"/></a:dk2>' +
  '<a:lt2><a:srgbClr val="F5F7FA"/></a:lt2>' +
  '<a:accent1><a:srgbClr val="C0392B"/></a:accent1>' +
  '<a:accent2><a:srgbClr val="E67E22"/></a:accent2>' +
  '<a:accent3><a:srgbClr val="2E86C1"/></a:accent3>' +
  '<a:accent4><a:srgbClr val="27AE60"/></a:accent4>' +
  '<a:accent5><a:srgbClr val="8E44AD"/></a:accent5>' +
  '<a:accent6><a:srgbClr val="7F8C8D"/></a:accent6>' +
  '<a:hlink><a:srgbClr val="0563C1"/></a:hlink>' +
  '<a:folHlink><a:srgbClr val="954F72"/></a:folHlink>' +
  '</a:clrScheme>' +
  '<a:fontScheme name="烽火台">' +
  '<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
  '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>' +
  '</a:fontScheme>' +
  '<a:fmtScheme name="烽火台">' +
  '<a:fillStyleLst>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '</a:fillStyleLst>' +
  '<a:lnStyleLst>' +
  '<a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>' +
  '<a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>' +
  '<a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>' +
  '</a:lnStyleLst>' +
  '<a:effectStyleLst>' +
  '<a:effectStyle><a:effectLst/></a:effectStyle>' +
  '<a:effectStyle><a:effectLst/></a:effectStyle>' +
  '<a:effectStyle><a:effectLst/></a:effectStyle>' +
  '</a:effectStyleLst>' +
  '<a:bgFillStyleLst>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '</a:bgFillStyleLst>' +
  '</a:fmtScheme>' +
  '</a:themeElements>' +
  '<a:objectDefaults/><a:extraClrSchemeLst/>' +
  '</a:theme>';

// ── 单页 ──

function slideXml(slide: DeckSlide, isCover: boolean): string {
  const shapes: string[] = [];
  let shapeId = 2; // 1 已被 spTree 根占用

  if (isCover) {
    // 封面：标题居中偏上，要点当副标题
    shapes.push(
      textBox(shapeId++, '标题', MARGIN_X, 2011680, BODY_W, 1600200, [
        para(slide.title, { size: 4000, bold: true, align: 'ctr' }),
      ]),
    );
    if (slide.bullets.length) {
      shapes.push(
        textBox(
          shapeId++,
          '副标题',
          MARGIN_X,
          3703320,
          BODY_W,
          1200150,
          slide.bullets.slice(0, 3).map((b) => para(b, { size: 1800, align: 'ctr', color: '5A6672' })),
        ),
      );
    }
  } else {
    shapes.push(
      textBox(shapeId++, '标题', MARGIN_X, 457200, BODY_W, 1143000, [
        para(slide.title || ' ', { size: 3200, bold: true }),
      ]),
    );
    shapes.push(
      textBox(
        shapeId++,
        '正文',
        MARGIN_X,
        1828800,
        BODY_W,
        3886200,
        slide.bullets.length
          ? slide.bullets.map((b) => para(b, { size: 2000, bullet: true }))
          : [para(' ', { size: 2000 })],
      ),
    );
  }

  // AIGC 显式标识页脚：**每页都写**，且由代码写死。第四条允许「起始、末尾或中间适当位置」，
  // 逐页出现是最保险的一种——用户删页、截图单页传播时标识都还在。
  shapes.push(
    textBox(shapeId++, 'AIGC标识', MARGIN_X, 6126480, BODY_W, 365760, [
      para(AIGC_LABEL, { size: 1200, color: '7F8C8D' }),
    ]),
  );

  return (
    XML_HEAD +
    `<p:sld ${NS}>` +
    `<p:cSld><p:spTree>${EMPTY_SP_TREE_HEAD}${shapes.join('')}</p:spTree></p:cSld>` +
    '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>' +
    '</p:sld>'
  );
}

function textBox(
  id: number,
  name: string,
  x: number,
  y: number,
  cx: number,
  cy: number,
  paras: string[],
): string {
  return (
    '<p:sp>' +
    `<p:nvSpPr><p:cNvPr id="${id}" name="${escapeXml(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>' +
    '<p:txBody><a:bodyPr wrap="square" lIns="91440" tIns="45720" rIns="91440" bIns="45720">' +
    '<a:normAutofit/></a:bodyPr><a:lstStyle/>' +
    paras.join('') +
    '</p:txBody></p:sp>'
  );
}

function para(
  text: string,
  opts: { size: number; bold?: boolean; align?: 'l' | 'ctr'; color?: string; bullet?: boolean },
): string {
  // 子元素顺序是 schema 硬约束：lnSpc → spcBef → buFont → buChar/buNone。
  // 写反了 PowerPoint 打开就弹「需要修复」，而 python-pptx 之类的宽松读者照样能读——
  // 所以别拿「解析器读得出来」当验收标准。
  const pPr =
    `<a:pPr${opts.align === 'ctr' ? ' algn="ctr"' : ''}` +
    (opts.bullet ? ' marL="285750" indent="-285750"' : '') +
    '>' +
    '<a:lnSpc><a:spcPct val="130000"/></a:lnSpc>' +
    '<a:spcBef><a:spcPts val="600"/></a:spcBef>' +
    (opts.bullet ? '<a:buFont typeface="Arial"/><a:buChar char="•"/>' : '<a:buNone/>') +
    '</a:pPr>';
  const rPr =
    `<a:rPr lang="zh-CN" altLang="en-US" sz="${opts.size}"${opts.bold ? ' b="1"' : ''} dirty="0">` +
    (opts.color ? `<a:solidFill><a:srgbClr val="${opts.color}"/></a:solidFill>` : '') +
    '</a:rPr>';
  return `<a:p>${pPr}<a:r>${rPr}<a:t>${escapeXml(text)}</a:t></a:r></a:p>`;
}
