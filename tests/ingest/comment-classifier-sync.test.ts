import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { isQuestion } from '@/lib/topic/sources/questions';
import { looksPersonal } from '@/lib/ingest/comment-questions';

// 评论分类器的两件事：**判得准**，以及**插件与服务端判得一样**。
//
// ─────────── 一、判得准（两个方向的错误各修过一次，都在 2026-08-07）───────────
//
// ① 诉求词表放进了话题名词（教程 / 更新 / 蹲 / 想看 / 讲一下 / 说一下）。
//    DEMAND 的判定在最前面且无条件返回 true，于是「感谢更新，这期质量真高」
//    「教程收藏了慢慢学」这种评论区里**最多**的纯夸奖，全被判成读者诉求进了选题池。
//    实测十条中十条。这直接破掉 questions.ts 文件头那条铁律：
//    「宁可漏掉一些问题，也不要把陈述句当成问题」。
//
// ② 个人信息正则里「微信号形态」写作 /[A-Za-z][\w-]{5,19}/ —— 微信号确实长这样，
//    但每一个英文单词也长这样。「请问这个 Chrome 插件怎么装」被当成夹带微信号**静默丢弃**。
//    实测六条科技类提问丢五条，而科技/AI 创作者是这个产品的主力用户。
//
// 两个错误方向相反、后果叠加：夸奖进得来，真问题出不去。
//
// ─────────── 二、判得一样 ───────────
//
// 同一套判据有两份实现：extension/content/comments.js（页面侧先筛，只上传筛过的）
// 与 lib/*（服务端再筛一遍）。插件那份**更严**时，服务端根本看不到被吃掉的那些——
// 没有任何日志、没有任何计数，只表现为「读了 200 条评论，一个问题都没有」。
// 所以两份必须逐字一致，靠下面这组用例钉死。

const COMMENTS_JS = readFileSync(resolve(process.cwd(), 'extension/content/comments.js'), 'utf8');

/**
 * 从源码里抠出 `const <name> = [...]` 并求值。
 * 按方括号配平截取，单行/多行、含正则字面量都能取（正则里的 `[...]` 也一并配平，
 * 对这几份词表够用；取不到一律抛错，避免守卫悄悄空跑）。
 */
function literalIn(src: string, name: string, where: string): unknown {
  const start = src.indexOf(`const ${name} = [`);
  if (start < 0) throw new Error(`没能从 ${where} 里取出 ${name}`);
  const open = src.indexOf('[', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']' && --depth === 0) {
      return vm.runInNewContext(`(${src.slice(open, i + 1)})`);
    }
  }
  throw new Error(`${where} 里的 ${name} 方括号没配平`);
}

/** 插件那一侧 */
const literalOf = (name: string) => literalIn(COMMENTS_JS, name, 'comments.js');

/** lib/ 那一侧（源码里取，避免为了测试把内部常量导出去） */
const libLiteralOf = (file: string, name: string) =>
  literalIn(readFileSync(resolve(process.cwd(), file), 'utf8'), name, file);

describe('插件与服务端的评论判据不许漂移', () => {
  it('🔒 诉求词表逐字一致', () => {
    expect(literalOf('DEMAND')).toEqual(libLiteralOf('lib/topic/sources/questions.ts', 'DEMAND'));
  });

  it('🔒 疑问词/句末助词/弱标记也一致', () => {
    expect(literalOf('STRONG')).toEqual(libLiteralOf('lib/topic/sources/questions.ts', 'STRONG'));
    expect(literalOf('TAIL')).toEqual(libLiteralOf('lib/topic/sources/questions.ts', 'TAIL'));
    expect(literalOf('WEAK')).toEqual(libLiteralOf('lib/topic/sources/questions.ts', 'WEAK'));
  });

  it('🔒 个人信息正则一致（插件更严 = 服务端永远看不到被吃掉的那些）', () => {
    const ext = literalOf('PERSONAL_PATTERNS') as RegExp[];
    const lib = libLiteralOf('lib/ingest/comment-questions.ts', 'PERSONAL_PATTERNS') as RegExp[];
    expect(ext.map(String)).toEqual(lib.map(String));
  });
});

describe('诉求判定 · 纯陈述与夸奖一条都不许进', () => {
  // 全部取自「评论区里最常见的那几句」，逐条都是修复前的真实误判
  const praise = [
    '感谢更新，这期质量真高',
    '更新好快啊博主辛苦了',
    '这个教程做得非常清楚，收藏了',
    '看完教程我终于会了，感谢',
    '我说一下我的真实体验吧',
    '他讲一下我就懂了，讲得真好',
    '我蹲了半天终于等到了',
    '想看的内容都齐了，很满意',
    '已经更新到第三期了',
    '教程收藏了慢慢学',
  ];
  for (const line of praise) {
    it(`🔒 不算提问：${line}`, () => expect(isQuestion(line)).toBe(false));
  }
});

describe('诉求判定 · 真诉求一条都不许漏', () => {
  const demands = [
    '求一期系统教程吧',
    '求个入门路线图',
    '能出个详细讲解吗',
    '催更催更，什么时候出下一期',
    '蹲一个实战讲一下的视频',
    '想看你做一期面试相关的',
    '想看看你平时怎么剪的',
    '什么时候更新下一期呀',
    '能不能出一期讲讲这个工具',
    '求更新后续内容',
  ];
  for (const line of demands) {
    it(`算诉求：${line}`, () => expect(isQuestion(line)).toBe(true));
  }
});

describe('个人信息过滤 · 拦住账号，别拦住英文词', () => {
  const legit = [
    '请问这个 Chrome 插件怎么装',
    'ChatGPT 和 Claude 哪个更适合写代码',
    '博主用的是什么 Notion 模板呀',
    'Python 新手想问从哪开始学',
    '这个 PyTorch 版本要求是多少',
    'Figma 里怎么做这种效果',
    '想问下 Photoshop 和 Affinity 哪个好',
  ];
  for (const line of legit) {
    it(`🔒 不当成个人信息：${line}`, () => expect(looksPersonal(line)).toBe(false));
  }

  const personal = [
    '加我微信 abc123456 一起交流',
    '我的微信是 zhangsan2024',
    '微信 lisi_2020 可以交流吗',
    '我的微信是 zhangsanhello',   // 纯字母：靠「微信」提示词兜住
    'vx：wangwu8888 一起学',
    '手机号 13800138000 方便联系',
    '邮箱 me@example.com 谢谢',
  ];
  for (const line of personal) {
    it(`拦住：${line}`, () => expect(looksPersonal(line)).toBe(true));
  }
});
