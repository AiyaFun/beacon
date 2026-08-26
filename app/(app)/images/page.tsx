import Link from 'next/link';
import { getSession } from '@/lib/session';
import { can } from '@/lib/rbac';
import { PageHead, Card, Stat, Fold } from '@/components/ui';
import { imageConfigured, imageSource } from '@/lib/llm/image';
import { getImageQuotaStatus } from '@/lib/quota';
import { listLibrary, listGenerated } from '@/lib/media/store';
import { COVER_SPEC_OPTIONS } from '@/lib/cover/specs';
import { COVER_STYLES } from '@/lib/cover/styles';
import { COVER_RETENTION_DAYS, COVER_MAX_PER_WORKSPACE } from '@/lib/cover/rules';
import { ImageStudio } from './ImageStudio';
import { MakeTabs } from '@/components/MakeTabs';
import { HubHeader } from '@/components/HubHeader';

export const dynamic = 'force-dynamic';

// AI 出图工位：手头没有稿子、就是想要几张图的时候来这一页。
//
// 【与创作工坊里那两处的分工，页面上要写清楚】
//   · 「标题与封面」——给某一篇出封面，**要把标题写在图上**；
//   · 「正文配图」——按某一篇的正文自动拆画面；
//   · 这一页——自己写画面、不绑草稿、一律不上字。
// 三处共用同一条出图链路（llmImage → 配额/预算/红线/AIGC 打标/落库回收），
// 所以「今日还能出几张」「保留期」这些口径在三处必然一致。
export default async function ImagesPage() {
  const s = await getSession();

  const [configured, source, library, gallery] = await Promise.all([
    imageConfigured(s.tenantId),
    imageSource(s.tenantId),
    listLibrary(s.workspaceId, s.accountId),
    listGenerated(s.workspaceId, { take: 24 }),
  ]);
  const quota = configured && source ? await getImageQuotaStatus(s.tenantId, source) : null;

  const pinned = gallery.filter((g) => g.pinned).length;

  return (
    <>
      <HubHeader
        title="做内容"
        hint="不绑草稿的出图工位 · 自己写画面、批量出图、一律不上字"
        tabs={<MakeTabs active="images" inline />}
        action={<Link href="/studio?tab=title" className="btn btn-sm">要上字的封面 →</Link>}
      />

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat
          label="生图渠道"
          value={configured ? (source === 'byok' ? '自己的 Key' : '平台') : '未配置'}
          foot={configured ? '火山方舟即梦' : '去接入与密钥配一个'}
          href={configured ? undefined : '/settings/keys'}
        />
        <Stat label="今日剩余" value={quota ? `${quota.remaining}/${quota.cap}` : '—'} foot="出图张数按天算" />
        <Stat label="库里的图" value={gallery.length} foot={`每工作区最多留 ${COVER_MAX_PER_WORKSPACE} 张`} />
        <Stat label="已钉住" value={pinned} foot="钉住的不会被保留期清掉" />
      </div>

      <ImageStudio
        styles={COVER_STYLES.map((st) => ({ key: st.key, label: st.name, hint: st.hint }))}
        specs={COVER_SPEC_OPTIONS}
        library={library.map((a) => ({ id: a.id, url: a.url, kind: a.kind, label: a.label }))}
        gallery={gallery.map((g) => ({
          id: g.id,
          url: g.url,
          kind: g.kind,
          label: g.label,
          pinned: g.pinned,
          draftId: g.draftId,
          scene: typeof g.meta.scene === 'string' ? g.meta.scene : '',
          createdAt: g.createdAt.toISOString(),
        }))}
        quota={{
          configured,
          remaining: quota?.remaining ?? 0,
          cap: quota?.cap ?? 0,
          source,
        }}
        retentionDays={COVER_RETENTION_DAYS}
        canWrite={can(s.role, 'content.create')}
      />

      <Fold title="这一页出的图是什么" sub="三处出图的分工，别在这儿找上字的封面" note={<span className="small muted">看一次就够</span>}>
        <ul className="small muted" style={{ margin: 0, paddingLeft: 20, lineHeight: 1.9 }}>
          <li>
            <b>这一页</b>：自己写画面 → 出图。不绑草稿，图属于工作区素材，删草稿不会带走它们。
          </li>
          <li>
            <b>创作工坊 · 标题与封面</b>：给某一篇稿子出封面，会把标题写在图上（中文上字是生图模型最不稳的部分，
            那条链路带着重出与预览）。
          </li>
          <li>
            <b>创作工坊 · 正文配图</b>：按某一篇的正文自动拆成一组画面，风格保持一致。
          </li>
          <li>
            三处都会写入 AI 生成标识（隐式元数据 + 即梦的显式水印），并共用同一份配额与保留期。
          </li>
        </ul>
      </Fold>
    </>
  );
}
