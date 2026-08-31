// 高热榜单导出的行构造（纯函数，2026-08-30 从 CompetitorTopPosts.tsx 抽出来）。
//
// ── 为什么要抽 ──
// 原来它是 CompetitorTopPosts() 里的一个闭包（那个函数一共 1121 行）。
// 闭包里的东西**测不了**——而 CSV 拼装恰恰是转义、空值、口径最容易出错的地方，
// 这份导出还要发给别人看。抽成纯函数之后才谈得上覆盖。
//
// ── 顺带修掉的两件事 ──
// ① 原来这里**自己手搓了一套转义**（`"${title.replace(/"/g,'""')}"`），
//    而 lib/csv.ts 里已经有一套 RFC4180 的了。两套实现意味着修一处漏一处。
// ② 更要紧的：两套都没防**公式注入**。标题和账号名是从竞对平台抓回来的第三方文本，
//    `=HYPERLINK("http://…","查看详情")` 这样的标题导出后在 Excel 里就是一个可点的链接。
//    现在统一走 lib/csv.ts 的 escapeCell，那里补上了处置。
import { platformName } from '@/lib/constants';
import { fmtDate } from '@/lib/format';
import { buildCsv } from '@/lib/csv';

export const TOP_POSTS_CSV_HEADERS = [
  '排名', '平台', '作品标题', '创作者', '播放量', '点赞量', '评论量', '收藏量', '转发量', '互动量', '互动率', '发布时间',
];

/** 导出用到的字段。只声明这几个，别把整个展示对象拖进来。 */
export type TopPostCsvRow = {
  platform: string;
  cleanTitle: string;
  competitor: { name: string };
  views: number;
  likes: number;
  comments: number;
  collects: number;
  shares: number;
  interaction: number;
  rate: number | null;
  publishedAt: Date | string | null;
};

/**
 * 一行的取值。
 *
 * 【为什么拿不到就导空格而不是 0】导成 0 的表格发给别人，对方无从分辨
 * 「这条真没人看」和「这个平台根本不给播放量」——那正是本项目「缺席不许当成 0」
 * 那条口径要防的事（见 lib/insight/platform-metrics.ts）。
 */
export function topPostCsvRow(p: TopPostCsvRow, idx: number): (string | number)[] {
  return [
    idx + 1,
    platformName(p.platform),
    p.cleanTitle,
    p.competitor.name,
    p.views > 0 ? p.views : '',
    p.likes,
    p.comments,
    p.collects,
    p.shares,
    p.interaction < 0 ? '' : p.interaction,
    p.rate === null ? '' : `${(p.rate * 100).toFixed(2)}%`,
    p.publishedAt ? fmtDate(p.publishedAt) : '未记录',
  ];
}

export function topPostsCsv(posts: readonly TopPostCsvRow[]): string {
  return buildCsv(TOP_POSTS_CSV_HEADERS, posts.map((p, i) => topPostCsvRow(p, i)));
}
