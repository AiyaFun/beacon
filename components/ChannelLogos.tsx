// 消息渠道的品牌标（2026-09-01 用户要求「对应的 logo 也加上」）。
//
// 【为什么手写内联 SVG】与 components/icons.tsx 同一个理由：零外部依赖、CSP 友好、
// 不为六个图标引一个图标库。Telegram/Slack/微信的官方标是公认几何形，能画得准；
// 飞书/钉钉/企微的官方标是复杂曲线，硬描只会得到一只残废的鸟——用**品牌色底 + 简化形**，
// 识别度主要来自颜色与轮廓，不来自笔画级还原。
//
// 【为什么底色是实色品牌色】渠道卡的头像位要一眼分得开六个渠道，
// 实色圆 + 白标的对比度最稳（浅色 tint 底在 surface-2 上会糊成一片）。

type LogoProps = { size?: number };

const wrap = (bg: string, size: number, children: React.ReactNode) => (
  <span
    aria-hidden
    style={{
      width: size, height: size, borderRadius: '50%', background: bg,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    }}
  >
    <svg width={size * 0.56} height={size * 0.56} viewBox="0 0 24 24" fill="none">{children}</svg>
  </span>
);

/** 飞书：品牌蓝 + 纸鸢形（官方标的简化轮廓） */
const Feishu = ({ size = 40 }: LogoProps) =>
  wrap('#3370FF', size, (
    <>
      <path d="M3 11.2 21 4l-7.2 16.5-2.9-6.6L3 11.2z" fill="#fff" />
      <path d="M21 4 10.9 13.9" stroke="#3370FF" strokeWidth="1.1" />
    </>
  ));

/** 钉钉：品牌蓝 + 燕翼形（官方「翼」的简化轮廓） */
const Dingtalk = ({ size = 40 }: LogoProps) =>
  wrap('#0089FF', size, (
    <>
      <path d="M20.6 5.2C15.8 2.4 8.6 3.4 4.9 7.9c3.3.3 6.5 1.3 9 3L20.6 5.2z" fill="#fff" />
      <path d="M13 12.6c-2-1.4-4.7-2.3-7.4-2.6-1.4 2.8-1.3 6.2.5 8.9 1.6-2.7 4-4.9 6.9-6.3z" fill="#fff" opacity=".92" />
      <path d="M14.6 13.8c-2.6 1.4-4.7 3.5-6.1 6 2.9.9 6.2.4 8.7-1.5l-2.6-4.5z" fill="#fff" opacity=".84" />
    </>
  ));

/** 企业微信：微信家族的气泡形，但用企微蓝——与个人微信（绿）刻意拉开 */
const Wecom = ({ size = 40 }: LogoProps) =>
  wrap('#0082EF', size, (
    <>
      <path d="M12 4.2c-4.6 0-8.3 3-8.3 6.7 0 2.1 1.2 4 3 5.2l-.7 2.6 2.9-1.5c1 .3 2 .4 3.1.4 4.6 0 8.3-3 8.3-6.7S16.6 4.2 12 4.2z" fill="#fff" />
      <circle cx="9.1" cy="10.9" r="1.15" fill="#0082EF" />
      <circle cx="14.9" cy="10.9" r="1.15" fill="#0082EF" />
    </>
  ));

/** Telegram：官方纸飞机 */
const Telegram = ({ size = 40 }: LogoProps) =>
  wrap('#229ED9', size, (
    <path
      d="M20.7 4.2 3.9 10.7c-1.1.4-1 1.6.1 2l4.3 1.3 1.6 5c.3 1 1.5 1.2 2.1.4l2.3-2.7 4.4 3.2c.8.6 1.9.2 2.1-.8l2.2-13.2c.2-1.2-.9-2.1-2.3-1.7zM9.4 13.7l8.5-5.4c.4-.2.7.3.4.6l-7 6.5-.3 3-1.6-4.7z"
      fill="#fff"
    />
  ));

/** Slack：四色风车（官方标的几何构成：四组「药丸 + 圆点」旋转 90°） */
const Slack = ({ size = 40 }: LogoProps) =>
  wrap('#FFFFFF', size, (
    <>
      <g fill="#36C5F0"><rect x="9.1" y="2.2" width="3" height="7.4" rx="1.5" /><circle cx="6.3" cy="8.1" r="1.5" /></g>
      <g fill="#2EB67D"><rect x="14.4" y="9.1" width="7.4" height="3" rx="1.5" /><circle cx="15.9" cy="6.3" r="1.5" /></g>
      <g fill="#ECB22E"><rect x="11.9" y="14.4" width="3" height="7.4" rx="1.5" /><circle cx="17.7" cy="15.9" r="1.5" /></g>
      <g fill="#E01E5A"><rect x="2.2" y="11.9" width="7.4" height="3" rx="1.5" /><circle cx="8.1" cy="17.7" r="1.5" /></g>
    </>
  ));

/** 微信：官方双气泡（大小泡 + 各两只眼） */
const Wechat = ({ size = 40 }: LogoProps) =>
  wrap('#07C160', size, (
    <>
      <path d="M9.8 3.6C5.7 3.6 2.4 6.3 2.4 9.7c0 1.9 1 3.5 2.7 4.7l-.7 2.3 2.6-1.4c.6.2 1.3.3 2 .3-.1-.4-.1-.8-.1-1.2 0-3.3 3.2-6 7.1-6h.5c-.7-2.8-3.5-4.8-6.7-4.8z" fill="#fff" />
      <path d="M21.6 14.4c0-2.8-2.7-5-6-5s-6 2.2-6 5 2.7 5 6 5c.7 0 1.4-.1 2-.3l2.2 1.2-.6-2c1.4-.9 2.4-2.3 2.4-3.9z" fill="#fff" />
      <circle cx="7.5" cy="8.4" r="1" fill="#07C160" /><circle cx="12" cy="8.4" r="1" fill="#07C160" />
      <circle cx="13.7" cy="13.6" r=".9" fill="#07C160" /><circle cx="17.6" cy="13.6" r=".9" fill="#07C160" />
    </>
  ));

const LOGOS: Record<string, (p: LogoProps) => React.ReactNode> = {
  feishu: Feishu, dingtalk: Dingtalk, wecom: Wecom, telegram: Telegram, slack: Slack, wechat: Wechat,
  wechat_kf: Wechat, // 微信客服也用微信标——用户认的是「微信」，kf 是实现细节
};

/** 渠道品牌标。认不出的 key 退回首字圆标——新渠道漏配 logo 不该渲染成空白。 */
export function ChannelLogo({ provider, size = 40, fallback }: { provider: string; size?: number; fallback?: string }) {
  const L = LOGOS[provider];
  if (L) return <>{L({ size })}</>;
  return (
    <span
      aria-hidden
      className="persona-avatar"
      style={{ width: size, height: size, background: 'var(--brand-soft)', fontSize: size * 0.4 }}
    >
      {(fallback ?? provider).slice(0, 1)}
    </span>
  );
}
