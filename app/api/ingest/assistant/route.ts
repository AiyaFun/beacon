import { NextResponse } from 'next/server';
import { log } from '@/lib/logger';
import { INGEST_TOKEN_HEADER, workspaceByIngestToken } from '@/lib/ingest/competitor';
import { llmComplete } from '@/lib/llm/gateway';
import type { ChatMessage } from '@/lib/llm/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': `content-type, ${INGEST_TOKEN_HEADER}`,
};

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: CORS });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function POST(req: Request) {
  const token = req.headers.get(INGEST_TOKEN_HEADER);
  const ws = await workspaceByIngestToken(token);
  if (!ws) {
    return json({ ok: false, error: '采集令牌无效或已停用——请在 烽火台设置页 重新生成并填入插件' }, 401);
  }

  let body: {
    question?: string;
    context?: {
      platform?: string;
      title?: string;
      author?: string;
      metrics?: Record<string, unknown>;
      url?: string;
      snippet?: string;
    };
    history?: { role: 'user' | 'assistant'; content: string }[];
    action?: 'analyze' | 'ideas' | 'chat';
  };

  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'JSON 格式无效' }, 400);
  }

  const question = (body.question || '').trim();
  const context = body.context || {};
  const action = body.action || 'chat';

  const system = [
    '你是「烽火台」内容创作 SaaS 的 AI 浏览器运营助手。',
    '你正在辅助创作者在浏览短视频/图文平台（B站、抖音、小红书、YouTube、X等）时提供实时的内容拆解与爆款选题灵感。',
    '你的回答应当专业、精准、条理清晰、切中要害。',
    context.title ? `当前页面标题/主题: ${context.title}` : '',
    context.author ? `作者/账号: ${context.author}` : '',
    context.platform ? `平台: ${context.platform}` : '',
    context.metrics ? `数据表现: ${JSON.stringify(context.metrics)}` : '',
    context.snippet ? `正文/摘要: ${context.snippet}` : '',
    '',
    '指导原则：',
    '1. 给出可落地的建议与洞察，避免空泛客套。',
    '2. 针对爆款拆解，重点分析：吸睛 Hook、情绪共鸣点、结构脉脉、选题优势。',
    '3. 针对选题衍生，提供 3 个具有高转化潜力的对标创作方案。',
    '4. 输出排版使用 Markdown 格式，层级分明。',
  ].filter(Boolean).join('\n');

  const historyMessages: ChatMessage[] = (body.history || []).slice(-8).map((h) => ({
    role: h.role,
    content: h.content,
  }));

  let prompt = question;
  if (!prompt) {
    if (action === 'analyze') {
      prompt = '请对当前页面的内容与数据表现进行「爆款拆解分析」，给出钩子拆解、结构亮点、情绪触发点与改进建议。';
    } else if (action === 'ideas') {
      prompt = '基于当前页面的选题与内容，生成 3 个同赛道爆款衍生选题与标题方案。';
    } else {
      prompt = '请分析当前页面并总结关键要点。';
    }
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    ...historyMessages,
    { role: 'user', content: prompt },
  ];

  try {
    const r = await llmComplete(ws.tenantId, 'chat', messages, { temperature: 0.7 });
    log.info('插件 AI 助手响应成功', { workspaceId: ws.id, action, promptLength: prompt.length });
    return json({ ok: true, answer: r.text, mocked: r.mocked });
  } catch (e) {
    const err = e as Error;
    log.error('插件 AI 助手响应失败', { error: err.message });
    return json({ ok: false, error: err.message || 'AI 模型响应异常' }, 500);
  }
}
