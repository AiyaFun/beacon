import { NextResponse } from 'next/server';
import { readDownloadsManifest, storeLinks, storeVersion, CHROME_STORE_URL } from '@/lib/downloads';

// 插件版本探询：插件用它判断「有没有新版」并给出一键更新的落点。
//
// 为什么不让插件直接读 /downloads/downloads.manifest.json：那是 Next 的静态文件，
// **不带 CORS 头**，service worker 去 fetch 会被浏览器挡下（插件没有 host 权限，
// 全靠接口侧 `Access-Control-Allow-Origin: *`）。所以这里包一层同样开放的 API。
//
// 🔓 无需鉴权：回的只有版本号、公开 zip 地址、商店链接——都是任何人都能从下载页看到的东西。
//   在 middleware 的 PUBLIC_PATHS 里（/api/ingest/self 之类同级前缀不覆盖本路径，见下方说明）。

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
  // 版本探询要拿到最新值，别让中间层缓存住旧版本号（用户会看到「已是最新」却其实不是）
  'Cache-Control': 'no-store',
};

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET() {
  const m = readDownloadsManifest();
  return NextResponse.json(
    {
      ok: true,
      // 自托管 zip（永远是最新版）
      latest: m?.version ?? null,
      zipUrl: m?.zip ?? null,
      latestUrl: m?.latest ?? null,
      sha256: m?.sha256 ?? null,
      sizeKB: m?.sizeKB ?? null,
      // 商店版（审核有周期，天然滞后；版本号只有运维登记过才给，不猜）
      storeUrl: storeLinks().chrome || CHROME_STORE_URL,
      storeVersion: storeVersion(),
    },
    { headers: CORS },
  );
}
