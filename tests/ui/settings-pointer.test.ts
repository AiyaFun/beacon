import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { INGEST_TOKEN_INVALID } from '@/lib/ingest/competitor';

// 「去哪儿改这个设置」这句指路的守卫。
//
// 【为什么需要】2026-08-19 把原来一页的设置拆成了三页（接入与密钥 / 运行设置 / 账号与安全）。
// 拆页时改了导航和大部分文案，但散在各处的**指路**没跟着改：数据看板让用户去
// /settings 生成采集令牌、视频拆解的「去设置渠道」按钮指向 /settings、机器人回复
// 「用量与套餐 → /settings」、公众号发布的报错说「设置 · 发布通道」、
// 十四个 ingest 路由的 401 里有一半只说「令牌无效」连去哪儿换都不说。
// 这类错不会报错也不会红，用户点过去看到的是一页**没有他要找的东西**的设置页，
// 于是他以为这个功能不存在。
//
// 三条判据都只认「用户看得见的字符串」，所以扫源码前先剥注释（注释里会为讲坑而引用旧写法）。

const ROOT = path.resolve(__dirname, '../..');
const DIRS = ['app', 'lib', 'components'];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') walk(p, out);
    } else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const FILES = DIRS.flatMap((d) => walk(path.join(ROOT, d))).map((f) => ({
  rel: path.relative(ROOT, f),
  src: stripComments(fs.readFileSync(f, 'utf8')),
}));

describe('设置页指路', () => {
  it('这几条守卫真的扫得到文件（遍历坏了会静默全过）', () => {
    // 下面三条断言的都是「违规清单为空」。walk 一旦扫不到东西（目录改名、后缀过滤写错），
    // 三条会**同时**变成恒真，而且一声不响——这正是本项目记过的第七种假绿。
    expect(FILES.length, '一个 tsx/ts 都没扫到，遍历坏了').toBeGreaterThan(100);
    expect(FILES.some((f) => f.rel.startsWith('app/')), '没扫到 app/ 下的文件').toBe(true);
  });

  it('不许再用「设置 · X」这种前缀称呼某一页', () => {
    // 设置早就不是一页了。这个前缀既不是任何一页的名字，用户在导航里也找不到它。
    //
    // 【为什么排除「运行设置」】它是拆页后的**正式页名**，自带「设置」二字。
    // 「运行设置 · 自动采集与定时开关都在这一页」用的正是这条守卫要求的具体页名，
    // 后面的 · 是分隔符不是前缀滥用——2026-08-19 任务台的悬停提示就误伤在这里。
    // 只放行这一种：拆出来的三页里没有第二个带「设置」的名字（接入与密钥 / 账号与安全），
    // 所以任何**别的**「…设置 ·」照样红。
    const bad = FILES.filter((f) => /(?<!运行)设置\s*·/.test(f.src)).map((f) => f.rel);
    expect(bad, `这些文件里还写着「设置 · …」，改成具体页名（接入与密钥 / 运行设置 / 账号与安全）：${bad.join('、')}`).toEqual([]);
  });

  it('指向 /settings 的链接必须自称「运行设置」', () => {
    // 判据故意定在链接**自己的说法**上，而不是猜它周围在讲什么：
    // /settings 现在只剩自动化/数据源/向量三件事，任何一个不叫「运行设置」的入口
    // 点过去都是一页找不到东西的设置页。四个真实错例（数据看板的采集令牌、
    // 视频拆解的「去设置渠道」、机器人的「用量与套餐」、公众号发布的凭证指引）
    // 全都栽在这一条上。
    const bad: string[] = [];
    const linkRe = /(?:href=\{?["'`]|beaconUrl\(["'`]|redirect\(["'`])\/settings["'`]/g;
    for (const f of FILES) {
      let m: RegExpExecArray | null;
      linkRe.lastIndex = 0;
      while ((m = linkRe.exec(f.src))) {
        const label = f.src.slice(m.index, m.index + 240); // 链接标签就在紧随其后
        if (!label.includes('运行设置')) {
          const line = f.src.slice(0, m.index).split('\n').length;
          bad.push(`${f.rel}:${line}`);
        }
      }
    }
    expect(bad, `这些链接指向 /settings 却没自称「运行设置」，用户点过去会找不到东西：${bad.join('、')}`).toEqual([]);
  });

  it('采集令牌失效这句话只有一份，且说得出去哪儿换', () => {
    // 这是插件里直接弹给用户看的那句。它必须点名页面：用户手上没有别的线索。
    expect(INGEST_TOKEN_INVALID).toContain('接入与密钥');
    expect(INGEST_TOKEN_INVALID).toContain('插件采集令牌');

    const inlined = FILES.filter(
      (f) => f.rel.startsWith('app/api/') && /['"`]采集令牌无效/.test(f.src),
    ).map((f) => f.rel);
    expect(inlined, `这些路由又自己写了一份令牌失效文案，用 INGEST_TOKEN_INVALID：${inlined.join('、')}`).toEqual([]);
  });
});
