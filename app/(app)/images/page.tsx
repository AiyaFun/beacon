import Link from 'next/link';
import { getSession } from '@/lib/session';
import { can } from '@/lib/rbac';
import { Stat, Fold } from '@/components/ui';
import { imageConfigured, imageSource } from '@/lib/llm/image';
import { getImageQuotaStatus } from '@/lib/quota';
import { listLibrary, listGenerated } from '@/lib/media/store';
import { COVER_SPEC_OPTIONS } from '@/lib/cover/specs';
import { COVER_STYLES } from '@/lib/cover/styles';
import { COVER_RETENTION_DAYS, COVER_MAX_PER_WORKSPACE } from '@/lib/cover/rules';
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
        hint={lang === 'en' ? 'Standalone Image Studio · Custom prompts, batch generation, text-free imagery' : '不绑草稿的出图工位 · 自己写画面、批量出图、一律不上字'}
        tabs={<MakeTabs active="images" inline />}
        action={<Link href="/studio?tab=title" className="btn btn-sm">{lang === 'en' ? 'Text Cover Studio →' : '要上字的封面 →'}</Link>}
      />

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat
          label={lang === 'en' ? 'Image Channel' : '生图渠道'}
          value={configured ? (source === 'byok' ? (lang === 'en' ? 'Custom Key' : '自己的 Key') : (lang === 'en' ? 'Platform' : '平台')) : (lang === 'en' ? 'Unconfigured' : '未配置')}
          foot={configured ? (lang === 'en' ? 'Volcengine Ark Jimeng' : '火山方舟即梦') : (lang === 'en' ? 'Configure in Settings' : '去接入与密钥配一个')}
          href={configured ? undefined : '/settings/keys'}
        />
        <Stat
          label={lang === 'en' ? 'Remaining Today' : '今日剩余'}
          value={quota ? `${quota.remaining}/${quota.cap}` : '—'}
          foot={lang === 'en' ? 'Daily generation quota' : '出图张数按天算'}
        />
        <Stat
          label={lang === 'en' ? 'Gallery Assets' : '库里的图'}
          value={gallery.length}
          foot={lang === 'en' ? `Max ${COVER_MAX_PER_WORKSPACE} per workspace` : `每工作区最多留 ${COVER_MAX_PER_WORKSPACE} 张`}
        />
        <Stat
          label={lang === 'en' ? 'Pinned Images' : '已钉住'}
          value={pinned}
          foot={lang === 'en' ? 'Pinned images are exempt from retention purge' : '钉住的不会被保留期清掉'}
        />
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
