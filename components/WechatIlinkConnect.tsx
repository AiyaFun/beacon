'use client';

import { useEffect, useRef, useState } from 'react';
import { actWechatIlinkQr, actWechatIlinkStatus } from '@/app/(app)/settings/bot-actions';

// 微信（官方 iLink 机器人接口）的扫码绑定（2026-09-02）。
// 没有任何要填的：拿码 → 用户在微信里扫 → 微信那头回 bot_token → 服务端落库 → 完成。
// 状态接口是长轮询（hold 到状态变化或约 35 秒），所以这里**按序 await**，不叠 setInterval——
// 叠了会攒出一堆并发请求，每个都 hold 35 秒。

const MAX_WAIT_MS = 3 * 60 * 1000;

type Props = {
  /** 已有的绑定（编辑态「重新扫码」）；新接入传 null */
  existing: { id: string; ilinkUserId: string | null; ilinkExpired: boolean } | null;
  /** 新接入时立刻拿码；编辑态先展示状态，点「重新扫码」再拿 */
  autoStart?: boolean;
  onDone: (id: string) => void;
};

export function WechatIlinkConnect({ existing, autoStart = false, onDone }: Props) {
  const [phase, setPhase] = useState<'idle' | 'loading' | 'qr' | 'confirmed'>('idle');
  const [qrSvg, setQrSvg] = useState('');
  const [scanned, setScanned] = useState(false);
  const [err, setErr] = useState('');
  const aliveRef = useRef(true);
  const runRef = useRef(0);

  useEffect(() => {
    aliveRef.current = true;
    if (autoStart) void start();
    return () => { aliveRef.current = false; runRef.current += 1; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function start() {
    const run = ++runRef.current;
    setErr('');
    setScanned(false);
    setPhase('loading');
    const q = await actWechatIlinkQr();
    if (!aliveRef.current || run !== runRef.current) return;
    if (!q.ok || !q.qrcode || !q.qrSvg) { setErr(q.error ?? '拿二维码失败'); setPhase('idle'); return; }
    setQrSvg(q.qrSvg);
    setPhase('qr');
    const startedAt = Date.now();
    // 按序轮询：每次调用微信那头最多 hold 35 秒，状态一变就回来
    while (aliveRef.current && run === runRef.current) {
      const st = await actWechatIlinkStatus(q.qrcode, { existingId: existing?.id });
      if (!aliveRef.current || run !== runRef.current) return;
      if (!st.ok) { setErr(st.error ?? '查扫码状态失败'); setPhase('idle'); return; }
      if (st.status === 'confirmed' && st.id) { setPhase('confirmed'); onDone(st.id); return; }
      if (st.status === 'expired') { setErr('二维码已过期，请重新生成'); setPhase('idle'); return; }
      setScanned(st.status === 'scaned');
      if (Date.now() - startedAt > MAX_WAIT_MS) { setErr('等待扫码超时（3 分钟），请重新生成'); setPhase('idle'); return; }
      // 服务端若立刻返回（网络抖动/代理截断），别打成热循环
      await new Promise((r) => setTimeout(r, 800));
    }
  }

  const note = (
    <div className="small muted" style={{ lineHeight: 1.75, textAlign: 'left' }}>
      这是<b>微信官方的 iLink 机器人接口</b>（微信 ClawBot 同一套），不经企业微信、不用装任何东西。
      扫码后机器人会出现在你微信的联系人里，<b>只有扫码的这个微信号</b>能和它对话；它只回复你发来的消息，不会主动发。
      微信登录态过期时回来重新扫一次即可。接入范围与频率由微信方决定，微信方保留审核与阻断的权利。
    </div>
  );

  if (phase === 'confirmed') {
    return (
      <div className="stack" style={{ gap: 10, textAlign: 'center', padding: 12 }}>
        <div style={{ fontSize: 34 }}>✅</div>
        <b>已绑定微信</b>
        <div className="small muted">打开微信，给刚出现的机器人联系人发一句话试试——发问题、文章链接或一句选题都行，/帮助 看它能做什么。</div>
        {note}
      </div>
    );
  }

  if (phase === 'qr' || phase === 'loading') {
    return (
      <div className="stack" style={{ gap: 10, textAlign: 'center', padding: 12 }}>
        <b>{scanned ? '已扫码，请在手机上确认' : '打开微信 → 扫一扫'}</b>
        {phase === 'loading' ? (
          <div className="small muted" style={{ padding: 40 }}>正在向微信申请二维码…</div>
        ) : (
          <div
            aria-label="微信绑定二维码"
            style={{ width: 220, height: 220, alignSelf: 'center', border: '1px solid var(--border)', borderRadius: 8, background: '#fff', padding: 6 }}
            // renderQrSvg 是我们自己零依赖编码出来的 SVG 字符串（lib/pay/qr，付款码同一套）
            dangerouslySetInnerHTML={{ __html: qrSvg }}
          />
        )}
        <div className="small muted">{scanned ? '等待手机确认…' : '等待扫码…（二维码约 3 分钟内有效）'}</div>
        {note}
        {err && <div className="small" style={{ color: 'var(--red)' }}>{err}</div>}
      </div>
    );
  }

  // idle：新接入出错后 / 编辑态的状态面板
  const bound = !!existing;
  return (
    <div className="stack" style={{ gap: 10, padding: 4 }}>
      {bound && (
        <div className="small" style={{ color: existing!.ilinkExpired ? 'var(--red)' : 'var(--green)' }}>
          {existing!.ilinkExpired
            ? '⚠ 微信登录态已过期，机器人暂时收不到消息——重新扫码即可恢复'
            : `✅ 已绑定微信${existing!.ilinkUserId ? `（${existing!.ilinkUserId}）` : ''}`}
        </div>
      )}
      {note}
      {err && <div className="small" style={{ color: 'var(--red)' }}>{err}</div>}
      <button className="btn btn-sm btn-primary" style={{ alignSelf: 'flex-start' }} onClick={() => void start()}>
        {bound ? '重新扫码' : err ? '重新生成二维码' : '生成二维码'}
      </button>
    </div>
  );
}
