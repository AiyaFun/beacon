import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { parseJson } from '@/lib/json';
import { LibraryConsole, type LibraryItem } from './LibraryConsole';

export const dynamic = 'force-dynamic';

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
    prisma.modelProvider.count({
      where: { tenantId: s.tenantId, vendor: 'doubao', status: { not: 'failed' } },
    }),
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

  return <LibraryConsole items={items} hasArkChannel={arkChannels > 0} />;
}
