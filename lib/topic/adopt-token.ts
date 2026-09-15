import { signPayload, verifyPayload } from '../crypto';
import type { HotFitAnalysis, HotFitAngle } from './combine';

// 「一键采纳」的来源校验。
//
// 此前 actAdoptHotAngleAsTopic 的 hotTitle/angle/why/fitScore 全部由客户端传，服务端只校格式：
// 任何登录用户都能伪造一条「来自 AI 热点分析、契合度 100」的已采纳选题，污染后续推荐与统计。
// 现在 actAnalyzeHotFit 把分析结果连同账号 id 签成凭证发给客户端，采纳时客户端只回传
// 凭证 + 切入角序号，标题/理由/评分一律从验过签的凭证里取——客户端改不了一个字。
// 复用 lib/crypto 的主密钥派生 HMAC：无需建表，换主密钥时在途凭证一起失效，语义正确。

export const HOT_FIT_TOKEN_TTL_MS = 24 * 3600 * 1000;
const MAX_TOKEN_LEN = 16 * 1024;

export type HotFitTokenPayload = {
  v: 1;
  accountId: string;
  hotTitle: string;
  fit: number;
  mocked: boolean;
  angles: HotFitAngle[];
  exp: number;
};

export function issueHotFitToken(accountId: string, analysis: HotFitAnalysis, now = Date.now()): string {
  const payload: HotFitTokenPayload = {
    v: 1,
    accountId,
    hotTitle: analysis.hotTitle,
    fit: analysis.fit,
    mocked: analysis.mocked,
    angles: analysis.angles.map((a) => ({ angle: a.angle, why: a.why })),
    exp: now + HOT_FIT_TOKEN_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${signPayload(body)}`;
}

export type HotFitTokenVerdict = { ok: true; payload: HotFitTokenPayload } | { ok: false; error: string };

const INVALID: HotFitTokenVerdict = { ok: false, error: '采纳凭证无效，请重新分析后再采纳' };

export function verifyHotFitToken(token: unknown, accountId: string, now = Date.now()): HotFitTokenVerdict {
  if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_LEN) return INVALID;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return INVALID;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!verifyPayload(body, sig)) return INVALID;

  let payload: HotFitTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return INVALID;
  }
  if (!payload || payload.v !== 1 || !Array.isArray(payload.angles) || typeof payload.hotTitle !== 'string') return INVALID;
  // 签名过了才比账号：凭证是 A 账号分析出来的，换到 B 账号的会话里不能用
  if (payload.accountId !== accountId) return { ok: false, error: '采纳凭证不属于当前账号' };
  if (typeof payload.exp !== 'number' || payload.exp < now) return { ok: false, error: '分析结果已过期，请重新分析后再采纳' };
  return { ok: true, payload };
}
