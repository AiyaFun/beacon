import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { looksLikePersonalName, verifyAgainstSkeleton } from '@/lib/ingest/parser-learn';

// 锚点不许是人名（2026-08-29）。
//
// 【为什么这条比看上去重要】脱敏阈值是「连续 4 个以上中文→CJK」，所以两三个字的中文
// 原样保留——这是刻意的（「粉丝」「点赞」都是两个字，降到 2 等于抹掉所有可用锚点）。
// 代价是两三个字的人名也保留，可能被模型选成锚点。
//
// 而 activeRulePack() **没有租户过滤**：解析规则是全局下发到每个用户插件的。
// 一个人名混进规则会被推给所有人——这不是「某租户的数据留在自己库里」，是**跨租户分发**。

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('人名判据', () => {
  it.each(['李雷', '张伟', '王小明', '刘德', '周杰伦', '孙悟'])('%s 认成人名', (n) => {
    expect(looksLikePersonalName(n)).toBe(true);
  });

  it.each(['粉丝', '点赞', '标题', '评论', '播放量', '关注', '转发', '收藏', '阅读', '作者', '发布时间'])(
    '%s 是标签，必须放行', (n) => {
      expect(looksLikePersonalName(n)).toBe(false);
    },
  );

  it('外文不误杀（按空格+大写去猜会杀掉 Sign In / Read More 这类真标签）', () => {
    for (const n of ['Sign In', 'Read More', 'Followers', 'Likes']) {
      expect(looksLikePersonalName(n)).toBe(false);
    }
  });

  it('四字以上不判（那种长度在骨架里已经被脱敏成 CJK 了）', () => {
    expect(looksLikePersonalName('王小明同学')).toBe(false);
  });
});

describe('闸装在咽喉处：两条学习链路都绕不过', () => {
  it('verifyAgainstSkeleton 会把人名锚点滤掉', () => {
    const skeleton = 'div span 粉丝 NUM 李雷 span';
    const r = verifyAgainstSkeleton(skeleton, [], ['粉丝', '李雷']);
    expect(r.anchors).toContain('粉丝');
    expect(r.anchors, '人名不该进规则').not.toContain('李雷');
  });

  it('只剩人名时整条不通过（宁可这个字段空着）', () => {
    const r = verifyAgainstSkeleton('div 李雷 span', [], ['李雷']);
    expect(r.pass).toBe(false);
  });

  it('判据写在 verifyAgainstSkeleton 里，而不是各调用点各写一遍', () => {
    // 写在调用点上，新增一条学习链路时必然会有人忘
    const src = read('lib/ingest/parser-learn.ts');
    const i = src.indexOf('export function verifyAgainstSkeleton(');
    const body = src.slice(i, src.indexOf('export async function proposeSelectors'));
    expect(body).toContain('!looksLikePersonalName(a)');
  });

  it('规则包确实是全局下发的（这正是必须拦的理由）', () => {
    const src = read('lib/ingest/parser-learn.ts');
    const i = src.indexOf('export async function activeRulePack');
    const body = src.slice(i, i + 400);
    // 没有 tenantId 过滤 —— 所以规则里混进个人信息就是跨租户分发
    expect(body).not.toContain('tenantId');
  });
});
