import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import http from 'node:http';
import { prisma } from '@/lib/db';

// F1-4 敏感打标的 LLM 复核层。
//
// 本文件锁的是这个项目栽过的那个坑的**同构版本**：
//   「阿里云短信曾是抛错空壳」「AIGC 标识曾只靠提示词无校验回环」——
//   共同的失败模式是「不可用的依赖被静默降级成一句看起来成功的话」。
//   llmComplete 在真实 provider 失败时会**静默降级到 MockProvider**，而 Mock 不做任何判断。
//   如果允许 LLM 下调敏感结论，Mock 的固定文案就能把词库命中的簇「洗白」成不敏感——
//   那就是「没判断」伪装成「判断了不敏感」。这里把「只加不减」钉死。

// 假的 OpenAI 兼容 chat 端点：reply 由每个用例指定
let reply: (prompt: string) => unknown = () => ({ sensitive: [] });
let chatCalls = 0;
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    chatCalls++;
    const j = JSON.parse(body);
    const prompt = j.messages.map((m: { content: string }) => m.content).join('\n');
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(reply(prompt)) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );
  });
});
const port = 45681;
await new Promise<void>((r) => srv.listen(port, r));
afterAll(() => srv.close());

const useRealProvider = () => {
  vi.stubEnv('BEACON_DEFAULT_LLM_BASE_URL', `http://127.0.0.1:${port}/v1`);
  vi.stubEnv('BEACON_DEFAULT_LLM_API_KEY', 'test-key');
};

const hot = (source: string, title: string, heat: number) =>
  prisma.hotItem.create({ data: { source, rank: 1, title, heat } });

beforeEach(async () => {
  await prisma.hotItem.deleteMany();
  await prisma.topicCluster.deleteMany();
  chatCalls = 0;
  vi.unstubAllEnvs();
});

describe('F1-4 LLM 复核 · 只加不减', () => {
  it('LLM 说「不敏感」也不能翻案词库的命中', async () => {
    useRealProvider();
    reply = () => ({ sensitive: [] }); // LLM 一律判不敏感
    await hot('douyin', '重庆彭水山体垮塌已救出10人', 900);
    await hot('toutiao', '重庆山体垮塌已救出10人', 800);

    const rep = await clusterFresh();
    expect(rep.sensitive).toBe(1); // 词库说敏感就是敏感
    const c = await prisma.topicCluster.findFirstOrThrow();
    expect(c.isSensitive).toBe(true);
  });

  it('词库命中的簇根本不送审：结构上就没有被翻案的机会', async () => {
    useRealProvider();
    reply = () => ({ sensitive: [] });
    await hot('douyin', '重庆彭水山体垮塌已救出10人', 900);
    await hot('toutiao', '重庆山体垮塌已救出10人', 800);

    await clusterFresh();
    expect(chatCalls).toBe(0); // 唯一的簇已被词库命中 → 无需送审 → 一次调用都不该发生
  });

  it('LLM 补漏：词库穷举不了的政治人物名，真 provider 在位时应被追加打标', async () => {
    useRealProvider();
    reply = (prompt) => {
      const idx: number[] = [];
      for (const line of prompt.split('\n')) {
        const m = line.match(/^(\d+)\.\s+(.*)$/);
        if (m && /特朗普/.test(m[2])) idx.push(Number(m[1]));
      }
      return { sensitive: idx };
    };
    // 标题取词形相近的两条：dev 是 lexical 降级模式，聚不到一起就没有簇可送审，
    // 那测的就不是「LLM 补漏」而是「聚类召回」了。
    await hot('weibo', '美国发行特朗普纪念币', 900);
    await hot('toutiao', '特朗普纪念币引发争议', 890);

    const rep = await clusterFresh();
    expect(rep.reviewed).toBe('lexicon+llm');
    expect(rep.sensitive).toBe(1);
    expect((await prisma.topicCluster.findFirstOrThrow()).summary).toBeNull();
  });

  it('LLM 返回垃圾/越界下标时，退回词库结论而不是放宽', async () => {
    useRealProvider();
    reply = () => ({ sensitive: [999, -1, 'x'] });
    await hot('douyin', '功夫女足票房破10亿', 900);
    await hot('toutiao', '《功夫女足》上映七天票房破10亿', 800);
    const rep = await clusterFresh();
    expect(rep.sensitive).toBe(0); // 越界下标被丢弃，不炸也不乱标
  });

  it('provider 不可用 → llmComplete 静默降级 Mock → 结论一律不采信（不是「判断了不敏感」）', async () => {
    vi.stubEnv('BEACON_DEFAULT_LLM_BASE_URL', 'http://127.0.0.1:1/v1'); // 必然连不上
    vi.stubEnv('BEACON_DEFAULT_LLM_API_KEY', 'test-key');
    await hot('weibo', '美国发行特朗普纪念币', 900);
    await hot('toutiao', '特朗普纪念币引发争议', 890);
    const rep = await clusterFresh();
    // Mock 的返回值没有信息量：不能让它把这簇「确认」成不敏感。
    // 这里断言的是「不炸 + 保留词库结论」；能不能补上特朗普取决于真 LLM 在不在。
    expect(rep.sensitive).toBe(0);
    expect(rep.clusters).toBe(1);
  });
});

describe('F1-4 · dev 无 key 时不调用 LLM', () => {
  it('Mock provider 在位时一次 LLM 都不发，且 reviewed 如实报 lexicon', async () => {
    await hot('weibo', '美国发行特朗普纪念币', 900);
    await hot('toutiao', '特朗普纪念币引发争议', 890);
    const rep = await clusterFresh();
    expect(chatCalls).toBe(0);
    expect(rep.reviewed).toBe('lexicon'); // 没跑就说没跑
    // 并且诚实地承认：dev 态词库确实漏掉了这条。不假装 Mock 判过了。
    expect(rep.sensitive).toBe(0);
  });
});

// gateway.ts 按模块级缓存决定 provider，需要在 stubEnv 之后再取模块
async function clusterFresh() {
  vi.resetModules();
  const { clusterHotTopics } = await import('@/lib/pipeline');
  return clusterHotTopics();
}
