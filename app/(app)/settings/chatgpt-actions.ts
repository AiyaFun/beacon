'use server';

import { revalidatePath } from 'next/cache';
import { getSession } from '@/lib/session';
import { requireRole } from '@/lib/rbac';
import { assertCan } from '@/lib/edition';
import { assertNotDemo } from '@/lib/demo/guard';
import { startChatgptDeviceLogin, pollChatgptDeviceLogin, importChatgptTokensFromCodexCli, codexCliAvailable } from '@/lib/llm/chatgpt/auth';
import {
  saveChatgptChannel, setChatgptModel, removeChatgptChannel, getChatgptChannel, chatgptChannelView, type ChatgptChannelView,
} from '@/lib/llm/chatgpt/channel';
import type { ReasoningEffort } from '@/lib/llm/chatgpt/types';

// ChatGPT 订阅渠道的 server action 层（2026-09-15）。
//
// 【每一条都先 assertCan('chatgptSubscription')】server action 就是公开 RPC，界面上不显示这张卡拦不住任何人；
// SaaS 上这几条必须在服务端就拒——订阅是用户个人的，平台不能替他用（lib/edition.ts 那格的理由）。
// 【登录态在客户端只有 deviceAuthId + userCode 两样】它们是「等用户去 OpenAI 输码」这一步的句柄，
// 不是 token；token 只在 pollLogin 拿到的那一刻进库（信封加密），不经过浏览器。

async function guard() {
  const s = await getSession();
  assertCan('chatgptSubscription');
  requireRole(s, 'byok.manage');
  assertNotDemo(s.tenantId);
  return s;
}

function fail(e: unknown): { ok: false; error: string } {
  return { ok: false, error: (e as Error).message.slice(0, 300) };
}

export async function actChatgptStartLogin(): Promise<
  { ok: true; deviceAuthId: string; userCode: string; verifyUrl: string; intervalSec: number } | { ok: false; error: string }
> {
  try {
    await guard();
    const r = await startChatgptDeviceLogin();
    return { ok: true, ...r };
  } catch (e) {
    return fail(e);
  }
}

export async function actChatgptPollLogin(deviceAuthId: string, userCode: string): Promise<
  { ok: true; status: 'pending' } | { ok: true; status: 'done'; view: ChatgptChannelView | null } | { ok: false; error: string }
> {
  try {
    const s = await guard();
    if (!deviceAuthId || !userCode) return { ok: false, error: '登录会话不完整，重新点一次「用 ChatGPT 账号登录」' };
    const r = await pollChatgptDeviceLogin(deviceAuthId, userCode);
    if (r.status === 'pending') return { ok: true, status: 'pending' };
    if (r.status === 'error') return { ok: false, error: r.error };
    await saveChatgptChannel(s.tenantId, r.tokens);
    revalidatePath('/settings/keys');
    const row = await getChatgptChannel(s.tenantId);
    return { ok: true, status: 'done', view: row ? chatgptChannelView(row) : null };
  } catch (e) {
    return fail(e);
  }
}

/** 从这台机器上的 Codex CLI 导入登录态（Hermes 同款）。只对整机版有意义——那台机器就是用户自己的电脑。 */
export async function actChatgptImportFromCli(): Promise<{ ok: true; view: ChatgptChannelView | null; model?: string } | { ok: false; error: string }> {
  try {
    const s = await guard();
    if (!codexCliAvailable()) return { ok: false, error: '这台机器上没有 Codex CLI 的登录态。先在终端里跑一次 `codex login`（用 ChatGPT 账号登录），或改用「用 ChatGPT 账号登录」。' };
    const { tokens, model } = importChatgptTokensFromCodexCli();
    await saveChatgptChannel(s.tenantId, tokens, { model });
    revalidatePath('/settings/keys');
    const row = await getChatgptChannel(s.tenantId);
    return { ok: true, view: row ? chatgptChannelView(row) : null, model };
  } catch (e) {
    return fail(e);
  }
}

export async function actChatgptSetModel(model: string, effort: ReasoningEffort): Promise<{ ok: boolean; error?: string }> {
  try {
    const s = await guard();
    const r = await setChatgptModel(s.tenantId, model, effort);
    if (r.ok) revalidatePath('/settings/keys');
    return r;
  } catch (e) {
    return fail(e);
  }
}

export async function actChatgptDisconnect(): Promise<{ ok: boolean; error?: string }> {
  try {
    const s = await guard();
    await removeChatgptChannel(s.tenantId);
    revalidatePath('/settings/keys');
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
