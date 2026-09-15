import Link from 'next/link';
import { getSession } from '@/lib/session';
import { can } from '@/lib/rbac';
import { Fold } from '@/components/ui';
import { imageConfigured, imageSource } from '@/lib/llm/image';
import { getImageQuotaStatus } from '@/lib/quota';
import { listLibrary, listGenerated } from '@/lib/media/store';
import { COVER_SPEC_OPTIONS } from '@/lib/cover/specs';
import { COVER_STYLES } from '@/lib/cover/styles';
import { COVER_RETENTION_DAYS } from '@/lib/cover/rules';
import { ImageStudio } from './ImageStudio';
import { MakeTabs } from '@/components/MakeTabs';
import { HubHeader } from '@/components/HubHeader';
import { getServerLang } from '@/lib/i18n/server';
import { getDictionary } from '@/lib/i18n/dict';

export const dynamic = 'force-dynamic';

export default async function ImagesPage() {
  const s = await getSession();
  const lang = await getServerLang();
  const dict = getDictionary(lang);

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
        title={dict.tabs.makeTitle}
        tabs={<MakeTabs active="images" inline />}
        action={
          <Link href="/materials" className="btn">
            {lang === 'en' ? 'Asset Library' : '查看素材库'}
          </Link>
        }
      />

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

      <Fold
        title={lang === 'en' ? 'What images are generated here' : '这一页出的图是什么'}
        sub={lang === 'en' ? 'Division of 3 image generators — covers with overlaid text are elsewhere' : '三处出图的分工，别在这儿找上字的封面'}
        note={<span className="small muted">{lang === 'en' ? 'Reference' : '看一次就够'}</span>}
      >
        <ul className="small muted" style={{ margin: 0, paddingLeft: 20, lineHeight: 1.9 }}>
          <li>
            <b>{lang === 'en' ? 'This Page' : '这一页'}</b>：
            {lang === 'en'
              ? 'Write your own scene prompt → Generate images. Unlinked to drafts, images belong to workspace assets (deleting drafts won’t delete them).'
              : '自己写画面 → 出图。不绑草稿，图属于工作区素材，删草稿不会带走它们。'}
          </li>
          <li>
            <b>{lang === 'en' ? 'Studio · Title & Cover' : '创作工坊 · 标题与封面'}</b>：
            {lang === 'en'
              ? 'Generate covers for a specific draft, overlaying titles onto images (rendering text is the least predictable part of image models; that pipeline includes regenerate & preview).'
              : '给某一篇稿子出封面，会把标题写在图上（中文上字是生图模型最不稳的部分，那条链路带着重出与预览）。'}
          </li>
          <li>
            <b>{lang === 'en' ? 'Studio · Body Illustrations' : '创作工坊 · 正文配图'}</b>：
            {lang === 'en'
              ? 'Automatically breaks down a draft into a coherent set of scene images with consistent style.'
              : '按某一篇的正文自动拆成一组画面，风格保持一致。'}
          </li>
          <li>
            {lang === 'en'
              ? 'All 3 places embed AI generation marks (implicit metadata + Jimeng visible watermark), sharing the same daily quota and retention window.'
              : '三处都会写入 AI 生成标识（隐式元数据 + 即梦的显式水印），并共用同一份配额与保留期。'}
          </li>
        </ul>
      </Fold>
    </>
  );
}
