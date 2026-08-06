'use client';

import { useCallback, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { actRefundOrder, actRefundPreview } from './actions';

// 自助退款：点「申请退款」→ 弹窗先拉预览（能退多少、已用几天）→ 确认后发起。
// 金额一律服务端算（actRefundPreview/actRefundOrder），前端只传单号。仅 owner 可见此按钮。

type Preview = {
  kind: 'full' | 'prorated' | 'manual';
  refundFen: number;
  usedDays: number;
  remainingDays: number;
  totalDays: number;
  consumedCount: number;
  reason: string;
  recoverable: boolean;
  csEmail: string;
  csWechat: string;
};

export function RefundButton({ outTradeNo, amountFen }: { outTradeNo: string; amountFen: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ amountRefundFen: number; planRecovered: boolean } | null>(null);

  const load = useCallback(() => {
    setError('');
    setPreview(null);
    setDone(null);
    start(async () => {
      const r = await actRefundPreview(outTradeNo);
      if (!r.ok) {
        setError(r.error ?? '无法加载退款信息');
        return;
      }
      setPreview(r as Preview);
    });
  }, [outTradeNo]);

  function openModal() {
    setOpen(true);
    load();
  }

  function close() {
    setOpen(false);
    setPreview(null);
    setError('');
    setDone(null);
  }

  function confirm() {
    setError('');
    start(async () => {
      const r = await actRefundOrder(outTradeNo);
      if (!r.ok) {
        setError(r.error ?? '退款发起失败');
        return;
      }
      setDone({ amountRefundFen: r.amountRefundFen ?? 0, planRecovered: r.planRecovered ?? false });
      router.refresh(); // 订单状态/当前套餐立刻刷新
    });
  }

  // 不可自助（转人工）：manual 口径 或 其上已有后续购买（!recoverable）
  const manualOnly = preview && (preview.kind === 'manual' || !preview.recoverable);

  return (
    <>
      {/* 入口必须一眼看得见：原来是 btn-ghost（无边框、透明底）挤在一行灰色小字最右边，
          用户反馈「找不到」。改成有边框有底色的实体按钮 + 退款语义的红字，并且不继承外层的 muted。 */}
      <button
        className="btn btn-sm"
        onClick={openModal}
        disabled={pending && open}
        style={{ color: 'var(--red)', borderColor: 'var(--red)', fontWeight: 600 }}
      >
        ↩ 申请退款
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="申请退款"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 50,
            padding: 16,
          }}
          onClick={close}
        >
          <div className="card" style={{ maxWidth: 420, width: '100%' }} onClick={(e) => e.stopPropagation()}>
            <div className="row-between" style={{ marginBottom: 12 }}>
              <div className="card-title">
                申请退款 <span className="card-sub mono">{outTradeNo}</span>
              </div>
              <button className="btn btn-sm" onClick={close}>关闭</button>
            </div>

            {done ? (
              <div className="stack" style={{ gap: 10, textAlign: 'center', padding: '16px 0' }}>
                <div style={{ fontSize: 40 }}>✅</div>
                <b>退款已受理</b>
                <div className="small muted">退款金额 ¥{(done.amountRefundFen / 100).toFixed(2)}</div>
                <div className="small muted">
                  {done.planRecovered ? '当前套餐已同步回收。' : '退款处理中，套餐将在退款成功后回收。'}
                  款项将原路退回微信支付账户，通常 1-3 个工作日到账。
                </div>
                <button className="btn btn-primary btn-sm" onClick={close}>完成</button>
              </div>
            ) : pending && !preview ? (
              <div className="small muted" style={{ padding: '20px 0', textAlign: 'center' }}>加载退款信息…</div>
            ) : error && !preview ? (
              <div className="stack" style={{ gap: 12 }}>
                <div className="small" style={{ color: 'var(--red)' }}>{error}</div>
                <button className="btn btn-sm" onClick={close}>关闭</button>
              </div>
            ) : preview ? (
              <div className="stack" style={{ gap: 14 }}>
                <div className="stack" style={{ gap: 6, padding: '10px 12px', background: 'var(--surface-2)', borderRadius: 10 }}>
                  <div className="row-between">
                    <span className="small muted">订单金额</span>
                    <span className="mono">¥{(amountFen / 100).toFixed(2)}</span>
                  </div>
                  <div className="row-between">
                    <span className="small muted">已消耗 AI 次数</span>
                    <span className="mono">{preview.consumedCount} 次</span>
                  </div>
                  {preview.totalDays > 0 && (
                    <div className="row-between">
                      <span className="small muted">已用 / 剩余天数</span>
                      <span className="mono">{preview.usedDays} / {preview.remainingDays} 天</span>
                    </div>
                  )}
                  {!manualOnly && (
                    <div className="row-between" style={{ borderTop: '1px solid var(--surface)', paddingTop: 6, marginTop: 2 }}>
                      <span className="small" style={{ fontWeight: 600 }}>可退金额</span>
                      <span className="mono" style={{ fontWeight: 700, color: 'var(--brand)' }}>¥{(preview.refundFen / 100).toFixed(2)}</span>
                    </div>
                  )}
                </div>

                <div className="small muted" style={{ lineHeight: 1.7 }}>{preview.reason}</div>

                {manualOnly ? (
                  <div className="small" style={{ lineHeight: 1.7 }}>
                    此订单需人工处理。请联系客服并提供订单号：
                    <br />客服邮箱：<span className="mono">{preview.csEmail}</span>
                    <br />客服微信：<span className="mono">{preview.csWechat}</span>
                  </div>
                ) : (
                  <>
                    <div className="small muted" style={{ lineHeight: 1.6 }}>
                      确认后将发起原路退款，<b>当前套餐会被回收</b>（回落到购买前的状态），此操作不可撤销。
                    </div>
                    {error && <div className="small" style={{ color: 'var(--red)' }}>{error}</div>}
                    <div className="row" style={{ gap: 10 }}>
                      <button className="btn btn-primary btn-sm" onClick={confirm} disabled={pending}>
                        {pending ? '处理中…' : `确认退款 ¥${(preview.refundFen / 100).toFixed(2)}`}
                      </button>
                      <button className="btn btn-sm" onClick={close} disabled={pending}>取消</button>
                    </div>
                  </>
                )}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </>
  );
}
