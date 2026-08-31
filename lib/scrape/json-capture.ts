// 被动捕获页面自己发出的 JSON 响应，并把它压成「路径 → 值」（2026-08-29）。
//
// ── 「被动」这两个字是这条路的全部边界 ──
//
// 我们**只读浏览器本来就已经发出的响应**，绝不自己发请求。这个区别不是措辞：
//   · 被动观察拿到的，是和 DOM 里一模一样的数据，只是在渲染之前。
//     不产生任何额外请求、不给站点增加负载、不重放任何凭据。
//   · 主动调接口是另一件事——那正是公众号后台那条通道，在既有的五条通道分级里
//     被评为**最高危**，且是逐平台预先审过的。任意站点不能走那条。
// 所以本模块**没有任何发起请求的能力**，守卫逐个断言 fetch / request / goto 不出现在这里。
//
// ── 为什么值得做 ──
// DOM 解析对改版是脆的：类名会变、结构会重排。而同一份数据在 XHR 响应里通常是
// 一个稳定的 JSON 结构（`data.items[].title`），改版时它比 DOM 稳一个数量级。
// 这也是唯一能一次解决「列表」和「分页」的路子——列表在 JSON 里天然就是数组。
//
// ── 隐私：原始载荷绝不落库、绝不进模型 ──
// 落库的只有配方 fields 声明过的那几个字段值（和 DOM 那条路完全一致）。
// 交给学习器的只有**路径名 + 值的形状**（走 textShape，数字→NUM、长中文→CJK），
// 与页面骨架同一套口径。原始 JSON 只在这一次抓取的内存里存在。

import { textShape } from '../ingest/parser-learn';

/** 最多捕获几条 JSON 响应。一次页面加载几十个 XHR 很常见，但有用的就那几个。 */
export const MAX_JSON_RESPONSES = 20;
/** 单条响应体的上限。超了直接跳过——大列表页的响应可能是几 MB，读它既慢又没必要。 */
export const MAX_JSON_BODY_CHARS = 512_000;
/** 压平后最多留几个路径。**没有上限的展开会把一个几万条的数组变成几十万个键。** */
export const MAX_JSON_PATHS = 2_000;
/** 单个值的上限，与 DOM 那条路的 pick() 同一个数。 */
export const MAX_JSON_VALUE_CHARS = 200;
/** 展开深度上限。深层嵌套的路径长到没法当锚点用，也没人会去写那样的规则。 */
const MAX_DEPTH = 8;

/**
 * 把一份 JSON 压成 `路径 → 值`。
 *
 * 路径形如 `data.items.0.title`。**数组下标用数字**而不是 `[*]`：
 * 这样每一条路径都能在验证时逐字对上真实捕获，与 verifyAgainstSkeleton
 * 「模型说了不算，得对得上我们真看见的东西」是同一条纪律。
 * 通配是取值那一步的事（见 lookupJsonPath），不是记录这一步的事。
 */
export function flattenJson(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (node: unknown, path: string, depth: number): void => {
    if (Object.keys(out).length >= MAX_JSON_PATHS || depth > MAX_DEPTH) return;
    if (node === null || node === undefined) return;
    if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
      if (path) out[path] = String(node).slice(0, MAX_JSON_VALUE_CHARS);
      return;
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) {
        if (Object.keys(out).length >= MAX_JSON_PATHS) return;
        walk(node[i], path ? `${path}.${i}` : String(i), depth + 1);
      }
      return;
    }
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (Object.keys(out).length >= MAX_JSON_PATHS) return;
        // key 里带点会让路径产生歧义（`a.b` 到底是一层还是两层），这类键直接跳过
        if (k.includes('.')) continue;
        walk(v, path ? `${path}.${k}` : k, depth + 1);
      }
    }
  };
  walk(raw, '', 0);
  return out;
}

/**
 * 按路径取值，支持一个 `*` 通配下标（`data.items.*.title`）。
 *
 * 【为什么通配只用在取值、不用在记录】记录时写成 `*` 就没法逐字验证了——
 * 模型可以编一条谁也对不上的路径而看起来合法。记录用真实下标、
 * 验证按真实下标、取值时才允许通配，三步各自可证。
 */
export function lookupJsonPath(flat: Record<string, string>, path: string): string | null {
  if (!path) return null;
  if (flat[path] !== undefined) return flat[path];
  if (!path.includes('*')) return null;
  // `a.*.b` → 找第一个匹配的真实路径。用锚定的正则，避免 `a.*.b` 意外匹配 `xa.1.bc`
  const re = new RegExp(`^${path.split('*').map(escapeRe).join('[^.]+')}$`);
  for (const k of Object.keys(flat)) if (re.test(k)) return flat[k];
  return null;
}

/**
 * 按路径取**一列**值（通配下标逐个展开），用于列表字段。
 * 顺序按下标数值排，不按 Object.keys 的插入序——`10` 排在 `9` 后面才是人的直觉。
 */
export function lookupJsonColumn(flat: Record<string, string>, path: string): string[] {
  if (!path.includes('*')) {
    const one = flat[path];
    return one === undefined ? [] : [one];
  }
  const re = new RegExp(`^${path.split('*').map(escapeRe).join('([^.]+)')}$`);
  const hits: { idx: number; val: string }[] = [];
  for (const [k, v] of Object.entries(flat)) {
    const m = re.exec(k);
    if (!m) continue;
    const n = Number(m[1]);
    hits.push({ idx: Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER, val: v });
  }
  hits.sort((a, b) => a.idx - b.idx);
  return hits.map((h) => h.val);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 交给学习器的那份摘要：**只有路径名和值的形状**，没有真实值。
 *
 * 与页面骨架同一套脱敏口径（textShape：数字→NUM、长中文→CJK、短标签保留）。
 * 模型要判断的是「哪条路径像是标题、哪条像是点赞数」，它需要路径名和那个位置的形状，
 * 不需要知道那条内容是谁发的。
 */
export function jsonSkeleton(flat: Record<string, string>, max = 300): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(flat)) {
    if (lines.length >= max) break;
    lines.push(`${k} = ${textShape(v)}`);
  }
  return lines.join('\n');
}

/**
 * 把多份捕获合成一份。同名路径**先到的赢**——先到的通常是首屏那次请求，
 * 后面那些多半是翻页/轮询的增量，拿它覆盖首屏会让「第一条」变成「最后一条」。
 */
export function mergeCaptures(all: readonly Record<string, string>[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const one of all) {
    for (const [k, v] of Object.entries(one)) {
      if (Object.keys(out).length >= MAX_JSON_PATHS) return out;
      if (out[k] === undefined) out[k] = v;
    }
  }
  return out;
}
