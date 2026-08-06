import Link from 'next/link';
import { LEGAL_VERSION } from '@/lib/legal';

export const metadata = { title: '付款与订阅协议 — 烽火台' };

export default function PaymentTermsPage() {
  return (
    <article className="legal-article">
      <h1>付款与服务订阅协议</h1>
      <p className="small muted">版本 {LEGAL_VERSION} · 生效日期 2026 年 7 月 1 日</p>

      <h2>一、协议范围与确认</h2>
      <p>
        本《付款与服务订阅协议》（以下简称"本协议"）由您（创作者或企业用户）与烽火台平台（以下简称"本平台"）共同缔结。
        当您在付费购买、续费订阅或使用本平台任何付费功能前，请务必仔细阅读本协议。点击"立即支付"、"订阅"或完成付款即视为您已完全理解并同意本协议条款。
      </p>

      <h2>二、计费模式与套餐服务</h2>
      <h3>2.1 订购模式</h3>
      <ul>
        <li><b>按周期订阅</b>：包含按月订阅与按年订阅。按年订购享有专属折扣优惠。</li>
        <li><b>套餐版本</b>：分为免费版（体验）、标准版（个人/小团队）及企业版（多账号协作与出海模型支持）。各套餐的具体功能与用量配额以购买页面展示为准。</li>
        <li><b>BYOK 自备 Key 模式</b>：平台仅收取 SaaS 工具服务费，大模型 API 实际消耗由您直接向供应商结算，平台不进行任何模型花费加价。</li>
      </ul>

      <h3>2.2 付款方式</h3>
      <p>
        本平台支持微信支付、支付宝及对公打款转账。使用微信支付等第三方支付服务时，您须遵守该第三方的服务条款与隐私政策。
      </p>

      <h2>三、退款政策与权益保障</h2>
      <div className="alert-gradient-green" style={{ padding: 14, borderRadius: 10, margin: '12px 0' }}>
        <div style={{ fontWeight: 600, color: 'var(--green, #10b981)', fontSize: 14 }}>
          🛡️ 消费权益承诺：7 天内满意保证与灵活退订
        </div>
        <div className="small muted" style={{ marginTop: 2 }}>
          我们为您提供透明、无忧的退款与订阅退订保障。
        </div>
      </div>
      <ul>
        <li><b>7 天无理由退款</b>：新购付费套餐 7 天内，若您未大量消耗系统高级 API 额度，可随时申请全额退款。</li>
        <li><b>退款处理时限</b>：提交退款申请后，本平台将在 1-3 个工作日内完成审核并原路退回至您的支付账户。</li>
        <li><b>中途退订说明</b>：按年订阅用户使用满 7 天后申请退订的，将扣除已使用月份的标准月费后，结余部分原路退还。</li>
      </ul>

      <h2>四、套餐变更、升级与续费</h2>
      <ul>
        <li><b>套餐升级</b>：购买期间您可以随时升级套餐，系统将按剩余天数折算补差价，升级后立即生效。</li>
        <li><b>到期续费</b>：订阅到期前系统会通过邮件/微信/站内信提醒续费。到期未续费账户将自动降级至免费版，您的数据与人设记忆保留 90 天。</li>
      </ul>

      <h2>五、发票开具说明</h2>
      <p>
        用户累计付费满 100 元可申请开具增值税电子普通发票或增值税电子专用发票（开票项目为"软件服务费"或"信息技术服务费"）。发票将在提交申请后 5 个工作日内发送至您的指定邮箱。
      </p>

      <h2>六、违约与服务终止</h2>
      <p>
        若您存在违规共享账号、利用支付接口恶意刷单退款或违反《服务条款》行为，本平台有权立即终止付费服务且不予退款，并保留追究法律责任的权利。
      </p>

      <div className="legal-nav">
        <Link href="/legal/terms">← 服务条款</Link>
        <span style={{ margin: '0 8px', color: 'var(--muted, #94a3b8)' }}>·</span>
        <Link href="/legal/privacy">隐私政策</Link>
        <span style={{ margin: '0 8px', color: 'var(--muted, #94a3b8)' }}>·</span>
        <Link href="/legal/data-request">数据移除申请 →</Link>
      </div>
    </article>
  );
}
