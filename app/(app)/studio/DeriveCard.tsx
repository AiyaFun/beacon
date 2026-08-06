'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { PLATFORM_LIST, platformName } from '@/lib/constants';
import { Icon } from '@/components/icons';
import { actDeriveToPlatform } from './actions';
import type { FamilyMember } from '@/lib/studio/family';

// 一稿多平台：派生入口 + 同源稿件的跨平台表现对比。
//
// 兑现「跨平台内容作战室」在创作端的那一半。此前选题/竞对/看板都是跨平台的，
// 唯独交付物不是——用户要一稿三发只能手开三份互不相干的草稿，
// 于是「同一篇内容在哪个平台跑赢了」这个最该被回答的问题永远算不出来。

const MAX_PICK = 3;

export function DeriveCard({
  draftId,
  currentPlatform,
  family,
}: {
  draftId?: string;
  currentPlatform?: string;
  family: FamilyMember[];
}) {
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
        setErr(r.error ?? '派生失败');
        return;
      }
      const skipped = (r.skipped ?? []).map((s) => `${platformName(s.platform)}（${s.reason}）`).join('、');
      setNote(
        `已生成 ${r.created!.length} 个平台版本${skipped ? `；跳过：${skipped}` : ''}${r.mocked ? '（当前为演示模式产出）' : ''}`,
      );
      setPicked([]);
      router.refresh();
    });
  }

  // 有回流数据的成员：用来做跨平台对比。少于 2 条有数据的不画对比——
  // 只有一条时展示「跨平台对比」是在假装有数据。
  const withData = family.filter((f) => f.metrics && (f.metrics.views ?? 0) > 0);
  const best = withData.length >= 2
    ? withData.reduce((a, b) => ((b.metrics!.views ?? 0) > (a.metrics!.views ?? 0) ? b : a))
    : null;

  return (
    <div className="stack" style={{ gap: 12 }}>
      {!draftId ? (
        <div className="small muted">先在左侧选中一份草稿。</div>
      ) : (
        <>
          <div className="small muted" style={{ lineHeight: 1.6 }}>
            把这篇改写成其他平台的版本，各自成为独立草稿（各自版本线、各自登记发布、各自回流），
            互相认亲后就能比较同一篇内容在哪个平台跑得更好。一次最多 {MAX_PICK} 个，每个平台消耗一次 AI 额度。
          </div>
          <div className="row wrap" style={{ gap: 6 }}>
            {options.length === 0 ? (
              <span className="small muted">所有平台都已经有同源版本了。</span>
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
          <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
            <button className="btn btn-sm btn-primary" onClick={submit} disabled={pending || picked.length === 0}>
              <Icon.sparkles size={14} /> {pending ? '生成中…' : `派生 ${picked.length || ''} 个版本`}
            </button>
            {err && <span className="small" style={{ color: 'var(--red)' }}>{err}</span>}
            {note && <span className="small" style={{ color: 'var(--green)' }}>{note}</span>}
          </div>
        </>
      )}

      {family.length > 1 && (
        <>
          <div className="divider" />
          <b className="small">同源稿件（{family.length} 个平台）</b>
          <div className="stack" style={{ gap: 6 }}>
            {family.map((m) => (
              <Link
                key={m.draftId}
                href={`/studio?draft=${m.draftId}`}
                className="row-between"
                style={{ gap: 8, padding: '6px 8px', borderRadius: 6, background: 'var(--surface-2)' }}
              >
                <span className="small">
                  {platformName(m.platform)}
                  {m.isRoot && <span className="badge badge-gray" style={{ marginLeft: 6, fontSize: 10 }}>原稿</span>}
                </span>
                <span className="small muted">
                  {m.published
                    ? m.metrics
                      ? `已发布 · 播放/阅读 ${m.metrics.views}`
                      : '已发布 · 数据还没回流'
                    : '未发布'}
                </span>
              </Link>
            ))}
          </div>
          {best ? (
            <div className="small muted" style={{ lineHeight: 1.6 }}>
              同一篇内容里，<b style={{ color: 'var(--text)' }}>{platformName(best.platform)}</b> 目前跑得最好
              （{best.metrics!.views} 播放/阅读）。样本还小，先当参考，别急着下结论。
            </div>
          ) : (
            <div className="small muted">
              还不能比较——至少要有两个平台的版本都发布并回流数据后，这里才会给出跨平台结论。
            </div>
          )}
        </>
      )}
    </div>
  );
}
