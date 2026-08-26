import Link from 'next/link';
import { prisma } from '@/lib/db';
import { LEGAL_VERSION } from '@/lib/legal';
import { ackLegalVersion } from '@/lib/legal/consent-actions';

// 政策更新提示 —— 兑现隐私政策第九节那句「重大变更时会通过站内通知或弹窗方式告知」。
//
// 【为什么现在才有】`Member.consentVersion` 从 2026 年就在写了（注册、公众号登录、
// 装机向导三处），但**从来没有一行代码读过它**。也就是说政策改了多少次，
// 用户那边一次提示都不会有——第九节是一句代码没兑现的承诺。
// 与 lib/legal/removal.ts 文件头记的那个缺口（申请页收下申请、采集链路从不查）同一形状：
// 对外写好的话，代码不接就是假的。2026-08-24 抓取合规审查时一并补上。
//
// 【为什么是横幅不是强制弹窗】判据是这次改动**有没有扩大处理范围**：
//   · 扩大了（新增一类个人信息、新增一个接收方、扩大用途）→ 该走单独同意，
//     那是一次**阻断式**交互，不是这个组件的职责；
//   · 没扩大，只是把已经在做的事说得更准确（2026.08.3 就是这种）→ 告知即可。
// 把「说准确」也做成强制弹窗，会训练用户闭眼点确认，真正需要单独同意那次就没人看了。
// 判断由人做，不由代码猜——所以这里只负责「让用户看见并留痕」。
//
// 【留痕】点「我知道了」把 consentVersion 更新到当前版本，横幅随即消失。
// 不点就一直在（每次进任意页面现算，不依赖任何定时任务，同 ExpiryBanner 的理由）。
export async function LegalUpdateBanner({ memberId }: { memberId: string }) {
  const me = await prisma.member.findUnique({
    where: { id: memberId },
    select: { consentVersion: true },
  });
  // consentVersion 为空 = 建号早于这个字段。不提示：我们无从知道他当时看到的是哪一版，
  // 拿一条「政策更新了」去打扰他，说的是我们自己也不确定的事。
  if (!me?.consentVersion || me.consentVersion === LEGAL_VERSION) return null;

  return (
    <div className="expiry-banner" role="status">
      <span>
        📋 <b>隐私政策与服务条款已更新（{me.consentVersion} → {LEGAL_VERSION}）</b>
        <span className="expiry-banner-body">
          {' '}· 本次说明了公众号竞对采集使用你自己的后台登录态、可能违反微信平台协议；
          补充披露了竞对数据的第三方来源方；并更正了评论正文的表述（去标识化，非匿名化）。
          处理范围没有扩大。
        </span>
      </span>
      <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', whiteSpace: 'nowrap' }}>
        <Link href="/legal/privacy" className="expiry-banner-btn">查看全文 →</Link>
        {/* server action 直接挂 form，不引客户端组件：这条横幅在每个页面的布局里渲染，
            为一个按钮拉一份 client bundle 不值。点完 revalidate 掉当前路由即可消失。 */}
        <form action={ackLegalVersion}>
          <button type="submit" className="expiry-banner-btn">我知道了</button>
        </form>
      </span>
    </div>
  );
}
