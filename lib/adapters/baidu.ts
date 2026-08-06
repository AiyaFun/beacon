import type { HotEntry, HotListAdapter } from './types';

// 百度热搜适配器：抓 top.baidu.com/board 页面内嵌的 <!--s-data:...--> JSON。
// 为什么单独做：60s 免费实例没有百度接口（404）、DailyHotApi 的百度返回空占位（要 cookie）——都拿不到。
// 百度官方热搜页的 HTML 里有完整结构化数据（word/rawUrl/hotScore），直接抓这个最稳，且服务器在国内可达。

const BOARD_URL = 'https://top.baidu.com/board?tab=realtime';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

type BaiduItem = { word?: string; url?: string; rawUrl?: string; hotScore?: string; desc?: string };

export class BaiduHotAdapter implements HotListAdapter {
  readonly name = 'baidu-web';
  readonly kind = 'opensource' as const;
  readonly sources = ['baidu'];

  async fetchHot(source: string): Promise<HotEntry[]> {
    if (source !== 'baidu') return [];
    const res = await fetch(BOARD_URL, { signal: AbortSignal.timeout(10_000), headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`baidu HTTP ${res.status}`);
    const html = await res.text();
    const m = html.match(/<!--s-data:([\s\S]*?)-->/);
    if (!m) throw new Error('baidu s-data 未找到（页面结构变化）');
    const data = JSON.parse(m[1]) as { data?: { cards?: { content?: BaiduItem[] }[] } };
    const content = data?.data?.cards?.[0]?.content ?? [];
    const entries = content
      .filter((it) => it.word && it.word.trim())
      .slice(0, 30)
      .map((it, i) => ({
        source: 'baidu',
        rank: i + 1,
        title: it.word!.trim(),
        url: it.rawUrl || it.url,
        heat: Number(it.hotScore) || 0,
        extra: it.desc ? { desc: String(it.desc).slice(0, 120) } : {},
      }));
    if (entries.length === 0) throw new Error('baidu 空数据');
    return entries;
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const res = await fetch(BOARD_URL, { signal: AbortSignal.timeout(6000), headers: { 'User-Agent': UA } });
      return { ok: res.ok, detail: `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }
}
