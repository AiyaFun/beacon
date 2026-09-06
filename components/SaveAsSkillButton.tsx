'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { actDistillProcedure } from '@/app/(app)/skills/procedure-actions';
import { useI18n } from '@/lib/i18n/context';

export function SaveAsSkillButton({ runId }: { runId: string }) {
  const { lang } = useI18n();
  const isEn = lang === 'en';
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (done) {
    return (
      <div className="small muted" style={{ marginTop: 12 }}>
        {isEn ? 'Saved as skill · ' : '已存为技能 · '}
        <Link href="/skills" style={{ color: 'var(--brand)', fontWeight: 600 }}>
          {isEn ? 'View in Skills' : '去技能库看看'}
        </Link>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 12 }}>
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        disabled={pending}
        onClick={() => {
          setErr(null);
          start(async () => {
            const r = await actDistillProcedure(runId);
            if (r.ok) setDone(true);
            else setErr(r.error ?? (isEn ? 'Failed to save' : '存不下来'));
          });
        }}
      >
        {pending ? (isEn ? 'Distilling…' : '提炼中…') : (isEn ? 'Save procedure as skill' : '把这次的做法存成技能')}
      </button>
      {err && <span className="small" style={{ marginLeft: 8, color: 'var(--red)' }}>{err}</span>}
    </div>
  );
}
