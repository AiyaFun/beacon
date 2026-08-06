'use server';

import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { readPersona, personaPromptBlock } from '@/lib/persona';
import { buildMemoryContext } from '@/lib/memory/core';
import { llmComplete } from '@/lib/llm/gateway';
import type { ChatMessage } from '@/lib/llm/types';
import { requireRole, RbacError } from '@/lib/rbac';
import { QuotaExceededError } from '@/lib/quota';

// F8 AI 助手：带账号人设 + 长期记忆上下文的对话。
export type ChatTurn = { role: 'user' | 'assistant'; content: string };

// 「按设计拒绝」类错误（配额用尽 / 权限不足）。Next 15 生产会脱敏抛到 error boundary 的 message，
// 而这里的错误原本经 Chat.tsx 的 catch 直接展示 e.message —— 生产就成了通用英文串，配额自救文案丢失。
// 故 actAsk 命中这两类错误时改为结构化返回 error 字段，Chat.tsx 渲染该字段而非依赖 catch 的 message。
function isDesignedRejection(e: unknown): e is QuotaExceededError | RbacError {
  return e instanceof QuotaExceededError || e instanceof RbacError;
}

export async function actAsk(
  question: string,
  history: ChatTurn[],
): Promise<{ answer: string; mocked: boolean; error?: string }> {
  const q = question.trim();
  if (!q) return { answer: '（请先输入你的问题）', mocked: false };

  const s = await getSession();
  try {
    // 助手按需生成文案并烧 token，不属于「看」，按创作动作管
    requireRole(s, 'content.create');
    const account = await prisma.creatorAccount.findUnique({ where: { id: s.accountId } });
    const persona = readPersona(account?.personaCard ?? '{}');
    const memoryBlock = await buildMemoryContext(s.workspaceId, s.accountId);

    const system = [
      '你是「烽火台」内容创作 SaaS 里的 AI 运营助手。',
      '你服务于一位内容创作者，帮他做选题、写文案、优化运营与变现。',
      '回答要具体、可落地、说人话，紧扣下面这个账号的人设与历史记忆，别给放之四海皆准的空话。',
      '',
      personaPromptBlock(persona),
      memoryBlock ? '\n' + memoryBlock : '',
      '',
      '输出用中文，条理清晰，必要时用短列表；控制在合理长度，别啰嗦。',
    ].join('\n');

    // 只保留最近若干轮，避免上下文过长
    const trimmed = history.slice(-10).map((t): ChatMessage => ({ role: t.role, content: t.content }));

    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      ...trimmed,
      { role: 'user', content: q },
    ];

    const r = await llmComplete(s.tenantId, 'chat', messages, { temperature: 0.7 });
    return { answer: r.text, mocked: r.mocked };
  } catch (e) {
    // 配额用尽 / 权限不足 → 带自救文案的结构化返回（Chat.tsx 渲染 error 字段）；其余异常抛给 boundary。
    if (isDesignedRejection(e)) return { answer: '', mocked: false, error: e.message };
    throw e;
  }
}
