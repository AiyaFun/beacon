import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { parseJson } from '@/lib/json';
import { PageHead, Card, Stat } from '@/components/ui';
import { LibraryBoard, type LibraryItem } from './LibraryBoard';
import { VideoAnalyzeCard } from './VideoAnalyzeCard';

export const dynamic = 'force-dynamic';

// 内容资讯库：把从各平台读到的资讯正文 + 摘要 + 要点 + 「对本账号的用处」集中在一页。
//
// 【和灵感收集箱的分工】收集箱是「刷到个好东西，先记一笔」——标题 + 链接 + 一句备注，轻。
// 资讯库是「这篇我读过了，要点在这，对我的用处在这」——有正文、有结构化结论，重。
// 两者共用 InspirationItem 一张表（source='clip' 即资讯库条目），因为它们的生命周期是连着的：
// 库里的一条随时可以「转成选题」，那正是收集箱既有的出口。拆成两张表只会让这条路断掉。
//
// ⚠️ 存的是他人作品正文，仅供用户自己分析：页面上必须标出来源与「别直接复用其文字」，
// 且这些正文**绝不进入生成语料池**（护栏见 lib/clip/index.ts 顶部）。

export default async function LibraryPage() {
  const s = await getSession();

  const [rows, arkChannels] = await Promise.all([
    prisma.inspirationItem.findMany({
      where: {
        workspaceId: s.workspaceId,
        source: 'clip',
        OR: [{ accountId: null }, { accountId: s.accountId }],
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
    // 视频拆解只走用户自己的方舟渠道（平台不垫付）——没配就把入口置灰并给出引导，
    // 而不是让他点了之后才看到一句「未配置」。
    prisma.modelProvider.count({ where: { tenantId: s.tenantId, vendor: 'doubao', status: { not: 'failed' } } }),
  ]);

  const items: LibraryItem[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    url: r.url,
    author: r.author,
    platform: r.platform,
    note: r.note,
    summary: r.summary,
    points: parseJson<string[]>(r.points, []),
    analysis: r.analysis,
    // 只下发字数与前 300 字预览：一页 200 条 × 两万字会把首屏拖垮，
    // 而列表要回答的问题只是「这条讲了什么、值不值得点开」。
    excerpt: (r.content ?? '').slice(0, 300),
    chars: r.content?.length ?? 0,
    state: r.state,
    createdAt: r.createdAt.toISOString(),
  }));

  const withSummary = items.filter((i) => i.summary).length;
  const platforms = new Set(items.map((i) => i.platform).filter(Boolean)).size;

  return (
    <>
      <PageHead
        title="内容资讯库"
        desc="各平台读过的资讯，正文存档 + 摘要要点 + 对你账号的用处"
      />

      <div className="grid-3" style={{ marginBottom: 16 }}>
        <Stat label="库内条目" value={items.length} foot="最多保留最近 200 条" />
        <Stat label="已出摘要" value={withSummary} foot="AI 不可用时只存正文，可稍后补" />
        <Stat label="覆盖平台" value={platforms} foot="按来源链接自动识别" />
      </div>

      <VideoAnalyzeCard hasArkChannel={arkChannels > 0} />

      <Card
        title="怎么把内容存进来"
        sub="四条路，按平台挑一条"
        style={{ marginBottom: 16 }}
      >
        <div className="stack small" style={{ gap: 8, lineHeight: 1.7 }}>
          <div>
            <b>① 采集助手（最通用，推荐）</b>：在任意内容页上右键 →「存进烽火台资讯库（含正文摘要）」。
            小红书、抖音、X、B站、YouTube、公众号、头条这些<b>只有这条路走得通</b>——
            它们的正文要么要登录态、要么靠浏览器跑 JS 才渲染得出来，服务器直连拿不到。
          </div>
          <div>
            <b>② 群里发链接</b>：@机器人 发一条链接，服务器能抓的（普通网页、资讯站、技术博客）会直接入库并回摘要；
            抓不到的它会明说原因，并让你改用前两条路。
          </div>
          <div>
            <b>③ 群里粘正文</b>：把正文直接粘进群（300 字以上），一样入库出摘要。链接打不开时最省事。
          </div>
          <div>
            <b>④ 视频/作品拆解</b>：上面那张卡上传视频文件 → <b>画面级</b>拆解（钩子、画面时间线）。
            在作品页上用采集助手右键「一键拆解」→ <b>封面 + 文案 + 平台字幕轨</b>：
            拿不到画面，但<b>口播原文带时间戳全在</b>（YouTube / B站 已接，其它平台看有没有字幕轨）。
            两者能力互补——插件拿不到视频文件（播放地址带鉴权和防盗链，我们不去解），要画面就自己下载后上传。
          </div>
          <div className="muted">
            存的是他人作品正文，只落在你自己的工作区，仅供你分析参考；它<b>不会</b>进入「像我一样写」的语料池，
            也别直接复用原文文字。
          </div>
        </div>
      </Card>

      <LibraryBoard items={items} />
    </>
  );
}
