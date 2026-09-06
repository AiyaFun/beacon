import Link from 'next/link';
import { getServerLang } from '@/lib/i18n/server';

export default async function NotFound() {
  const lang = await getServerLang();
  const isEn = lang === 'en';

  return (
    <div style={{ minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ textAlign: 'center', maxWidth: 400 }}>
        <div style={{ fontSize: 64, marginBottom: 16 }}>🔍</div>
        <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>
          {isEn ? 'Page Not Found' : '页面不存在'}
        </h1>
        <p style={{ color: 'var(--text-2)', fontSize: 14, lineHeight: 1.7, marginBottom: 24 }}>
          {isEn
            ? 'The page you are looking for might have been removed or the URL is incorrect.'
            : '你访问的页面可能已被移除或地址有误。'}
        </p>
        <Link href="/" className="btn btn-primary">
          {isEn ? 'Back to Home' : '回到首页'}
        </Link>
      </div>
    </div>
  );
}
