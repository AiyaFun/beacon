'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { actCreateOrder, actMockPay, actPollOrder } from './actions';
import { Overlay } from '@/components/Overlay';
import { PRICING, type PaidPlan, type PeriodMonths } from '@/lib/pay/pricing';
import { fmtDateFull, fmtTime } from '@/lib/format';

// 购买时长文案：1=月付，12=年付，1188=永久买断。
function periodLabel(periodMonths: PeriodMonths): string {
  return periodMonths === 1188 ? '永久买断' : periodMonths === 12 ? '年付' : '月付';
}

// 扫码弹窗 + 支付后轮询。
// 轮询这条路径同时就是**回调兜底**：服务端每次轮询会顺手向微信查一次单（actPollOrder），
// 所以回调丢了用户照样能正常发货，不用等人工。

type Order = {
  outTradeNo: string;
  amountFen: number;
  qrSvg: string;
  codeExpiresAt: string;
  mocked: boolean;
};

const POLL_MS = 2500;

export function Checkout({
  plan,
  periodMonths,
  disabled,
  label,
  variant = 'primary',
}: {
  plan: PaidPlan;
  periodMonths: PeriodMonths;
  disabled?: boolean;
  label: string;
  variant?: 'gradient' | 'primary' | 'secondary';
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState('');
  const [paid, setPaid] = useState<{ grantedDays: number | null; newPlanExpiresAt: string | null } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stop = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  useEffect(() => () => stop(), [stop]); // 卸载时别把轮询留在后台

  const poll = useCallback(
    async (outTradeNo: string) => {
      const r = await actPollOrder(outTradeNo);
      if (!r.ok) return;
      if (r.status === 'paid') {
        stop();
        setPaid({ grantedDays: r.grantedDays, newPlanExpiresAt: r.newPlanExpiresAt });
        router.refresh(); // 让页面上的「当前套餐」立刻变
        return;
      }
      if (r.status === 'closed' || r.status === 'failed') {
        stop();
        setError(r.failReason ?? '订单已关闭，请重新下单');
        return;
      }
      timer.current = setTimeout(() => void poll(outTradeNo), POLL_MS);
    },
    [router, stop],
  );

  function open() {
    setError('');
    setPaid(null);
    start(async () => {
      const r = await actCreateOrder({ plan, periodMonths });
      if (!r.ok) {
        setError(r.error ?? '下单失败');
        return;
      }
      setOrder({ outTradeNo: r.outTradeNo, amountFen: r.amountFen, qrSvg: r.qrSvg, codeExpiresAt: r.codeExpiresAt, mocked: r.mocked });
      timer.current = setTimeout(() => void poll(r.outTradeNo), POLL_MS);
    });
  }

  function close() {
    stop();
    setOrder(null);
    setPaid(null);
  }

  function mockPay() {
    if (!order) return;
    start(async () => {
      const r = await actMockPay(order.outTradeNo);
      if (!r.ok) setError(r.error ?? '模拟支付失败');
      else void poll(order.outTradeNo); // 立刻查一次，不等下个轮询周期
    });
  }

  const btnClass =
    variant === 'gradient'
      ? 'btn btn-gradient btn-sm'
      : variant === 'secondary'
      ? 'btn btn-sm'
      : 'btn btn-primary btn-sm';

  return (
    <>
      <button className={btnClass} onClick={open} disabled={disabled || pending}>
        {pending && !order ? '下单中…' : label}
      </button>
      {error && !order && <div className="small" style={{ color: 'var(--red)', marginTop: 8 }}>{error}</div>}

      {/* ⚠️ 必须走 Overlay（portal 到 body），不能就地渲染。
          这个按钮永远长在套餐卡片里，而 globals.css 的 `.card:hover` 会给卡片加
          `transform: translateY(-2px)`；「当前生效套餐」那张还带 `.card-selected-gradient`，
          transform 是**常驻**的。带 transform 的元素是后代 `position: fixed` 的包含块——
          于是这个 `inset: 0` 的「全屏」支付层会缩成套餐卡那么大，二维码被挤到框外。
          用户是从卡片里的按钮点进来的，指针必然停在卡片上，所以这条路必现。
          见 components/Overlay.tsx 的长注释（工坊那一处已经踩过同一个坑）。 */}
      {order && (
        <Overlay onClose={close} label="微信扫码支付">
          <div className="card" style={{ maxWidth: 380, width: '100%' }}>
            <div className="row-between" style={{ marginBottom: 12 }}>
              <div className="card-title">
                微信扫码支付 <span className="card-sub">{PRICING[plan].name} · {periodLabel(periodMonths)}</span>
              </div>
              <button className="btn btn-sm" onClick={close}>关闭</button>
            </div>

            {paid ? (
              <div className="stack" style={{ gap: 10, textAlign: 'center', padding: '16px 0' }}>
                <div style={{ fontSize: 40 }}>✅</div>
                <b>支付成功，套餐已生效</b>
                {/* 口径见 lib/pay/plan.ts:GrantResult.grantedDays —— 升档时是「换来多少天新档」，
                    不是「延长多少天」（升档可能让到期日提前，措辞不能撒谎） */}
                {paid.grantedDays !== null && <div className="small muted">本单发放 {paid.grantedDays} 天</div>}
                {paid.newPlanExpiresAt && (
                  <div className="small muted">有效期至 {fmtDateFull(paid.newPlanExpiresAt)}</div>
                )}
                <button className="btn btn-primary btn-sm" onClick={close}>完成</button>
              </div>
            ) : (
              <div className="stack" style={{ gap: 12, alignItems: 'center' }}>
                <div style={{ fontSize: 26, fontWeight: 700 }}>¥{(order.amountFen / 100).toFixed(2)}</div>

                {order.mocked && (
                  <div
                    className="small"
                    style={{ color: 'var(--amber)', background: 'var(--surface-2)', padding: '8px 10px', borderRadius: 8, textAlign: 'center' }}
                  >
                    <b>模拟支付通道</b><br />
                    未配置微信支付凭证，这个二维码扫了不会真的跳转微信。<br />
                    点下方按钮模拟支付成功（走的是与生产完全相同的兑现代码）。
                  </div>
                )}

                {/* 二维码是服务端生成的自包含 SVG（lib/pay/qr.ts，零依赖），不含外链 */}
                <div
                  style={{ background: '#fff', padding: 8, borderRadius: 8, lineHeight: 0 }}
                  dangerouslySetInnerHTML={{ __html: order.qrSvg }}
                />

                <div className="small muted" style={{ textAlign: 'center' }}>
                  用微信「扫一扫」完成支付，支付后本页自动跳转
                  <br />
                  二维码 {fmtTime(order.codeExpiresAt)} 前有效
                </div>

                {order.mocked && (
                  <button className="btn btn-primary btn-sm" onClick={mockPay} disabled={pending}>
                    {pending ? '处理中…' : '模拟支付成功'}
                  </button>
                )}

                <div className="small muted mono" style={{ wordBreak: 'break-all' }}>单号 {order.outTradeNo}</div>
                {error && <div className="small" style={{ color: 'var(--red)' }}>{error}</div>}
              </div>
            )}
          </div>
        </Overlay>
      )}
    </>
  );
}
