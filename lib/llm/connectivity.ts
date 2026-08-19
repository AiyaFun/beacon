import { AUTH_ERROR_RE, looksNonChatModel } from '../constants';
import { OpenAICompatibleProvider } from './openai-compatible';

// 渠道连通性测试的**唯一实现**。
//
// 【为什么要抽出来】同一段「ping 一下、图像/视频模型特判、失败取前 120 字」此前被抄了三份：
// 租户设置页、运维台平台渠道、以及新的一键检测。三份意味着三种判定——
// 最容易漂的正是那个特判：图像模型本来就不吃对话请求，哪一份忘了它，那条渠道就会被判 failed，
// 然后被读侧的 `status: { not: 'failed' }` 排除掉，用户的封面突然就不能生成了。

export type PingResult = { ok: boolean; status: 'ok' | 'failed'; detail: string };

/**
 * 给一条渠道发一次最小对话请求。
 *
 * nonChat=true（图像/视频模型）时的口径：**只要不是鉴权错误就算通**。
 * 这类模型收到 /chat/completions 会报「模型不支持」，那说明 Key 到得了服务端、端点是活的；
 * 判它 failed 会把一条完全可用的生图渠道排除出选路。
 */
export async function pingProvider(p: {
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 显式路由到 image/video，或模型名一看就不是对话模型 */
  nonChat?: boolean;
}): Promise<PingResult> {
  const nonChat = p.nonChat ?? looksNonChatModel(p.model);
  const provider = new OpenAICompatibleProvider({
    name: p.label,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    model: p.model,
  });
  try {
    await provider.complete([{ role: 'user', content: 'ping' }], { temperature: 0 });
    return { ok: true, status: 'ok', detail: '连通正常' };
  } catch (e) {
    const msg = (e as Error).message;
    if (nonChat && !AUTH_ERROR_RE.test(msg)) {
      return {
        ok: true,
        status: 'ok',
        detail: '这是图像/视频模型，未做对话测试；Key 可达服务端。出图/拆解时才会真实调用（一次调用要花钱，测试不代扣）。',
      };
    }
    return { ok: false, status: 'failed', detail: msg.slice(0, 120) };
  }
}
