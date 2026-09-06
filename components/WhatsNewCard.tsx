import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Card } from '@/components/ui';
import { listChangelog, splitBold, type ChangelogVersion } from '@/lib/appliance/changelog';
import { APP_VERSION } from '@/lib/market/version';

// 「最近更新」卡（2026-09-06）：住在「运行设置」页，不占首页。
//
// 【唯一来源是 CHANGELOG.md】整机版「检查更新」卡里那段说明也是从它来的
// （lib/appliance/changelog.ts）。此前首页手抄了一份四个版本的要点——
// 抄一次就是两份真相，下次发版必漏一处。这里直接读文件，发版只改 CHANGELOG。
//
// 【读不到文件不算错】Docker runner 里要 COPY 进来（Dockerfile 已加）；万一没有，
// 整张卡不渲染，不给用户看一个空壳或报错。

async function loadChangelog(limit: number): Promise<ChangelogVersion[]> {
  try {
    const md = await readFile(path.join(process.cwd(), 'CHANGELOG.md'), 'utf8');
    return listChangelog(md, limit);
  } catch {
    return [];
  }
}

/** 加粗片段 → <b>，其余原样。切分在 lib/appliance/changelog.ts 的 splitBold 里 */
function Inline({ text }: { text: string }) {
  return (
    <>
      {splitBold(text).map((p, i) => (p.bold ? <b key={i}>{p.text}</b> : <span key={i}>{p.text}</span>))}
    </>
  );
}

export async function WhatsNewCard({ lang, limit = 5 }: { lang: string; limit?: number }) {
  const isEn = lang === 'en';
  const versions = await loadChangelog(limit);
  if (versions.length === 0) return null;

  return (
    <Card
      title={isEn ? '🆕 What\'s New' : '🆕 最近更新'}
      sub={isEn ? `Current version v${APP_VERSION} · from CHANGELOG.md, latest ${versions.length} releases` : `当前版本 v${APP_VERSION} · 取自 CHANGELOG.md，最近 ${versions.length} 个版本`}
      style={{ marginBottom: 16 }}
    >
      <div className="stack" style={{ gap: 14 }}>
        {versions.map((v) => (
          <div key={v.version}>
            <div className="row" style={{ gap: 8, alignItems: 'baseline', marginBottom: 4 }}>
              <b>v{v.version}</b>
              {v.version === APP_VERSION && <span className="badge badge-brand">{isEn ? 'current' : '当前'}</span>}
              {v.date && <span className="small muted">{v.date}</span>}
            </div>
            <ul className="small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
              {v.items.map((it, i) => (
                <li key={i}><Inline text={it} /></li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <p className="small muted" style={{ margin: '12px 0 0' }}>
        {isEn
          ? 'Full history in CHANGELOG.md of the repository.'
          : '完整历史在仓库的 CHANGELOG.md；更新说明只写这一处。'}
      </p>
    </Card>
  );
}
