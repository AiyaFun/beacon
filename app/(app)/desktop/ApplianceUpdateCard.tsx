'use client';

import { useState, useTransition, useEffect, useRef } from 'react';
import { Card } from '@/components/ui';
import { actCheckUpdate, actStartUpdate } from './actions';
import { useI18n } from '@/lib/i18n';

// 整机版「一键增量更新」的操作卡。

type Phase = 'idle' | 'checking' | 'ready' | 'starting' | 'waiting' | 'back' | 'error';

export function ApplianceUpdateCard({
  current,
  latest,
  sizeMB,
  notes,
  canUpdate,
}: {
  current: string;
  latest: string | null;
  sizeMB: number | null;
  notes: string[];
  canUpdate: boolean;
}) {
  const { lang } = useI18n();
  const isEn = lang === 'en';
  const [phase, setPhase] = useState<Phase>('idle');
  const [msg, setMsg] = useState('');
  const [target, setTarget] = useState<string | null>(latest);
  const [size, setSize] = useState<number | null>(sizeMB);
  const [hasUpdate, setHasUpdate] = useState<boolean | null>(null);
  const [pending, start] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  function check() {
    setMsg('');
    setPhase('checking');
    start(async () => {
      const r = await actCheckUpdate();
      if (!r.ok) { setPhase('error'); setMsg(r.error); return; }
      setTarget(r.latest);
      setHasUpdate(r.hasUpdate);
      setPhase('ready');
      setSize(r.sizeMB || null);
      setMsg(
        isEn
          ? (r.hasUpdate ? `New version v${r.latest} (${r.sizeMB} MB)` : `Already on latest version v${r.current}`)
          : (r.hasUpdate ? `有新版本 v${r.latest}（${r.sizeMB} MB）` : `已经是最新版 v${r.current}`)
      );
    });
  }

  function doUpdate() {
    setMsg('');
    setPhase('starting');
    start(async () => {
      const r = await actStartUpdate();
      if (!r.ok) { setPhase('error'); setMsg(r.error ?? (isEn ? 'Failed to start' : '没启动起来')); return; }
      setTarget(r.version ?? null);
      setPhase('waiting');
      // 服务重启期间这一页连不上是正常的——轮到通为止。
      // 20 分钟上限：npm ci + next build 在慢机器上要十几分钟，但不能无限转。
      const deadline = Date.now() + 20 * 60 * 1000;
      const poll = async () => {
        if (Date.now() > deadline) {
          setPhase('error');
          setMsg(isEn ? 'Waited 20 minutes and service has not returned. Check terminal log: tail -50 appliance.log' : '等了 20 分钟还没回来。去这台机器的终端看日志：tail -50 appliance.log');
          return;
        }
        try {
          const res = await fetch('/api/health', { cache: 'no-store' });
          if (res.ok) { setPhase('back'); return; }
        } catch { /* 服务正在重启，连不上是预期内的 */ }
        timer.current = setTimeout(poll, 4000);
      };
      // 先等一会儿再开始轮：立刻轮会在服务还没停的时候就判「回来了」
      timer.current = setTimeout(poll, 15000);
    });
  }

  const busy = pending || phase === 'starting' || phase === 'waiting';

  return (
    <Card
      title={isEn ? 'Appliance Service Update' : '本机服务更新'}
      sub={
        isEn
          ? `Current v${current}${target && target !== current ? ` · Upgradable to v${target}${size ? ` (${size} MB)` : ''}` : ''} · Code replacement only, DB and configs intact`
          : `当前 v${current}${target && target !== current ? ` · 可更新到 v${target}${size ? `（${size} MB）` : ''}` : ''} · 只换代码，数据库与配置不动`
      }
      style={{ marginTop: 16 }}
    >
      {phase === 'waiting' ? (
        <div className="stack" style={{ gap: 8 }}>
          <b className="small">{isEn ? `Updating to v${target}…` : `正在更新到 v${target}…`}</b>
          <p className="small muted" style={{ lineHeight: 1.9, margin: 0 }}>
            {isEn ? (
              <>
                The service will pause for a few minutes (dependencies → schema sync → build → restart). <b>It is normal for this page to disconnect temporarily</b>.{' '}
                <b>Do not kill processes manually</b> — interrupting npm ci midway corrupts dependencies. The page will reload automatically once ready. To view details: <code className="mono">tail -f appliance.log</code> in your terminal.
              </>
            ) : (
              <>
                服务会停几分钟（装依赖 → 同步库结构 → 构建 → 重启），这段时间<b>这一页连不上是正常的</b>。
                <b>千万别手动杀进程</b>——npm ci 跑到一半被杀会留下坏掉的依赖。
                它一起来我就会自动刷新。想看细节：在这台机器的终端 <code className="mono">tail -f appliance.log</code>。
              </>
            )}
          </p>
        </div>
      ) : phase === 'back' ? (
        <div className="stack" style={{ gap: 8 }}>
          <b className="small" style={{ color: 'var(--green)' }}>{isEn ? '✅ Update completed, service is back online' : '✅ 更新完成，服务已经回来了'}</b>
          <p className="small muted" style={{ margin: 0 }}>
            {isEn
              ? 'Reload the page to see the new version. Database was automatically backed up before update (prisma/appliance.db.bak-*, keeping last 5 copies).'
              : '刷新页面看新版本。数据库已在更新前自动备份（prisma/appliance.db.bak-*，留最近 5 份）。'}
          </p>
          <div><button className="btn btn-sm btn-primary" onClick={() => location.reload()}>{isEn ? 'Reload Page' : '刷新页面'}</button></div>
        </div>
      ) : (
        <>
          <p className="small muted" style={{ lineHeight: 1.9, marginTop: 0 }}>
            {isEn ? (
              <>
                Pulls the latest package from official releases, validates sha256, then overlays in-place before syncing schema, compiling, and restarting.{' '}
                <b>Database and .env are never touched</b>, with automated pre-update backups.
              </>
            ) : (
              <>
                从官方站点拉最新代码包、校验 sha256 后原地覆盖，再自动装依赖、同步库结构、构建、重启。
                <b>数据库与 .env 一律不动</b>，更新前还会自动备份一次数据库。
              </>
            )}
          </p>
          {notes.length > 0 && (
            <ul className="small" style={{ margin: '0 0 10px', paddingLeft: 20, lineHeight: 1.8 }}>
              {notes.map((n, i) => <li key={i}>{n}</li>)}
            </ul>
          )}
          {msg && (
            <div className="small" style={{ marginBottom: 10, color: phase === 'error' ? 'var(--red)' : 'var(--text)' }}>
              {msg}
            </div>
          )}
          {!canUpdate ? (
            <p className="small muted" style={{ margin: 0 }}>{isEn ? 'Only administrators (owner / admin) can update appliance service.' : '只有管理员（owner / admin）能更新本机服务。'}</p>
          ) : (
            <div className="row" style={{ gap: 8 }}>
              <button className="btn btn-sm" disabled={busy} onClick={check}>
                {phase === 'checking' ? (isEn ? 'Checking…' : '检查中…') : (isEn ? 'Check for Updates' : '检查更新')}
              </button>
              <button
                className="btn btn-sm btn-primary"
                disabled={busy || hasUpdate !== true}
                onClick={doUpdate}
                title={hasUpdate === true ? (isEn ? `Update to v${target}` : `更新到 v${target}`) : (isEn ? 'Click "Check for Updates" first' : '先点「检查更新」')}
              >
                {phase === 'starting' ? (isEn ? 'Starting…' : '启动中…') : hasUpdate === true ? (isEn ? `One-Click Update to v${target}` : `一键更新到 v${target}`) : (isEn ? 'One-Click Update' : '一键更新')}
              </button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
