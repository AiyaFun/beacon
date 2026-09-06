'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { PLATFORM_LIST, platformName } from '@/lib/constants';
import { Icon } from '@/components/icons';
import { useI18n } from '@/lib/i18n';
import { actDeriveToPlatform } from './actions';
import { WECHAT_DERIVE_HINT } from '@/lib/algorithm/ai-source';
import type { FamilyMember } from '@/lib/studio/family';

// 一稿多平台：派生入口 + 同源稿件的跨平台表现对比。

const MAX_PICK = 3;

export function DeriveCard({
  draftId,
  currentPlatform,
  family,
  coverCounts,
  wechatHint,
}: {
  draftId?: string;
  currentPlatform?: string;
  family: FamilyMember[];
  /** 每篇兄弟稿出过几张封面（服务端算好；没出过的**不出现在这个表里**——「未出」是缺席不是 0） */
  coverCounts?: Record<string, number>;
  wechatHint?: boolean;
}) {
  const { lang } = useI18n();
  const [picked, setPicked] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [pending, start] = useTransition();
  const router = useRouter();

  const taken = new Set(family.map((f) => f.platform).concat(currentPlatform ? [currentPlatform] : []));
  const options = PLATFORM_LIST.filter((p) => !taken.has(p.key as string));

  function toggle(key: string) {
    setPicked((prev) => (prev.includes(key) ? prev.filter((x) => x !== key) : prev.length >= MAX_PICK ? prev : [...prev, key]));
  }

  function submit() {
    if (!draftId || picked.length === 0) return;
    setErr('');
    setNote('');
    start(async () => {
      const r = await actDeriveToPlatform(draftId, picked);
      if (!r.ok) {
        setErr(r.error ?? (lang === 'en' ? 'Derivation failed' : '派生失败'));
        return;
      }
      const skipped = (r.skipped ?? []).map((s) => `${platformName(s.platform)} (${s.reason})`).join(', ');
      setNote(
        lang === 'en'
          ? `Generated ${r.created!.length} platform versions${skipped ? `; Skipped: ${skipped}` : ''}${r.mocked ? ' (Demo Mode Output)' : ''}`
          : `已生成 ${r.created!.length} 个平台版本${skipped ? `；跳过：${skipped}` : ''}${r.mocked ? '（当前为演示模式产出）' : ''}`,
      );
      setPicked([]);
      router.refresh();
    });
  }

  // 有回流数据的成员：用来做跨平台对比。少于 2 条有数据的不画对比——
  const withData = family.filter((f) => f.metrics && (f.metrics.views ?? 0) > 0);
  const best = withData.length >= 2
    ? withData.reduce((a, b) => ((b.metrics!.views ?? 0) > (a.metrics!.views ?? 0) ? b : a))
    : null;

  return (
    <div className="stack" style={{ gap: 12 }}>
      {!draftId ? (
        <div className="small muted">
          {lang === 'en' ? 'Select a draft on the left first.' : '先在左侧选中一份草稿。'}
        </div>
      ) : (
        <>
          <div className="small muted" style={{ lineHeight: 1.6 }}>
            {lang === 'en'
              ? `Rewrite this article into versions tailored for other platforms, each becoming an independent draft (independent version history, publish logging, and metrics tracking). Once linked, you can compare performance across channels. Up to ${MAX_PICK} at a time, each platform consumes 1 AI credit.`
              : `把这篇改写成其他平台的版本，各自成为独立草稿（各自版本线、各自登记发布、各自回流），互相认亲后就能比较同一篇内容在哪个平台跑得更好。一次最多 ${MAX_PICK} 个，每个平台消耗一次 AI 额度。`}
          </div>
          <div className="row wrap" style={{ gap: 6 }}>
            {options.length === 0 ? (
              <span className="small muted">
                {lang === 'en' ? 'All platforms already have derived versions.' : '所有平台都已经有同源版本了。'}
              </span>
            ) : (
              options.map((p) => (
                <button
                  key={p.key}
                  className={`btn btn-sm ${picked.includes(p.key as string) ? 'btn-accent' : 'btn-ghost'}`}
                  onClick={() => toggle(p.key as string)}
                  disabled={pending}
                >
                  {p.name}
                </button>
              ))
            )}
          </div>
          {wechatHint && options.some((p) => p.key === 'wechat') && (
            <div className="row" style={{ gap: 6, alignItems: 'flex-start' }}>
              <Icon.info size={14} className="" />
              <span className="small muted" style={{ lineHeight: 1.6 }}>
                {lang === 'en' ? (
                  'WeChat Official Accounts have unique search visibility across Tencent ecosystem.'
                ) : (
                  <>{WECHAT_DERIVE_HINT}</>
                )}
              </span>
            </div>
          )}
          <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
            <button className="btn btn-sm btn-primary" onClick={submit} disabled={pending || picked.length === 0}>
              <Icon.sparkles size={14} />{' '}
              {pending
                ? (lang === 'en' ? 'Generating…' : '生成中…')
                : (lang === 'en'
                    ? `Derive ${picked.length || ''} Version${picked.length > 1 ? 's' : ''}`
                    : `派生 ${picked.length || ''} 个版本`)}
            </button>
            {err && <span className="small" style={{ color: 'var(--red)' }}>{err}</span>}
            {note && <span className="small" style={{ color: 'var(--green)' }}>{note}</span>}
          </div>
        </>
      )}

      {family.length > 1 && (
        <>
          <div className="divider" />
          <b className="small">
            {lang === 'en'
              ? `Derived Articles (${family.length} platforms)`
              : `同源稿件（${family.length} 个平台）`}
          </b>
          <div className="stack" style={{ gap: 6 }}>
            {family.map((m) => (
              <Link
                key={m.draftId}
                href={`/studio?draft=${m.draftId}&tab=title`}
                className="row-between"
                style={{ gap: 8, padding: '6px 8px', borderRadius: 6, background: 'var(--surface-2)' }}
              >
                <span className="small">
                  {platformName(m.platform)}
                  {m.isRoot && (
                    <span className="badge badge-gray" style={{ marginLeft: 6, fontSize: 10 }}>
                      {lang === 'en' ? 'Original' : '原稿'}
                    </span>
                  )}
                </span>
                <span className="row wrap small muted" style={{ gap: 8, justifyContent: 'flex-end' }}>
                  <span className={coverCounts?.[m.draftId] ? '' : 'muted'}>
                    {coverCounts?.[m.draftId]
                      ? (lang === 'en'
                          ? `${coverCounts[m.draftId]} cover${coverCounts[m.draftId] > 1 ? 's' : ''}`
                          : `封面 ${coverCounts[m.draftId]} 张`)
                      : (lang === 'en' ? 'Cover: None' : '封面：未出')}
                  </span>
                  <span>
                    {m.published
                      ? m.metrics
                        ? (lang === 'en' ? `Published · ${m.metrics.views} views` : `已发布 · 播放/阅读 ${m.metrics.views}`)
                        : (lang === 'en' ? 'Published · Awaiting metrics' : '已发布 · 数据还没回流')
                      : (lang === 'en' ? 'Unpublished' : '未发布')}
                  </span>
                </span>
              </Link>
            ))}
          </div>
          {best ? (
            <div className="small muted" style={{ lineHeight: 1.6 }}>
              {lang === 'en' ? (
                <>
                  Among versions of this content, <b style={{ color: 'var(--text)' }}>{platformName(best.platform)}</b> is currently performing best ({best.metrics!.views} views). Sample size is still small, use as reference.
                </>
              ) : (
                <>
                  同一篇内容里，<b style={{ color: 'var(--text)' }}>{platformName(best.platform)}</b> 目前跑得最好
                  （{best.metrics!.views} 播放/阅读）。样本还小，先当参考，别急着下结论。
                </>
              )}
            </div>
          ) : (
            <div className="small muted">
              {lang === 'en'
                ? 'Cannot compare yet — cross-platform conclusions will appear here once at least two platform versions are published with tracked metrics.'
                : '还不能比较——至少要有两个平台的版本都发布并回流数据后，这里才会给出跨平台结论。'}
            </div>
          )}
        </>
      )}
    </div>
  );
}
