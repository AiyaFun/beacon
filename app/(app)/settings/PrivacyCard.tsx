import Link from 'next/link';
import { Card } from '@/components/ui';
import { Icon } from '@/components/icons';

export function PrivacyCard() {
  return (
    <Card
      title="隐私与数据安全声明"
      sub="保护每个人的隐私数据，隐私安全卫士 提供数据保护"
      action={
        <span
          className="badge badge-green"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 20 }}
        >
          <Icon.shield size={13} /> 隐私安全卫士
        </span>
      }
      style={{ marginBottom: 16 }}
    >
      <div className="alert-gradient-green" style={{ padding: 14, borderRadius: 10, marginBottom: 14 }}>
        <div className="row" style={{ gap: 10, alignItems: 'center' }}>
          <span style={{ fontSize: 20, flexShrink: 0 }}>🛡️</span>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--green, #10b981)' }}>
              保护每个人的隐私数据，隐私安全卫士 提供数据保护
            </div>
            <div className="small muted" style={{ marginTop: 2 }}>
              烽火台高度重视用户及创作者隐私，所有数据存储、传输与 AI 模型调用均由「隐私安全卫士」全程进行隔离与加密守护。
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-3" style={{ gap: 12 }}>
        <div
          style={{
            background: 'var(--surface-2)',
            padding: 12,
            borderRadius: 8,
            border: '1px solid var(--surface-3, rgba(255,255,255,0.06))',
          }}
        >
          <div className="row" style={{ gap: 6, alignItems: 'center', fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
            <span>🔒 租户绝对隔离</span>
          </div>
          <p className="small muted" style={{ margin: 0, lineHeight: 1.6 }}>
            跨租户数据物理/逻辑双重隔离，工作区数据、人设记忆与草稿仅对授权成员可见。
          </p>
        </div>

        <div
          style={{
            background: 'var(--surface-2)',
            padding: 12,
            borderRadius: 8,
            border: '1px solid var(--surface-3, rgba(255,255,255,0.06))',
          }}
        >
          <div className="row" style={{ gap: 6, alignItems: 'center', fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
            <span>🔑 API 密钥安全</span>
          </div>
          <p className="small muted" style={{ margin: 0, lineHeight: 1.6 }}>
            自备模型 Key（BYOK）采用 AES-256 存储加密，只写不读，仅在进行 AI 推理时解密传输。
          </p>
        </div>

        <div
          style={{
            background: 'var(--surface-2)',
            padding: 12,
            borderRadius: 8,
            border: '1px solid var(--surface-3, rgba(255,255,255,0.06))',
          }}
        >
          <div className="row" style={{ gap: 6, alignItems: 'center', fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
            <span>🌐 公开数据合规采集</span>
          </div>
          <p className="small muted" style={{ margin: 0, lineHeight: 1.6 }}>
            他人的内容只分析已公开发布的作品与热榜趋势；你自己的作品数据来自你本人已登录的创作者后台（含完播率/完读率这类只有后台才有的数字），只进你自己的工作区。任何情况下都不获取他人的非公开数据、不托管平台凭证。
          </p>
        </div>
      </div>

      <div className="row-between wrap" style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--surface-2)', gap: 10 }}>
        <span className="small muted">了解更多关于烽火台的数据处理准则与隐私规范：</span>
        <div className="row" style={{ gap: 14 }}>
          <Link href="/legal/privacy" target="_blank" className="small" style={{ color: 'var(--brand)', fontWeight: 600, textDecoration: 'none' }}>
            查看《隐私政策》 →
          </Link>
          <Link href="/legal/data-request" target="_blank" className="small" style={{ color: 'var(--brand)', fontWeight: 600, textDecoration: 'none' }}>
            数据移除申请 →
          </Link>
        </div>
      </div>
    </Card>
  );
}
