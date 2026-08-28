'use client';

import { useState, useTransition, useEffect, useRef } from 'react';
import { Card } from '@/components/ui';
import { actCheckUpdate, actStartUpdate } from './actions';

// 整机版「一键增量更新」的操作卡。
//
// 【最要紧的一件事：更新到一半这个页面自己会死】更新的第 5 步是重启服务——
// 发起这次点击的那个进程届时已经没了。所以流程必须是：
//   点更新 → server action 起一个脱离进程的脚本、**立刻返回** →
//   前端进入「盯着它回来」模式，轮询 /api/health 直到服务带着新版本起来。
// 这中间页面会连不上服务几分钟，那是**正常现象**，必须提前说清楚，
// 否则用户会以为把机器搞坏了，去手动杀进程——那才真会搞坏（npm ci 跑到一半被杀）。
//
// 【为什么不显示脚本的实时进度】脚本把步骤写在 .appliance-update.state 里，
// 但读它要经过服务——而服务恰恰在这段时间里是停的。所以这里只报「已开始/等它回来」，
// 想看细节的人去看终端日志（卡片上写了路径）。

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
      setMsg(r.hasUpdate ? `有新版本 v${r.latest}（${r.sizeMB} MB）` : `已经是最新版 v${r.current}`);
    });
  }

  function doUpdate() {
    setMsg('');
    setPhase('starting');
    start(async () => {
      const r = await actStartUpdate();
      if (!r.ok) { setPhase('error'); setMsg(r.error ?? '没启动起来'); return; }
      setTarget(r.version ?? null);
      setPhase('waiting');
      // 服务重启期间这一页连不上是正常的——轮到通为止。
      // 20 分钟上限：npm ci + next build 在慢机器上要十几分钟，但不能无限转。
      const deadline = Date.now() + 20 * 60 * 1000;
      const poll = async () => {
        if (Date.now() > deadline) {
          setPhase('error');
          setMsg('等了 20 分钟还没回来。去这台机器的终端看日志：tail -50 appliance.log');
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
      title="本机服务更新"
      sub={
        `当前 v${current}`
        + (target && target !== current ? ` · 可更新到 v${target}${size ? `（${size} MB）` : ''}` : '')
        + ' · 只换代码，数据库与配置不动'
      }
      style={{ marginTop: 16 }}
    >
      {phase === 'waiting' ? (
        <div className="stack" style={{ gap: 8 }}>
          <b className="small">正在更新到 v{target}…</b>
          <p className="small muted" style={{ lineHeight: 1.9, margin: 0 }}>
            服务会停几分钟（装依赖 → 同步库结构 → 构建 → 重启），这段时间<b>这一页连不上是正常的</b>。
            <b>千万别手动杀进程</b>——npm ci 跑到一半被杀会留下坏掉的依赖。
            它一起来我就会自动刷新。想看细节：在这台机器的终端 <code className="mono">tail -f appliance.log</code>。
          </p>
        </div>
      ) : phase === 'back' ? (
        <div className="stack" style={{ gap: 8 }}>
          <b className="small" style={{ color: 'var(--green)' }}>✅ 更新完成，服务已经回来了</b>
          <p className="small muted" style={{ margin: 0 }}>刷新页面看新版本。数据库已在更新前自动备份（prisma/appliance.db.bak-*，留最近 5 份）。</p>
          <div><button className="btn btn-sm btn-primary" onClick={() => location.reload()}>刷新页面</button></div>
        </div>
      ) : (
        <>
          <p className="small muted" style={{ lineHeight: 1.9, marginTop: 0 }}>
            从官方站点拉最新代码包、校验 sha256 后原地覆盖，再自动装依赖、同步库结构、构建、重启。
            <b>数据库与 .env 一律不动</b>，更新前还会自动备份一次数据库。
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
            <p className="small muted" style={{ margin: 0 }}>只有管理员（owner / admin）能更新本机服务。</p>
          ) : (
            <div className="row" style={{ gap: 8 }}>
              <button className="btn btn-sm" disabled={busy} onClick={check}>
                {phase === 'checking' ? '检查中…' : '检查更新'}
              </button>
              <button
                className="btn btn-sm btn-primary"
                // 只有「查过、且确实有新版」才给点：没查过就更新等于让用户对一个未知的东西点头
                disabled={busy || hasUpdate !== true}
                onClick={doUpdate}
                title={hasUpdate === true ? `更新到 v${target}` : '先点「检查更新」'}
              >
                {phase === 'starting' ? '启动中…' : hasUpdate === true ? `一键更新到 v${target}` : '一键更新'}
              </button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
