import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { parseJson } from '@/lib/json';
import { Card, Stat } from '@/components/ui';
import { INSPIRATION_CAP } from '@/lib/ingest/inspiration';
import { InspirationBoard, type InspirationView } from './InspirationBoard';

// 「灵感箱」面板 —— 原 /inspiration 页的主体，2026-08-25 并进 /topics 作为一个标签
//（定选题三合一，同 /data 看效果的模式）。自包含：自己取 session 与数据，
// 只在 view=inspiration 时被渲染（见 topics/page.tsx 的早返回）。
export async function InspirationPanel() {
  const s = await getSession();

  // 工作区级收集箱（团队共享），但只展示本账号可见的：本账号专属 + 未指定账号的。
  // 与推荐取数口径（sources/inspiration.ts loadInspirations）保持一致——
  // 页面上看得到的，就是会进推荐的那些。
  const rows = await prisma.inspirationItem.findMany({
    where: { workspaceId: s.workspaceId, OR: [{ accountId: null }, { accountId: s.accountId }] },
    orderBy: { createdAt: 'desc' },
    take: 300,
  });

  const items: InspirationView[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    note: r.note,
    url: r.url,
    platform: r.platform,
    author: r.author,
    source: r.source,
    state: r.state,
    createdAt: r.createdAt.toISOString(),
    scopedToAccount: r.accountId !== null,
    summary: r.summary,
    points: parseJson<string[]>(r.points, []),
    analysis: r.analysis,
    contentChars: r.content?.length ?? 0,
    askedCount: r.askedCount,
    askedWorks: r.askedWorks,
    lastAskedAt: r.lastAskedAt?.toISOString() ?? null,
  }));

  const count = (state: string) => items.filter((i) => i.state === state).length;

  return (
    <>
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="待用" value={count('open')} foot={`参与每日推荐 · 上限 ${INSPIRATION_CAP} 条`} />
        <Stat label="已转选题" value={count('used')} foot="被采纳后自动出队" />
        <Stat label="已归档" value={count('archived')} foot="不再进候选池" />
        <Stat
          label="读者提问"
          value={items.filter((i) => i.source === 'comment' || i.source === 'rival-comment').length}
          foot={`自有 ${items.filter((i) => i.source === 'comment').length} · 同行 ${items.filter((i) => i.source === 'rival-comment').length}`}
        />
      </div>

      <Card
        title="它怎么变成选题"
        sub="收集箱不是收藏夹——存进来的东西会主动参与每天的选题推荐"
        style={{ marginBottom: 16 }}
      >
        <ol className="small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.9 }}>
          <li>
            <b>唤醒</b>：你收藏的灵感如果和今天的热点撞上了，那条热点会带着「你 3 周前收藏过这个」一起推给你——
            当时觉得值得记一笔的东西，现在真的火了。
          </li>
          <li>
            <b>独立成题</b>：没撞上热点的灵感，会自己作为候选进「本周窗口」，不跟热点抢时间。
          </li>
          <li>
            <b>出队</b>：由灵感变成的选题被采纳后，这条灵感自动标为「已转选题」，不会再重复出现。
          </li>
        </ol>
        <p className="small muted" style={{ marginTop: 10, marginBottom: 0 }}>
          备注那一栏最有用：有备注时，系统会优先拿你写的那句话当选题，而不是原标题。
        </p>
      </Card>

      <Card title="收集箱" sub="装上采集助手后可在任意网页一键收藏；也可以在这里手动记">
        <InspirationBoard items={items} />
      </Card>
    </>
  );
}
