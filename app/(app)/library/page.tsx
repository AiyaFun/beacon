import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { parseJson } from '@/lib/json';
import { Fold } from '@/components/ui';
import { Icon } from '@/components/icons';
import { LibraryBoard, type LibraryItem } from './LibraryBoard';
import { VideoAnalyzeCard } from './VideoAnalyzeCard';
import { IntelTabs } from '@/components/IntelTabs';
import { HubHeader } from '@/components/HubHeader';

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
  const summaryPct = items.length > 0 ? Math.round((withSummary / items.length) * 100) : 0;
  const platforms = new Set(items.map((i) => i.platform).filter(Boolean)).size;

  return (
    <>
      <HubHeader
        title="看情报"
        hint="跨平台阅读存档 · 全文结构化摘要 · 核心要点提炼 · 账号定制洞察"
        tabs={<IntelTabs active="library" inline />}
      />

      {/* 核心指标与概览 - 紧凑型单行横栏 */}
      <div
        style={{
          marginBottom: 16,
          padding: '12px 24px',
          borderRadius: 10,
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-around',
          flexWrap: 'wrap',
          gap: 16,
        }}
      >
        <div className="row" style={{ gap: 10, alignItems: 'center' }}>
          <div
            style={{
              width: 34,
              height: 34,
              borderRadius: 8,
              background: 'rgba(232, 85, 45, 0.12)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 16,
            }}
          >
            📚
          </div>
          <div>
            <div className="small muted" style={{ fontSize: '0.75rem', lineHeight: 1.2 }}>库内总条目</div>
            <div style={{ fontWeight: 700, fontSize: '1.05rem', lineHeight: 1.3, color: 'var(--text)' }}>
              {items.length} <span className="small muted" style={{ fontWeight: 400, fontSize: '0.75rem' }}>/ 200 条</span>
            </div>
          </div>
        </div>

        <div style={{ width: 1, height: 24, background: 'var(--border)' }} className="hide-mobile" />

        <div className="row" style={{ gap: 10, alignItems: 'center' }}>
          <div
            style={{
              width: 34,
              height: 34,
              borderRadius: 8,
              background: 'rgba(16, 185, 129, 0.12)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 16,
            }}
          >
            ✨
          </div>
          <div>
            <div className="small muted" style={{ fontSize: '0.75rem', lineHeight: 1.2 }}>AI 智能摘要</div>
            <div style={{ fontWeight: 700, fontSize: '1.05rem', lineHeight: 1.3, display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text)' }}>
              <span>{withSummary} 条</span>
              <span className="badge badge-green" style={{ padding: '1px 6px', fontSize: '0.7rem' }}>
                {summaryPct}%
              </span>
            </div>
          </div>
        </div>

        <div style={{ width: 1, height: 24, background: 'var(--border)' }} className="hide-mobile" />

        <div className="row" style={{ gap: 10, alignItems: 'center' }}>
          <div
            style={{
              width: 34,
              height: 34,
              borderRadius: 8,
              background: 'rgba(37, 99, 235, 0.12)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 16,
            }}
          >
            🌐
          </div>
          <div>
            <div className="small muted" style={{ fontSize: '0.75rem', lineHeight: 1.2 }}>已覆盖平台</div>
            <div style={{ fontWeight: 700, fontSize: '1.05rem', lineHeight: 1.3, color: 'var(--text)' }}>
              {platforms} <span className="small muted" style={{ fontWeight: 400, fontSize: '0.75rem' }}>个平台</span>
            </div>
          </div>
        </div>
      </div>

      {/* 视频拆解引擎入口 */}
      <VideoAnalyzeCard hasArkChannel={arkChannels > 0} />

      {/* 存入指引折叠指南 */}
      <Fold
        title="💡 怎么把内容存进资讯库？"
        sub="支持 4 种多端采集方式，自动提炼摘要与要点"
        note={<span className="badge badge-blue" style={{ fontSize: '0.75rem' }}>展开查看指引</span>}
        defaultOpen={false}
      >
        <div className="stack small" style={{ gap: 12, lineHeight: 1.7, padding: '4px 0' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
            <div style={{ padding: 12, borderRadius: 8, background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
              <div style={{ fontWeight: 600, color: 'var(--fg)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="badge badge-primary">1</span> 采集助手（最通用推荐）
              </div>
              <div className="muted">
                在网页任意内容页右键 → <b>「存进烽火台资讯库」</b>。<br />
                小红书、抖音、X、B站、YouTube、公众号、头条等需要 JS 渲染的页面均适用。
              </div>
            </div>

            <div style={{ padding: 12, borderRadius: 8, background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
              <div style={{ fontWeight: 600, color: 'var(--fg)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="badge badge-primary">2</span> 社群消息发链接
              </div>
              <div className="muted">
                在对接群内 <b>@机器人 发一条链接</b>，服务器能直连抓取的普通网页/资讯站/技术博客会自动入库并生成摘要。
              </div>
            </div>

            <div style={{ padding: 12, borderRadius: 8, background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
              <div style={{ fontWeight: 600, color: 'var(--fg)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="badge badge-primary">3</span> 社群直接粘贴正文
              </div>
              <div className="muted">
                在对接群内将 300 字以上正文直接粘贴，机器人也会自动识别入库并提取结构化摘要。链接防爬时最省心。
              </div>
            </div>

            <div style={{ padding: 12, borderRadius: 8, background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
              <div style={{ fontWeight: 600, color: 'var(--fg)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="badge badge-primary">4</span> 视频与作品拆解
              </div>
              <div className="muted">
                上方卡片上传本地视频进行<b>画面级</b>拆解；或在作品页右键「一键拆解」获取<b>封面 + 文案 + 字幕轨时间戳</b>。
              </div>
            </div>
          </div>

          <div
            className="small muted row"
            style={{
              gap: 6,
              alignItems: 'center',
              padding: '8px 12px',
              borderRadius: 6,
              background: 'var(--surface-1)',
              border: '1px border-dashed var(--border)',
            }}
          >
            <Icon.info size={14} style={{ flexShrink: 0 }} />
            <span>
              存入内容仅在你的工作区内作为分析参考，<b>绝不进入</b>系统仿写语料池。请勿直接复制使用第三方版权文本。
            </span>
          </div>
        </div>
      </Fold>

      <div style={{ height: 16 }} />

      {/* 资讯库看板 */}
      <LibraryBoard items={items} />
    </>
  );
}

