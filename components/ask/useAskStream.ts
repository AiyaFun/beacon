'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { looksActionable } from '@/lib/agent/intent';
import { prepareReferenceImage } from '@/lib/cover/client-image';
import { readPickedModel } from '@/app/(app)/assistant/ModelPicker';
import type { SelectableModel } from '@/lib/llm/selectable';

// ── 「问一句」的流式内核 ──────────────────────────────────────────────────────
//
// 【为什么从 /assistant 的 Chat.tsx 里拆出来】（2026-09-06）用户第四次问「问 AI 能不能
// 直接放到首页那个框里」。此前首页只能派活、/assistant 只能问，两页各有一个长得一样的
// 输入框——合并的前提是「问」不能自带第二个输入框，所以把它拆成一个只管
// 收发与状态的 hook，输入框由宿主（首页 TaskDeckHome）提供。
//
// 这里只做三件事：发问题、收流、维护对话与待发图片的状态。**不碰任何数据**——
// 「让它去做」由宿主在拿到 handoffGoal 之后自己派（那一下点击才是授权）。

/**
 * 一次最多带几张图。
 *
 * 每张内联图都要整段进请求体与模型上下文，四五张就是几 MB——
 * 而生产的 WAF 对超大请求体会回一个**假的 HTTP 200 + HTML 错误页**
 *（视频拆解上传曾因此在生产一直是坏的）。3 张够用且留足余量，
 * 与服务端 app/api/chat/stream 的 MAX_IMAGES 是同一个数。
 */
export const MAX_PICS = 3;

type ChatTurn = { role: 'user' | 'assistant'; content: string };
export type AskMsg = { role: 'user' | 'assistant'; content: string; mocked?: boolean; error?: boolean };

