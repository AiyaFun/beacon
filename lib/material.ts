import { prisma } from './db';
import { parseJson } from './json';

export type MaterialEntry = {
  type: string;
  content: string;
  tags: string[];
};

const TYPE_LABELS: Record<string, string> = {
  experience: '经历',
  case: '案例',
  opinion: '观点',
  catchphrase: '口头禅',
  sample: '文风样本',
};

// 「写什么」类素材：能作为内容原料被引用的那几类。
// 口头禅与文风样本**不在其列**——它们回答的是「怎么说」，塞进素材块会被模型当成可引用的事实，
// 于是稿子里冒出一句「正如我常说的…」，或者干脆把样本正文的内容当成用户的经历抄进去。
const CONTENT_TYPES = new Set(['experience', 'case', 'opinion']);

export async function loadMaterials(accountId: string): Promise<MaterialEntry[]> {
  const items = await prisma.material.findMany({
    where: { accountId },
    orderBy: { updatedAt: 'desc' },
    take: 40,
  });
  return items.map((m) => ({
    type: m.type,
    content: m.content,
    tags: parseJson<string[]>(m.tags, []),
  }));
}

export function materialPromptBlock(materials: MaterialEntry[]): string {
  const usable = materials.filter((m) => CONTENT_TYPES.has(m.type));
  if (usable.length === 0) return '';
  const lines = usable.map((m) => {
    const label = TYPE_LABELS[m.type] || m.type;
    const tagStr = m.tags.length > 0 ? ` [${m.tags.join(', ')}]` : '';
    return `- 【${label}】${m.content.slice(0, 300)}${tagStr}`;
  });
  return `【素材库】以下是用户的真实经历与观点素材，生成内容时可引用以增强差异化与真实感：\n${lines.join('\n')}`;
}

// 口头禅块：**语气资产，不是内容素材**（与 topic/sources/material.ts 同一判断）。
// 单独成块的理由很实在：混在素材里时，模型要么完全无视，要么把它当成一条可以论证的观点。
// 单列出来并写明用法，它才会出现在该出现的位置——一句话的收尾、一个转折的口气。
export function catchphrasePromptBlock(materials: MaterialEntry[]): string {
  const list = materials.filter((m) => m.type === 'catchphrase').slice(0, 8);
  if (list.length === 0) return '';
  return [
    '【他的口头禅（标志性说法）】',
    ...list.map((m) => `- ${m.content.slice(0, 60)}`),
    '在合适的位置自然用上 1-2 个即可；用不上就不用，绝不要为了用而硬塞，也不要改写它们的说法。',
  ].join('\n');
}

export async function materialContextForAccount(accountId: string): Promise<string> {
  const materials = await loadMaterials(accountId);
  return materialPromptBlock(materials);
}
