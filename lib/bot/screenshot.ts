import { prisma } from '../db';
import { llmVision } from '../llm/gateway';
import { parseJson } from '../json';
import { PLATFORMS } from '../constants';
import { ingestOwnPostData, ownPostIngestSchema } from '../ingest/own-post';

// 截图 → 自有作品表现数据（需求④扩展）。
//
// 链路：群里发一张创作者后台截图 → 视觉模型读出指标 → 复用 ingestOwnPostData 入库
//       （对齐已登记发布记录 / 合并 metrics / 落 PerformanceSnapshot / 触发学习与预警）。
//
// 这条路和其它 AI 功能有个本质区别：**产物会被写进表现基线**。
// 所以通篇的取舍都是「宁可不写，不可写错」：
//   · 没配视觉模型 / 调用失败 → 如实报错，绝不用 Mock 兜底（假数字会永久污染学习信号）
//   · 读不到的字段一律省略，不猜、不填 0（0 会被当成「真的是 0」参与均值和爆款判定）
//   · 平台识别不出来 → 让用户明说，不瞎猜一个
//
// 上限：单次一张图，最多 20 条作品——截图里塞不下更多，超出多半是模型在编。

const MAX_POSTS = 20;

const SYSTEM = `你是创作者后台数据的识图助手。用户会发一张创作者后台/数据中心的截图，请把上面的作品数据原样读出来。

只输出 JSON，格式：
{
  "platform": "douyin|xiaohongshu|bilibili|wechat_mp|kuaishou|weibo|zhihu|youtube|tiktok|shipinhao",
  "posts": [
    {
      "platformItemId": "作品ID或链接末段；读不到就用标题",
      "title": "作品标题",
      "metrics": {
        "views": 播放/浏览量,
        "likes": 点赞,
        "comments": 评论,
        "shares": 分享,
        "collects": 收藏,
        "impressions": 曝光量,
        "completion": 完播率或完读率（0-1 的小数，或写百分数如 42.3）
      }
    }
  ],
  "confidence": 0.0
}

铁律：
1. **只读你在图上真实看到的数字。看不清、图里没有的字段，直接省略这个键——绝对不要填 0、不要估算、不要补全。**
2. 数字带「万/w/k/万次」等单位的，换算成整数（1.2万 → 12000）。
3. 平台认不出来就把 platform 设为空字符串。
4. 这张图如果根本不是创作者后台数据（是聊天记录、风景照、表情包等），返回 {"posts":[],"confidence":0}。
5. confidence 是你对整体读数准确度的把握（0~1）。看不清、反光、糊了就给低分。`;

export type ScreenshotResult =
  | { ok: true; platform: string; updated: number; created: number; skipped: number; count: number; confidence: number }
  | { ok: false; error: string; reason: 'no_vision_model' | 'vision_failed' | 'not_data' | 'low_confidence' | 'bad_platform' | 'ingest_failed' };

/** 置信度低于此值不入库——读错的指标比没有指标更糟，它会静默带偏学习和预警。 */
const MIN_CONFIDENCE = 0.6;

export async function ingestScreenshot(
  workspaceId: string,
  image: { data: Buffer; mime: string },
): Promise<ScreenshotResult> {
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { tenantId: true } });
  if (!ws) return { ok: false, reason: 'ingest_failed', error: '工作区不存在' };

  const dataUri = `data:${image.mime};base64,${image.data.toString('base64')}`;
  const res = await llmVision(
    ws.tenantId,
    [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: [
          { type: 'text', text: '读出这张创作者后台截图里的作品数据。' },
          { type: 'image_url', image_url: { url: dataUri } },
        ],
      },
    ],
    { json: true, temperature: 0 },
  );

  if (!res.ok) {
    return res.reason === 'not_configured'
      ? { ok: false, reason: 'no_vision_model', error: res.error }
      : { ok: false, reason: 'vision_failed', error: res.error };
  }

  const parsed = parseJson<{ platform?: string; posts?: unknown[]; confidence?: number }>(res.text, {});
  const posts = Array.isArray(parsed.posts) ? parsed.posts.slice(0, MAX_POSTS) : [];
  if (posts.length === 0) {
    return { ok: false, reason: 'not_data', error: '这张图里没读到作品数据' };
  }

  const confidence = Number(parsed.confidence ?? 0);
  if (!Number.isFinite(confidence) || confidence < MIN_CONFIDENCE) {
    return { ok: false, reason: 'low_confidence', error: `读数把握不足（${confidence.toFixed(2)}），没有入库` };
  }

  const platform = String(parsed.platform ?? '').trim();
  if (!platform || !(platform in PLATFORMS)) {
    return { ok: false, reason: 'bad_platform', error: '认不出这是哪个平台的后台' };
  }

  // 交给既有的 zod schema 做最终把关：它会剔掉非法数值、把 completion 归一化到 0-1、
  // 丢弃无指标的条目。模型编出来的脏数据在这一层还能再被拦一道。
  const payload = ownPostIngestSchema.safeParse({ platform, posts });
  if (!payload.success) {
    return { ok: false, reason: 'ingest_failed', error: '识别结果不符合数据格式' };
  }

  const r = await ingestOwnPostData(workspaceId, payload.data);
  if (!r.ok) return { ok: false, reason: 'ingest_failed', error: r.error };

  return {
    ok: true,
    platform,
    updated: r.updated,
    created: r.created,
    skipped: r.skipped,
    count: payload.data.posts.length,
    confidence,
  };
}

/** 把入库结果说成人话，发回群里。 */
export function describeScreenshotResult(r: ScreenshotResult): string {
  if (r.ok) {
    const name = (PLATFORMS as Record<string, { name?: string }>)[r.platform]?.name ?? r.platform;
    const parts = [`✅ 已从截图读到 ${r.count} 条${name}作品数据`];
    if (r.updated) parts.push(`更新 ${r.updated} 条已登记作品`);
    if (r.created) parts.push(`新建 ${r.created} 条记录`);
    if (r.skipped) parts.push(`跳过 ${r.skipped} 条（没读到指标）`);
    parts.push(`识别把握 ${Math.round(r.confidence * 100)}%`);
    return parts.join('，') + '。\n数据看板已更新，读错的话去看板里手工改即可。';
  }
  switch (r.reason) {
    case 'no_vision_model':
      return '这台服务器还没配视觉模型，暂时读不了截图。让管理员设置 BEACON_VISION_LLM_MODEL 后即可使用。';
    case 'vision_failed':
      return `识图失败：${r.error}`;
    case 'not_data':
      return '没在这张图里找到作品数据。请发创作者后台/数据中心那一屏（要能看到作品标题和播放、点赞等数字）。';
    case 'low_confidence':
      return `${r.error}。图有点糊或反光，换一张更清晰的截图试试——读错的数据会带偏后续的表现分析，所以宁可不入库。`;
    case 'bad_platform':
      return '认不出这是哪个平台的后台。可以在发图时附一句「抖音」「小红书」等平台名。';
    default:
      return `入库失败：${r.error}`;
  }
}
