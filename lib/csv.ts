// CSV 拼装（零依赖纯函数）。
//
// 【为什么单独一个文件】lib/insight/csv.ts 里那套是给「发布明细/逐日快照」用的，
// 它连着 timeseries / source-priority 一串服务端模块。而客户端组件也要导 CSV
//（竞对高热榜单那个按钮），把整串拖进浏览器包既没必要也容易踩到 server-only。
// 同一个文件里 source-tier.ts 早就是因为这个理由拆出去的，照这个先例办。

/**
 * 单元格转义。
 *
 * ── 两件事，第二件是安全 ──
 * ① RFC4180：含逗号/引号/换行的字段用双引号包裹，内部引号翻倍。
 *
 * ② **公式注入**（2026-08-30 补）。Excel / WPS / Google Sheets 在解析掉 CSV 的引号之后，
 *    仍然会把 `=` `+` `-` `@` 开头的单元格**当公式执行**——加引号防不住这一层，
 *    因为引号是 CSV 语法，公式判定发生在它之后。
 *
 *    这不是理论风险：这两份导出里的标题和账号名**是从竞对平台抓回来的第三方文本**，
 *    抓什么完全由对方决定。一条标题写成 `=HYPERLINK("http://…","查看详情")`，
 *    用户导出榜单、双击打开，看到的就是一个像模像样的链接。
 *    `=IMPORTXML(...)` 之类还能在打开的瞬间把同表其它单元格的内容发出去。
 *
 *    处置：前面补一个半角单引号，Excel 就只当文本。
 *
 * 【代价，说清楚】以 `-` 开头的正当标题（「-2023 年终总结」）会多出一个可见的 `'`。
 * 取舍是：`=` `+` `@` 开头的标题几乎不存在正当用法，`-` 有但很少；
 * 而漏掉 `-` 就等于放过 DDE 那一类载荷。宁可让极少数标题难看一点。
 */
export function escapeCell(v: string | number | null | undefined): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (RISKY_LEAD.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 会被表格软件当成公式开头的字符。
 * 制表符与回车也在内：它们能把内容顶到下一格，绕过对首字符的检查。
 */
const RISKY_LEAD = /^[=+\-@\t\r]/;

/** 表头 + 数据行 → 带 BOM 的 CSV 文本。BOM 是给 Excel 双击直接打开不乱码用的。 */
export function buildCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  return '﻿' + [headers, ...rows].map((row) => row.map(escapeCell).join(',')).join('\r\n');
}