export function useAskStream({ models, lang }: { models: SelectableModel[]; lang: string }) {
  const [messages, setMessages] = useState<AskMsg[]>([]);
  const [streaming, setStreaming] = useState(false);
  /**
   * 刚问完的这句话像不像「让它去做」（lib/agent/intent.ts 判的，不问模型）。
   * 只留最近一句：每条回答后面都挂一个按钮就成了背景噪音。
   */
  const [handoffGoal, setHandoffGoal] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  /**
   * 待发送的参考图（data: URI，已在客户端压过）。
   *
   * 【为什么图不进 messages 历史】历史每一轮都会整段重发给模型，图片带进去
   * 会让第三轮的请求体变成几 MB——而生产的 WAF 对超大请求体会回一个**假的 200**。
   * 图只跟着**这一次提问**走，问完就清空。
   */
  const [pics, setPics] = useState<string[]>([]);
  const [picErr, setPicErr] = useState('');

  /**
   * 这次用哪个模型。**初值不能直接读 localStorage**——服务端渲染时没有这个 API，
   * 首屏 HTML 与 hydrate 后的值不一致会触发 hydration mismatch。
   * 所以初值取清单第一项（自动档），挂载后再把上次的选择读回来。
   */
  const [modelId, setModelId] = useState(() => models[0]?.id ?? 'auto');
  useEffect(() => { setModelId(readPickedModel(models)); }, [models]);

  const send = useCallback(async (text: string) => {
    const q = text.trim();
    // 只发图不打字也算数：「这张图怎么样」是很自然的问法
    if ((!q && pics.length === 0) || streaming) return false;

    const history: ChatTurn[] = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: m.content }));

    setMessages((prev) => [
      ...prev,
      { role: 'user', content: q || (lang === 'en' ? `(Sent ${pics.length} image${pics.length > 1 ? 's' : ''})` : `（发了 ${pics.length} 张图）`) },
    ]);
    const sending = pics;
    setPics([]); // 图只跟这一次提问走
    setPicErr('');
    setStreaming(true);
    // 上一句的按钮先撤掉：留着的话它指的是上上句，点下去做的是用户已经翻过去的事
    setHandoffGoal(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, history, images: sending, modelId }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: '' }));
        // 401/403 是「按设计拒绝」（没登录 / 演示只读 / 没有创作权限），要说人话，不是印个状态码
        const designed = res.status === 401
          ? (lang === 'en' ? 'Please sign in first.' : '请先登录。')
          : res.status === 403
            ? (lang === 'en' ? 'Read-only here (demo or no creation permission) — sign up or ask the workspace owner.' : '这里是只读的（演示模式或没有创作权限）——注册登录后，或让工作区管理员给权限。')
            : '';
        setMessages((prev) => [...prev, { role: 'assistant', content: errBody.error || designed || (lang === 'en' ? `Request failed (${res.status})` : `请求失败 (${res.status})`), error: true }]);
        return true;
      }

      setMessages((prev) => [...prev, { role: 'assistant', content: '' }]);

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      // 【为什么攒着刷】SSE 每个 delta 通常就一两个字，逐条 setMessages 会让文字
      // 一字一顿地蹦。攒进 acc、每 80ms 批量追加一次——观感是成句地流出来，
      // 重渲染次数也降一个量级。
      let acc = '';
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      const flush = () => {
        flushTimer = null;
        if (!acc) return;
        const chunk = acc;
        acc = '';
        setMessages((prev) => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          copy[copy.length - 1] = { ...last, content: last.content + chunk };
          return copy;
        });
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop()!;
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') break;
          try {
            acc += JSON.parse(payload) as string;
            if (!flushTimer) flushTimer = setTimeout(flush, 80);
          } catch { /* skip */ }
        }
      }
      // 收尾必须把余量刷出去，且要清掉挂着的定时器——不然最后一截会在 80ms 后
      // 才蹦出来，或者组件卸载后 setMessages 打在已卸载的组件上
      if (flushTimer) clearTimeout(flushTimer);
      flush();
      // 答完了再判：答之前就亮按钮，等于在回答还没出来时催用户做决定。
      // 出错/中断的分支各自 return，不会走到这里——那种时候更不该催他去执行
      if (looksActionable(q)) setHandoffGoal(q);
    } catch (e) {
      if ((e as Error).name === 'AbortError') return true;
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: (lang === 'en' ? 'Something went wrong: ' : '出了点问题：') + (e as Error).message.slice(0, 60), error: true },
      ]);
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
    return true;
    // pics 要进依赖：漏了的话闭包里永远是第一次渲染时的空数组，
    // 表现为「传了图但发出去的还是没有图」——不报错，只是图白传了。
    // modelId 必须在依赖里：useCallback 的闭包否则永远捕获首次那个值，
    // 表现为「下拉选了别的模型，发出去的还是自动档」——选项形同虚设。
  }, [messages, streaming, pics, modelId, lang]);

  /** 选了图：客户端先压一遍再入队。压缩复用封面工位那一份，不另写第二套。 */
  async function addPics(files: File[]) {
    setPicErr('');
    const room = MAX_PICS - pics.length;
    if (room <= 0) { setPicErr(lang === 'en' ? `Up to ${MAX_PICS} images` : `最多 ${MAX_PICS} 张`); return; }
    const next: string[] = [];
    for (const f of files.slice(0, room)) {
      try {
        const prepared = await prepareReferenceImage(f);
        next.push(prepared.dataUrl);
      } catch (e) {
        // 一张坏图不该把其余几张一起弃掉——如实说是哪一张不行
        setPicErr(`${f.name}：${(e as Error).message}`);
      }
    }
    if (next.length) setPics((list) => [...list, ...next]);
    if (files.length > room) setPicErr(lang === 'en' ? `Up to ${MAX_PICS} images, excess images ignored` : `最多 ${MAX_PICS} 张，多出来的没有加进来`);
  }

  function removePic(i: number) {
    setPics((list) => list.filter((_, j) => j !== i));
  }

  function stop() {
    abortRef.current?.abort();
  }

  function reset() {
    stop();
    setMessages([]);
    setHandoffGoal(null);
  }

  return {
    messages, streaming, send, stop, reset,
    handoffGoal, setHandoffGoal,
    pics, picErr, addPics, removePic,
    modelId, setModelId,
  };
}
