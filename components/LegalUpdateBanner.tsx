import Link from 'next/link';
import { prisma } from '@/lib/db';
import { LEGAL_VERSION } from '@/lib/legal';
import { ackLegalVersion } from '@/lib/legal/consent-actions';
import { getServerLang } from '@/lib/i18n/server';

export async function LegalUpdateBanner({ memberId }: { memberId: string }) {
  const me = await prisma.member.findUnique({
    where: { id: memberId },
    select: { consentVersion: true },
  });
  if (!me?.consentVersion || me.consentVersion === LEGAL_VERSION) return null;
  const lang = await getServerLang();
  const isEn = lang === 'en';

  return (
    <div className="expiry-banner" role="status">
      <span>
        📋 <b>{isEn ? `Privacy Policy & Terms Updated (${me.consentVersion} → ${LEGAL_VERSION})` : `隐私政策与服务条款已更新（${me.consentVersion} → ${LEGAL_VERSION}）`}</b>
        <span className="expiry-banner-body">
          {isEn
            ? ' · Disclosed WeChat competitor collection login context; added third-party competitor data sources; clarified comment text de-identification. Processing scope remains unexpanded.'
            : ' · 本次说明了公众号竞对采集使用你自己的后台登录态、可能违反微信平台协议；补充披露了竞对数据的第三方来源方；并更正了评论正文的表述（去标识化，非匿名化）。处理范围没有扩大。'}
        </span>
      </span>
      <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', whiteSpace: 'nowrap' }}>
        <Link href="/legal/privacy" className="expiry-banner-btn">{isEn ? 'View Details →' : '查看全文 →'}</Link>
        {/* server action 直接挂 form，不引客户端组件：这条横幅在每个页面的布局里渲染，
            为一个按钮拉一份 client bundle 不值。点完 revalidate 掉当前路由即可消失。 */}
        <form action={ackLegalVersion}>
          <button type="submit" className="expiry-banner-btn">{isEn ? 'I Acknowledge' : '我知道了'}</button>
        </form>
      </span>
    </div>
  );
}
