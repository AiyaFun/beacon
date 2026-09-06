import Link from 'next/link';
import { Card } from '@/components/ui';
import { Icon } from '@/components/icons';
import { getServerLang } from '@/lib/i18n/server';

export async function PrivacyCard() {
  const lang = await getServerLang();
  const isEn = lang === 'en';

  return (
    <Card
      title={isEn ? 'Privacy & Data Security Statement' : '隐私与数据安全声明'}
      sub={isEn ? "Protecting everyone's private data · Privacy Guardian provides protection" : '保护每个人的隐私数据，隐私安全卫士 提供数据保护'}
      action={
        <span
          className="badge badge-green"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 20 }}
        >
          <Icon.shield size={13} /> {isEn ? 'Privacy Guardian' : '隐私安全卫士'}
        </span>
      }
      style={{ marginBottom: 16 }}
    >
      <div className="alert-gradient-green" style={{ padding: 14, borderRadius: 10, marginBottom: 14 }}>
        <div className="row" style={{ gap: 10, alignItems: 'center' }}>
          <span style={{ fontSize: 20, flexShrink: 0 }}>🛡️</span>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--green, #10b981)' }}>
              {isEn ? "Protecting everyone's private data · Privacy Guardian provides data protection" : '保护每个人的隐私数据，隐私安全卫士 提供数据保护'}
            </div>
            <div className="small muted" style={{ marginTop: 2 }}>
              {isEn
                ? 'Beacon places high priority on user and creator privacy. All data storage, transmission, and AI model calls are isolated and encrypted under Privacy Guardian.'
                : '烽火台高度重视用户及创作者隐私，所有数据存储、传输与 AI 模型调用均由「隐私安全卫士」全程进行隔离与加密守护。'}
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
            <span>🔒 {isEn ? 'Strict Tenant Isolation' : '租户绝对隔离'}</span>
          </div>
          <p className="small muted" style={{ margin: 0, lineHeight: 1.6 }}>
            {isEn
              ? 'Cross-tenant dual physical/logical isolation. Workspace data, persona memories, and drafts are only visible to authorized members.'
              : '跨租户数据物理/逻辑双重隔离，工作区数据、人设记忆与草稿仅对授权成员可见。'}
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
            <span>🔑 {isEn ? 'API Key Security' : 'API 密钥安全'}</span>
          </div>
          <p className="small muted" style={{ margin: 0, lineHeight: 1.6 }}>
            {isEn
              ? 'Bring Your Own Key (BYOK) uses AES-256 storage encryption, write-only, and is only decrypted in-memory during AI inference.'
              : '自备模型 Key（BYOK）采用 AES-256 存储加密，只写不读，仅在进行 AI 推理时解密传输。'}
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
            <span>🌐 {isEn ? 'Compliant Public Ingestion' : '公开数据合规采集'}</span>
          </div>
          <p className="small muted" style={{ margin: 0, lineHeight: 1.6 }}>
            {isEn
              ? "Other creators' content only analyzes published works and trending rankings. Your own performance data comes from your logged-in creator dashboards, stored strictly in your own workspace. Under no circumstances do we access others' non-public data or hold third-party credentials."
              : '他人的内容只分析已公开发布的作品与热榜趋势；你自己的作品数据来自你本人已登录的创作者后台（含完播率/完读率这类只有后台才有的数字），只进你自己的工作区。任何情况下都不获取他人的非公开数据、不托管平台凭证。'}
          </p>
        </div>
      </div>

      <div className="row-between wrap" style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--surface-2)', gap: 10 }}>
        <span className="small muted">{isEn ? 'Learn more about Beacon data processing and privacy guidelines: ' : '了解更多关于烽火台的数据处理准则与隐私规范：'}</span>
        <div className="row" style={{ gap: 14 }}>
          <Link href="/legal/privacy" target="_blank" className="small" style={{ color: 'var(--brand)', fontWeight: 600, textDecoration: 'none' }}>
            {isEn ? 'View Privacy Policy →' : '查看《隐私政策》 →'}
          </Link>
          <Link href="/legal/data-request" target="_blank" className="small" style={{ color: 'var(--brand)', fontWeight: 600, textDecoration: 'none' }}>
            {isEn ? 'Data Removal Request →' : '数据移除申请 →'}
          </Link>
        </div>
      </div>
    </Card>
  );
}
