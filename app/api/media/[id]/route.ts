import { getSessionOrNull } from '@/lib/session';
import { readMediaBytes } from '@/lib/media/store';

// 取一张媒体资产的字节。**唯一的出图路径**：预览、下载、右键另存都走它。
//
// 为什么不发 data URL 给前端：一张 2K 封面 base64 之后一两百 KB，塞进 RSC 载荷/HTML 里
// 每次渲染都要传一遍；而且历史列表有十几张，页面会直接胖到不可用。
//
// 鉴权：必须是本工作区的资产。人像照是敏感个人信息，一个能猜 id 就取图的路由等于把它公开了。
// Cache-Control 用 private + no-store：这些图不该进任何共享缓存（CDN / 反代）。

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const s = await getSessionOrNull();
  if (!s) return new Response('请先登录', { status: 401 });
  const { id } = await ctx.params;
  let found: { bytes: Uint8Array; mime: string } | null;
  try {
    found = await readMediaBytes(s.workspaceId, id);
  } catch {
    // 解密失败（换过主密钥 / 密文损坏）：如实报错，不返回一张空图假装没事
    return new Response('图片无法读取', { status: 500 });
  }
  if (!found) return new Response('图片不存在', { status: 404 });
  return new Response(Buffer.from(found.bytes), {
    headers: {
      'Content-Type': found.mime,
      'Content-Length': String(found.bytes.length),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
