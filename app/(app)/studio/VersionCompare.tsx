'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { actRestoreDraftVersion } from './actions';
import { Overlay } from '@/components/Overlay';
import { diffSentences, diffStats } from '@/lib/studio/diff';
import { useI18n } from '@/lib/i18n';

// 版本对比。
//
// 时间线原来每版只有一句 diffFromPrev（「按 3 条采纳意见改写」这类摘要），
// 看得出**做了什么**，看不出**改了哪句**。而这个产品的核心机制之一是「AI 初稿 vs 人工终稿的差异」
// ——那条差异用户自己看不见，只有系统在学。这里把它摊开。
//
// diff 在浏览器里算：正文本来就随页面下发过一次了，再往服务端跑一趟只是多一次往返。

export type CompareVersion = {
  seq: number;
  authorType: string;
  content: string;
  /** 服务端算好的相对时间，客户端不碰 Date.now() */
  timeLabel: string;
};

export function VersionCompare({ versions, draftId }: { versions: CompareVersion[]; draftId?: string }) {
  const { lang } = useI18n();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(false);
  // 默认对比「最新两版」——这是十次里有九次想看的那一对
  const [left, setLeft] = useState(() => versions[versions.length - 2]?.seq ?? versions[0]?.seq ?? 0);
  const [right, setRight] = useState(() => versions[versions.length - 1]?.seq ?? 0);

  const a = versions.find((v) => v.seq === left);
  const b = versions.find((v) => v.seq === right);
  const ops = useMemo(() => (a && b ? diffSentences(a.content, b.content) : []), [a, b]);
  const stats = useMemo(() => diffStats(ops), [ops]);

  if (versions.length < 2) return null;

  const label = (v: CompareVersion) => {
    const role = v.authorType === 'ai'
      ? (lang === 'en' ? 'AI Draft' : 'AI 初稿')
      : (lang === 'en' ? 'Final Edit' : '人工终稿');
    return `v${v.seq} · ${role} · ${v.timeLabel}`;
  };

  return (
    <>
      <button
        className="btn btn-sm btn-ghost"
        onClick={() => setOpen(true)}
        title={lang === 'en' ? 'Inspect sentence-by-sentence changes between versions' : '逐句看两版之间改了什么'}
      >
        {lang === 'en' ? 'Version Compare' : '版本对比'}
      </button>

      {open && (
        <Overlay label={lang === 'en' ? 'Version Compare' : '版本对比'} onClose={() => setOpen(false)}>
          <div
            className="card"
            style={{ padding: 20, width: 860, maxWidth: '94vw', maxHeight: '88vh', display: 'flex', flexDirection: 'column' }}
          >
            <div className="row-between wrap" style={{ gap: 10, marginBottom: 12 }}>
              <b>{lang === 'en' ? 'Version Comparison' : '版本对比'}</b>
              <button className="btn btn-sm btn-ghost" onClick={() => setOpen(false)}>
                {lang === 'en' ? 'Close' : '关闭'}
              </button>
            </div>

            <div className="row wrap" style={{ gap: 8, alignItems: 'center', marginBottom: 12 }}>
              <select className="select" style={{ maxWidth: 260 }} value={left} onChange={(e) => setLeft(Number(e.target.value))}>
                {versions.map((v) => (
                  <option key={v.seq} value={v.seq}>{lang === 'en' ? 'Old: ' : '旧：'}{label(v)}</option>
                ))}
              </select>
              <span className="muted">→</span>
              <select className="select" style={{ maxWidth: 260 }} value={right} onChange={(e) => setRight(Number(e.target.value))}>
                {versions.map((v) => (
                  <option key={v.seq} value={v.seq}>{lang === 'en' ? 'New: ' : '新：'}{label(v)}</option>
                ))}
              </select>
            </div>

            {left === right ? (
              <div className="small muted" style={{ padding: '20px 0' }}>
                {lang === 'en' ? 'Selected the same version. Pick another to compare.' : '选了同一版，没什么可比的。换一个再看。'}
              </div>
            ) : (
              <>
                <div className="row wrap" style={{ gap: 8, alignItems: 'center', marginBottom: 10 }}>
                  <span className="badge badge-green">+{stats.added} {lang === 'en' ? 'chars' : '字'}</span>
                  <span className="badge badge-red">−{stats.removed} {lang === 'en' ? 'chars' : '字'}</span>
                  <span className="badge badge-gray">{lang === 'en' ? `Retained ${stats.kept} chars` : `保留 ${stats.kept} 字`}</span>
                  <span className="small muted">{lang === 'en' ? `~${stats.changedRatio}% changed` : `改动约 ${stats.changedRatio}%`}</span>
                  {a && b && a.authorType === 'ai' && b.authorType === 'human' && (
                    <span className="badge badge-brand" title={lang === 'en' ? 'The system learns your personal style from this exact delta' : '系统正是从这一对差异里学你的口味'}>
                      {lang === 'en' ? 'Style-Learning Delta Pair' : '这一对就是系统用来学偏好的差异'}
                    </span>
                  )}
                </div>

                <div
                  className="diff-body small"
                  style={{
                    flex: 1,
                    minHeight: 0,
                    overflowY: 'auto',
                    background: 'var(--surface-2)',
                    padding: '14px 16px',
                    borderRadius: 'var(--radius-sm)',
                  }}
                >
                  {ops.length === 0 ? (
                    <span className="muted">{lang === 'en' ? 'Both versions are completely identical.' : '两版内容完全一致。'}</span>
                  ) : (
                    ops.map((op, i) =>
                      op.type === 'same' ? (
                        <span key={i}>{op.text}</span>
                      ) : op.type === 'add' ? (
                        <ins key={i}>{op.text}</ins>
                      ) : (
                        <del key={i}>{op.text}</del>
                      ),
                    )
                  )}
                </div>

                <div className="small muted" style={{ marginTop: 10, lineHeight: 1.6 }}>
                  {lang === 'en'
                    ? 'Green indicates text added in newer version, red strikethrough indicates removed from older version, remaining text is identical. Compared sentence-by-sentence.'
                    : '绿色是新版加的，红色删除线是旧版被去掉的，其余是两版都有的原话。按句比对。'}
                </div>

                {/* 【看出旧那版更好之后】此前只能自己把正文复制粘贴回去。
                    回滚**存成新版本而不是删掉后面的**——历史本身是审计证据，
                    「谁在什么时候回滚过」同样要查得到（与人设版本同一个口径）。 */}
                {draftId && a && a.seq !== versions[versions.length - 1]?.seq && (
                  <div className="row wrap" style={{ gap: 8, marginTop: 12, alignItems: 'center' }}>
                    <button
                      className="btn btn-sm"
                      disabled={pending}
                      onClick={() => {
                        setErr('');
                        start(async () => {
                          const r = await actRestoreDraftVersion(draftId, a.seq);
                          if (!r.ok) { setErr(r.error ?? (lang === 'en' ? 'Rollback failed' : '没能回滚')); return; }
                          setOpen(false);
                          router.refresh();
                        });
                      }}
                    >
                      {pending ? (lang === 'en' ? 'Restoring…' : '回滚中…') : (lang === 'en' ? `Revert to left version (v${a.seq})` : `回到左边这一版（v${a.seq}）`)}
                    </button>
                    <span className="small muted">{lang === 'en' ? 'Saved as a new version; history will not be deleted.' : '会存成新版本，历史不会被删掉。'}</span>
                    {err && <span className="small" style={{ color: 'var(--red)' }}>{err}</span>}
                  </div>
                )}
              </>
            )}
          </div>
        </Overlay>
      )}
    </>
  );
}
