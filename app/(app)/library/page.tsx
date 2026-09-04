import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { parseJson } from '@/lib/json';
import { Fold } from '@/components/ui';
import { Icon } from '@/components/icons';
import { LibraryBoard, type LibraryItem } from './LibraryBoard';
import { VideoAnalyzeCard } from './VideoAnalyzeCard';
import { IntelTabs } from '@/components/IntelTabs';
import { HubHeader } from '@/components/HubHeader';
import { getServerLang } from '@/lib/i18n/server';
import { getDictionary } from '@/lib/i18n/dict';

export const dynamic = 'force-dynamic';

export default async function LibraryPage() {
  const s = await getSession();
  const lang = await getServerLang();
  const dict = getDictionary(lang);

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
        title={dict.tabs.intelTitle}
        hint={lang === 'en' ? 'Cross-platform content library · Full structured summaries · Key takeaways · Tailored insights' : '跨平台阅读存档 · 全文结构化摘要 · 核心要点提炼 · 账号定制洞察'}
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
            <div className="small muted" style={{ fontSize: '0.75rem', lineHeight: 1.2 }}>{lang === 'en' ? 'Total Saved' : '库内总条目'}</div>
            <div style={{ fontWeight: 700, fontSize: '1.05rem', lineHeight: 1.3, color: 'var(--text)' }}>
              {items.length} <span className="small muted" style={{ fontWeight: 400, fontSize: '0.75rem' }}>{lang === 'en' ? '/ 200 items' : '/ 200 条'}</span>
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
            <div className="small muted" style={{ fontSize: '0.75rem', lineHeight: 1.2 }}>{lang === 'en' ? 'AI Summaries' : 'AI 智能摘要'}</div>
            <div style={{ fontWeight: 700, fontSize: '1.05rem', lineHeight: 1.3, display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text)' }}>
              <span>{withSummary} {lang === 'en' ? 'items' : '条'}</span>
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
            <div className="small muted" style={{ fontSize: '0.75rem', lineHeight: 1.2 }}>{lang === 'en' ? 'Platforms' : '已覆盖平台'}</div>
            <div style={{ fontWeight: 700, fontSize: '1.05rem', lineHeight: 1.3, color: 'var(--text)' }}>
              {platforms} <span className="small muted" style={{ fontWeight: 400, fontSize: '0.75rem' }}>{lang === 'en' ? 'platforms' : '个平台'}</span>
            </div>
          </div>
        </div>
      </div>

      {/* 视频拆解引擎入口 */}
      <VideoAnalyzeCard hasArkChannel={arkChannels > 0} />

      {/* 存入指引折叠指南 */}
      <Fold
        title={lang === 'en' ? '💡 How to save content to your library?' : '💡 怎么把内容存进资讯库？'}
        sub={lang === 'en' ? 'Supports 4 capture methods · Automatic summary & takeaways' : '支持 4 种多端采集方式，自动提炼摘要与要点'}
        note={<span className="badge badge-blue" style={{ fontSize: '0.75rem' }}>{lang === 'en' ? 'View Guide' : '展开查看指引'}</span>}
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

