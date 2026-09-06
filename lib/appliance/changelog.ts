// CHANGELOG.md 的解析——整机版更新清单里那段「这一版改了什么」的**唯一来源**。
//
// 【为什么要有这一层】appliance.manifest.json 的 notes 此前只有一句自动生成的
// 「结构变更脚本共 N 份」。客户点「检查更新」看到的是一个版本号加一句 SQL 计数，
// 不知道这一版到底改了什么、要不要现在更就更。更新说明写在提交信息里对客户是不可见的。
//
// 【为什么是 CHANGELOG.md 而不是别的地方】
//   · 它要跟代码一起进 git、一起发 GitHub（publish-github.sh 不剥它）——开源用户也看得到；
//   · docs/ 整目录不进整机版更新包（APPLIANCE_EXCLUDE），放那里客户机器上就没有；
//   · 提交信息不能改、不能回填，而更新说明常常要在发版前再润一遍。
//
// 【格式约定】二级标题一个版本：`## 1.3.18 (2026-09-02)`（日期可省），
// 下面的 `- ` 列表项就是发给客户的说明，一条一句、不带 markdown 标记（客户端按纯文本 li 渲染）。
// 列表项之间的段落、三级标题都忽略——那是给人读的展开，不进清单。

export type ChangelogSections = Map<string, string[]>;

const HEADING = /^##\s+v?(\d+\.\d+\.\d+)\b/;
const HEADING_DATED = /^##\s+v?(\d+\.\d+\.\d+)\b\s*(?:\((\d{4}-\d{2}-\d{2})\))?/;
const BULLET = /^\s*[-*]\s+(.+?)\s*$/;

export type ChangelogVersion = { version: string; date: string | null; items: string[] };

/**
 * 给网页「最近更新」用的形状：按出现顺序（新在前）带日期，条目**保留** `**加粗**`
 * 之类的行内标记，由页面自己渲染成 <b>。整机版清单那条路仍走 parseChangelog（纯文本）。
 */
export function listChangelog(md: string, limit = 5): ChangelogVersion[] {
  const out: ChangelogVersion[] = [];
  let cur: ChangelogVersion | null = null;
  for (const raw of md.split('\n')) {
    const h = HEADING_DATED.exec(raw);
    if (h) {
      if (out.length >= limit) break;
      cur = { version: h[1], date: h[2] ?? null, items: [] };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    if (/^###/.test(raw)) continue;
    const b = BULLET.exec(raw);
    if (b) cur.items.push(b[1]);
  }
  return out;
}

export function parseChangelog(md: string): ChangelogSections {
  const out: ChangelogSections = new Map();
  let cur: string[] | null = null;
  for (const raw of md.split('\n')) {
    const h = HEADING.exec(raw);
    if (h) {
      cur = [];
      out.set(h[1], cur);
      continue;
    }
    if (!cur) continue;
    // 三级标题结束不了版本段，但也不当条目
    if (/^###/.test(raw)) continue;
    const b = BULLET.exec(raw);
    if (b) cur.push(stripInlineMarkdown(b[1]));
  }
  return out;
}

/** 该版本发给客户的说明。没有这一版的段落 → null（调用方决定是拦下还是退回空数组）。 */
export function notesForVersion(md: string, version: string): string[] | null {
  const items = parseChangelog(md).get(version);
  return items ? items.filter((s) => s.length > 0) : null;
}

/** 客户端是纯文本 li，把 **加粗**、`代码`、[链接](url) 剥成纯文字。 */
export function stripInlineMarkdown(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim();
}

/**
 * 把一条更新说明按 `**加粗**` 切成片段，给网页渲染成 <b>/<span>。
 * 放在这里而不是组件里：组件文件里出现字面的两个星号会被 tests/ui/literal-markdown 判成
 * 「星号会原样显示给用户」——这里是解析它，不是显示它。
 */
export function splitBold(text: string): { bold: boolean; text: string }[] {
  const BOLD = /\*\*([^*]+)\*\*/g;
  const out: { bold: boolean; text: string }[] = [];
  let last = 0;
  for (const m of text.matchAll(BOLD)) {
    if (m.index! > last) out.push({ bold: false, text: text.slice(last, m.index) });
    out.push({ bold: true, text: m[1] });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ bold: false, text: text.slice(last) });
  return out;
}
