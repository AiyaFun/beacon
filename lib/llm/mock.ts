import { messageText, type ChatMessage, type LlmProvider, type LlmResult } from './types';

// 确定性 Mock provider：无需任何 API Key 即可跑通全流程，输出可解析的结构化假数据。
// 通过读取 prompt 中的意图关键字，返回对应形态的内容。

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function pick<T>(arr: T[], seed: number): T {
  return arr[seed % arr.length];
}

export class MockProvider implements LlmProvider {
  readonly name = 'mock';
  readonly model = 'beacon-mock-v1';
  readonly mocked = true;

  async complete(messages: ChatMessage[], opts?: { json?: boolean; timeoutMs?: number }): Promise<LlmResult> {
    const prompt = messages.map((m) => messageText(m.content)).join('\n');
    const seed = hash(prompt);
    const text = this.route(prompt, seed, !!opts?.json);
    return {
      text,
      provider: this.name,
      model: this.model,
      mocked: true,
      usage: { promptTokens: Math.round(prompt.length / 3), completionTokens: Math.round(text.length / 3) },
    };
  }

  async *stream(messages: ChatMessage[]): AsyncIterable<string> {
    const prompt = messages.map((m) => messageText(m.content)).join('\n');
    const seed = hash(prompt);
    const text = this.route(prompt, seed, false);
    const chunks = text.split(/(?<=[。，\n])|(?<=\s)/);
    for (const chunk of chunks) {
      await new Promise((r) => setTimeout(r, 30));
      yield chunk;
    }
  }

  private route(prompt: string, seed: number, json: boolean): string {
    // 合规改写
    if (prompt.includes('合规') || prompt.includes('改写') || prompt.includes('敏感词')) {
      return '这里是一段更稳妥的表达：把绝对化的措辞换成可验证的具体描述，删除了违规承诺，并补充了「个人体验，仅供参考」的说明。整体语气保留原风格，风险已降低。';
    }
    // 选题打分（精排）
    if (prompt.includes('打分') || prompt.includes('评分') || (prompt.includes('差异') && prompt.includes('角度'))) {
      const angles = [
        '从"反常识"切入：多数人都做错的那一步',
        '从"亲身翻车"切入：我踩过的坑与代价',
        '从"对比实验"切入：A方案 vs B方案实测',
        '从"人群细分"切入：只讲给刚入行的人听',
        '从"时效热点"切入：结合本周最新变化',
      ];
      const obj = {
        angle: pick(angles, seed),
        scores: {
          traffic: 60 + (seed % 40),
          personaFit: 55 + (seed % 45),
          cost: 40 + (seed % 50),
          monetization: 45 + (seed % 45),
          compliance: 70 + (seed % 30),
          differentiation: 50 + (seed % 50),
        },
        rationale: '热点相关性高，与账号人设方向一致，制作成本可控；建议用差异化切入角避开同质化红海。',
      };
      return JSON.stringify(obj);
    }
    // 12 人物智囊团
    if (prompt.includes('智囊团') || prompt.includes('人物视角') || prompt.includes('会诊')) {
      return JSON.stringify({
        suggestion: pick(
          [
            '做一期"新手最容易忽略的3个细节"，用清单体降低理解门槛',
            '拍一条"我最初的失败版本 vs 现在"的对比，真实感拉满',
            '蹭本周热点，但从你独有的行业视角二次解读',
            '针对25-30岁初入行人群，做一个"避坑指南"系列',
          ],
          seed,
        ),
        rationale: '结合账号人设与当前热点，这个方向兼顾流量与差异化。',
      });
    }
    // 文案生成
    if (prompt.includes('文案') || prompt.includes('初稿') || prompt.includes('生成一篇') || prompt.includes('创作')) {
      return [
        '【开头钩子】你以为这件事很简单？我一开始也这么想，直到踩了三个坑。',
        '',
        '第一，别急着追求完美，先跑通最小闭环。',
        '第二，把注意力放在"用户为什么点进来"，而不是"我想说什么"。',
        '第三，复盘比努力更重要——每条内容都留一个可改进点。',
        '',
        '【结尾引导】如果这条对你有用，点个收藏，下期讲具体怎么落地。',
      ].join('\n');
    }
    // 话题聚类/摘要
    if (prompt.includes('聚类') || prompt.includes('摘要') || prompt.includes('总结')) {
      return '本话题在多个平台同时升温，核心讨论集中在实用建议与真实体验分享，适合做成"经验复盘 + 可执行清单"形态的内容。';
    }
    // 助手对话
    if (json) {
      return JSON.stringify({ reply: '（Mock）已理解你的需求，建议从人设匹配度最高的两个热点切入。' });
    }
    return '（Mock 回复）已根据你的人设与当前热点给出建议：优先做差异化切入角、控制制作成本、发布前过一遍合规检测。填入真实模型 API Key 后，这里会返回真实生成内容。';
  }
}
