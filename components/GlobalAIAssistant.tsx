'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { usePathname } from 'next/navigation';
import { Icon } from './icons';
import { looksActionable } from '@/lib/agent/intent';
import { prepareReferenceImage } from '@/lib/cover/client-image';

/** 与助手页、服务端同一个数：3 张（超大请求体会被 WAF 回一个假的 200）。 */
const MAX_PICS = 3;

type ChatTurn = { role: 'user' | 'assistant'; content: string };
type Msg = { role: 'user' | 'assistant'; content: string; mocked?: boolean; error?: boolean };

// 页面路径到友好名称和功能说明的映射
export const PAGE_INFOS: Record<string, { name: string; desc: string }> = {
  '/': {
    name: '今日概览',
    desc: '工作区核心看板，包含全平台总播放量、今日推荐Top3选题、今日运营建议、待办任务清单和快速入口。',
  },
  '/battle': {
    name: '本周作战',
    desc: '本周内容作战报告：把自有表现指标、高潜选题、低表现作品诊断、竞对本周动向拼成一页操作台，每条选题后面就是起稿入口，可直接进创作工坊起草并发布。',
  },
  '/runs': {
    name: '运行中心',
    desc: 'AI 执行、工作流、采集、发布四类运行记录汇总。「等你处理」是停下来等人的（等确认写操作、等去平台点发布），不是系统还在跑；AI 执行那条可展开看它调了哪些工具。跨账号全收，每条标明归属账号。',
  },
  '/competitors': {
    name: '竞对监控',
    desc: '多平台对标账号监控。可以添加竞对链接并获取粉丝数、作品数及最新发布的高热作品。',
  },
  '/algorithm': {
    name: '平台算法教练',
    desc: '各大平台的算法规则库和发布前 Checklist，传统且有 S/A/B/C 级可信度的运营优化建议。',
  },
  '/topics': {
    name: '选题引擎',
    desc: '基于你的账号人设与平台热点分析生成的推荐选题，提供选题切入点与六维评分。页内含三个标签：挑选题（候选与六维评分）、灵感箱（随手存的点子与读者提问）、找角度（12 位人物智囊团会诊）。',
  },
  '/studio': {
    name: '创作工坊',
    desc: '跨平台内容撰写和发布编辑器，集成 AI 初稿生成、合规词检测和一键敏感词改写。',
  },
  '/compliance': {
    name: '合规检测',
    desc: '广告法、平台敏感词、行业高危违规项分级预警中心，提供敏感词改写建议。',
  },
  '/persona': {
    name: '人设与记忆',
    desc: '账号人设卡配置（身份/语气/受众等）与长期记忆脑库（行为偏好、数据反馈积累）。',
  },
  '/material': {
    name: '素材库',
    desc: '创作者自建的经历、案例、观点和金句素材库，作为生成差异化选题和文案的专属原料。',
  },
  '/publish': {
    name: '发布中心',
    desc: '把稿子发出去的那一段：进行中的发布计划与每个平台的任务状态、等你去点发布的任务、平台通道能力矩阵（公众号可接口直发/插件填好你来点/只能手动）、最近发布记录与缺链接提醒。按当前账号过滤。',
  },
  '/images': {
    name: 'AI 出图',
    desc: '不绑草稿的出图工位：自己写画面描述批量出图（一律不上字）、我的形象与素材库上传管理、最近生成图片的画廊与钉住/删除。封面上字在创作工坊「标题与封面」。',
  },
  '/data': {
    name: '数据看板',
    desc: '账号发布历史、播放趋势分析和缺少平台ItemId的作品回填管理。',
  },
  '/extension': {
    name: '下载采集助手',
    desc: '浏览器采集助手插件下载，安装后可免去 Cookie 实现各平台公开页一键回填。',
  },
  '/desktop': {
    name: '桌面客户端',
    desc: 'Mac / Windows 桌面客户端下载：独立窗口、托盘常驻、开机自启，可连云端账号或本机整机版；整机版还能在这里一键增量更新本机服务。',
  },
  '/skills': {
    name: '技能中心',
    desc: '定制化创作提示词模板市场，安装或自定义不同平台与体裁的文案渲染格式。',
  },
  '/assistant': {
    name: 'AI 助手独立页',
    desc: '全屏对话窗口，带人设与历史记忆上下文的自由互动创作助手。',
  },
  '/settings': {
    name: '运行设置',
    desc: '后台定时任务的开关与最近运行结果、热榜数据源健康度、语义向量实况。不含任何密钥——那些在「接入与密钥」。',
  },
  '/settings/keys': {
    name: '接入与密钥',
    desc: '这个产品里所有要填 Key 的地方：模型渠道（BYOK）与按功能路由、生图渠道、公众号发布凭证、插件采集令牌、机器人凭据，另有「一键检测」逐条探连通性（不发测试消息、不真出图）。',
  },
  '/workflows': {
    name: '工作流模板',
    desc: '把「选题→初稿→技能改写→封面→配图→发布计划」串成可复用的流水线，内置模板装上即用，自建模板可导出分享。技能是一步，模板是一串。',
  },
  '/billing': {
    name: '套餐与计费',
    desc: '升级订阅套餐或查看工作区各功能的当前用量配额。',
  },
  '/members': {
    name: '成员与权限',
    desc: '团队成员协同管理、邀请链接生成以及 RBAC 角色权限配置。',
  },
  '/help': {
    name: '使用帮助',
    desc: '快速上手图文说明，以及群消息机器人集成教程。',
  },
  // ⚠️ 新增页面务必同步登记到这里。漏登记不只是状态栏显示成「当前页面：当前页面」这么简单：
  // desc 会整条缺席，而「✨ 一键分析当前页面」正是靠它告诉模型这一页是干什么的——
  // 助手在这些页面上等于瞎着眼分析。真机 2026-07-30 漏了 7 个页面（/genes、/notifications 等）。
  '/hotlists': {
    name: '热点聚合中心',
    desc: '八大平台热榜聚合与跨源话题聚类，可选一个实时热点做「账号 × 热点」结合分析。部分平台没有真实采集通道时会显示带「示例」标的占位词条，那些词条不参与选题推荐。',
  },
  '/library': {
    name: '内容资讯库',
    desc: '剪藏进来的文章与竞对内容全文库，可做正文摘要、竞对拆解和结合账号的选题分析。',
  },
  '/genes': {
    name: '爆款基因',
    desc: '把已发布内容按来源、切入角、结构等维度拆解，找出你自己账号上被数据验证过的高表现要素。',
  },
  '/notifications': {
    name: '机器人与通知',
    desc: '飞书/钉钉/企业微信机器人配置：出站推送每日推荐与合规告警，入站 ChatOps 在群里收录链接、@机器人对话。',
  },
  '/feedback': {
    name: '问题反馈与社群支持',
    desc: '提交产品问题与需求反馈，以及用户社群的加入方式。',
  },
  '/settings/account': {
    name: '账号与安全',
    desc: '登录设备与会话管理、数据导出、账号注销（含工作区数据删除）等账号级安全操作。',
  },
};

function getPageContext(pathname: string): { name: string; desc: string; dataText?: string } {
  const matched = PAGE_INFOS[pathname] || {
    name: '当前导航页',
    desc: '烽火台内容作战室页面。',
  };

  let dataText = '';
  try {
    if (typeof document !== 'undefined') {
      const stats: string[] = [];
      document.querySelectorAll('.stat-label, .stat-value').forEach((el) => {
        const text = el.textContent?.trim();
        if (text) stats.push(text);
      });
      if (stats.length > 0) {
        dataText += '页面关键指标：';
        for (let i = 0; i < stats.length; i += 2) {
          if (stats[i] && stats[i + 1]) {
            dataText += `${stats[i]}: ${stats[i + 1]}; `;
          }
        }
        dataText += '\n';
      }

      const items: string[] = [];
      document.querySelectorAll('.list-row b, .card b, table tbody tr td:first-child').forEach((el) => {
        const text = el.textContent?.trim().replace(/\s+/g, ' ');
        if (text && items.length < 5) {
          items.push(text);
        }
      });
      if (items.length > 0) {
        dataText += '页面当前主要条目：' + items.join(', ') + '\n';
      }
    }
  } catch (e) {
    console.error('Failed to extract DOM context:', e);
  }

  return {
    name: matched.name,
    desc: matched.desc,
    dataText: dataText || undefined,
  };
}

export function GlobalAIAssistant({ accountName }: { accountName: string }) {
  const pathname = usePathname();
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([
    {
      role: 'assistant',
      // 这条消息按纯文本渲染，**不过 markdown**——写 `**粗体**` 只会让用户看见两串星号
      // （真机 2026-07-30 界面上就是 `**「✨ 一键分析当前页面」**`）。
      // 按钮名也要和界面上真实的那个一致：它写的是「一键分析」，不是「一键分析当前页面」。
      content: `你好，我是「${accountName}」的 AI 运营助手。选题、文案、运营都可以随时问我。\n\n💡 我能感知你当前浏览的页面，点右上角的「一键分析」，我会结合这一页的数据给你洞察和落地建议。`,
    },
  ]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const msgsRef = useRef(messages);
  msgsRef.current = messages;
  /**
   * 待发送的参考图（data: URI，客户端已压过）。
   *
   * 用 ref 同步一份是因为 send 是 useCallback([streaming])——只读 state 的话
   * 闭包里永远是第一次渲染时的空数组，表现为「传了图但发出去的还是没有图」，
   * 不报错，只是图白传了。
   */
  const [pics, setPics] = useState<string[]>([]);
  const [picErr, setPicErr] = useState('');
  const picsRef = useRef<string[]>([]);
  picsRef.current = pics;

  /** 选了图：客户端先压一遍（复用封面工位那一份，不另写第二套）。 */
  async function addPics(files: File[]) {
    setPicErr('');
    const room = MAX_PICS - picsRef.current.length;
    if (room <= 0) { setPicErr(`最多 ${MAX_PICS} 张`); return; }
    const next: string[] = [];
    for (const f of files.slice(0, room)) {
      try {
        next.push((await prepareReferenceImage(f)).dataUrl);
      } catch (e) {
        setPicErr(`${f.name}：${(e as Error).message}`);
      }
    }
    if (next.length) setPics((list) => [...list, ...next]);
  }

  // ── 自由位置/尺寸/字号 State ──
  // triggerPosMode: 'top' (页面上方，默认) | 'bottom' (页面下方)
  const [triggerPosMode, setTriggerPosMode] = useState<'top' | 'bottom'>('top');
  const [btnPos, setBtnPos] = useState<{ x: number; y: number } | null>(null); // 入口图标自由拖拽位置
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null); // 助手面板自由拖拽位置
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 380, h: 580 });
  const [isMaximized, setIsMaximized] = useState(false);
  const [fontScale, setFontScale] = useState<number>(100); // 85% / 100% / 115% / 130% / 145%

  const isDraggingRef = useRef(false);
  const dragStartRef = useRef<{ mouseX: number; mouseY: number; posX: number; posY: number }>({ mouseX: 0, mouseY: 0, posX: 0, posY: 0 });

  const isDraggingBtnRef = useRef(false);
  const dragBtnMovedRef = useRef(false);
  const dragBtnStartRef = useRef<{ mouseX: number; mouseY: number; posX: number; posY: number }>({ mouseX: 0, mouseY: 0, posX: 0, posY: 0 });

  const isResizingRef = useRef(false);
  const resizeStartRef = useRef<{ mouseX: number; mouseY: number; startW: number; startH: number; startX: number; startY: number; handle: string }>({
    mouseX: 0, mouseY: 0, startW: 380, startH: 580, startX: 0, startY: 0, handle: 'bottom-right'
  });
  const dragCleanupRef = useRef<(() => void)[]>([]);

  useEffect(() => () => { dragCleanupRef.current.forEach(fn => fn()); }, []);

  // 获取当前页面的简短友好名称
  const pageInfo = PAGE_INFOS[pathname] || { name: '当前页面', desc: '' };

  useEffect(() => {
    if (isOpen) {
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [messages, streaming, isOpen]);

  // 处理入口图标自由拖拽
  const onTriggerMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingBtnRef.current = true;
    dragBtnMovedRef.current = false;

    const defaultY = triggerPosMode === 'top' ? 72 : window.innerHeight - 56 - 24;
    const currentX = btnPos ? btnPos.x : window.innerWidth - 52 - 24;
    const currentY = btnPos ? btnPos.y : defaultY;

    dragBtnStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      posX: currentX,
      posY: currentY,
    };

    const onMouseMove = (moveEv: MouseEvent) => {
      if (!isDraggingBtnRef.current) return;
      const deltaX = moveEv.clientX - dragBtnStartRef.current.mouseX;
      const deltaY = moveEv.clientY - dragBtnStartRef.current.mouseY;

      if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) {
        dragBtnMovedRef.current = true;
      }

      const newX = Math.max(10, Math.min(window.innerWidth - 60, dragBtnStartRef.current.posX + deltaX));
      const newY = Math.max(10, Math.min(window.innerHeight - 60, dragBtnStartRef.current.posY + deltaY));

      setBtnPos({ x: newX, y: newY });
    };

    const cleanup = () => {
      isDraggingBtnRef.current = false;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', cleanup);
      dragCleanupRef.current = dragCleanupRef.current.filter(fn => fn !== cleanup);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', cleanup);
    dragCleanupRef.current.push(cleanup);
  };

  const onTriggerClick = () => {
    if (dragBtnMovedRef.current) {
      dragBtnMovedRef.current = false;
      return;
    }
    setIsOpen(!isOpen);
  };

  // 处理窗口位置拖拽
  const onHeaderMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, input, textarea, a')) return;
    e.preventDefault();
    isDraggingRef.current = true;

    const currentW = isMaximized ? Math.min(820, window.innerWidth - 40) : size.w;
    const currentH = isMaximized ? Math.min(760, window.innerHeight - 80) : size.h;

    const defaultY = btnPos
      ? Math.min(window.innerHeight - currentH - 10, btnPos.y + 64)
      : triggerPosMode === 'top' ? 136 : window.innerHeight - currentH - 92;
    const defaultX = btnPos
      ? Math.max(10, Math.min(window.innerWidth - currentW - 10, btnPos.x - currentW + 52))
      : window.innerWidth - currentW - 24;

    const currentX = pos ? pos.x : defaultX;
    const currentY = pos ? pos.y : defaultY;

    dragStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      posX: currentX,
      posY: currentY,
    };

    const onMouseMove = (moveEv: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const deltaX = moveEv.clientX - dragStartRef.current.mouseX;
      const deltaY = moveEv.clientY - dragStartRef.current.mouseY;

      const newX = Math.max(10, Math.min(window.innerWidth - currentW - 10, dragStartRef.current.posX + deltaX));
      const newY = Math.max(10, Math.min(window.innerHeight - currentH - 10, dragStartRef.current.posY + deltaY));

      setPos({ x: newX, y: newY });
    };

    const cleanup = () => {
      isDraggingRef.current = false;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', cleanup);
      dragCleanupRef.current = dragCleanupRef.current.filter(fn => fn !== cleanup);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', cleanup);
    dragCleanupRef.current.push(cleanup);
  };

  // 处理窗口边缘/角落拖拽拉伸 Size
  const onResizeMouseDown = (e: React.MouseEvent, handle: 'bottom-right' | 'top-left' | 'bottom-left') => {
    e.preventDefault();
    e.stopPropagation();
    if (isMaximized) return;

    isResizingRef.current = true;
    const defaultY = btnPos
      ? Math.min(window.innerHeight - size.h - 10, btnPos.y + 64)
      : triggerPosMode === 'top' ? 136 : window.innerHeight - size.h - 92;
    const defaultX = btnPos
      ? Math.max(10, Math.min(window.innerWidth - size.w - 10, btnPos.x - size.w + 52))
      : window.innerWidth - size.w - 24;

    const currentX = pos ? pos.x : defaultX;
    const currentY = pos ? pos.y : defaultY;

    resizeStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      startW: size.w,
      startH: size.h,
      startX: currentX,
      startY: currentY,
      handle,
    };

    const onMouseMove = (moveEv: MouseEvent) => {
      if (!isResizingRef.current) return;
      const deltaX = moveEv.clientX - resizeStartRef.current.mouseX;
      const deltaY = moveEv.clientY - resizeStartRef.current.mouseY;

      if (handle === 'bottom-right') {
        const newW = Math.max(320, Math.min(window.innerWidth - currentX - 10, resizeStartRef.current.startW + deltaX));
        const newH = Math.max(380, Math.min(window.innerHeight - currentY - 10, resizeStartRef.current.startH + deltaY));
        setSize({ w: newW, h: newH });
      } else if (handle === 'top-left') {
        const newW = Math.max(320, Math.min(resizeStartRef.current.startX + resizeStartRef.current.startW - 10, resizeStartRef.current.startW - deltaX));
        const newH = Math.max(380, Math.min(resizeStartRef.current.startY + resizeStartRef.current.startH - 10, resizeStartRef.current.startH - deltaY));
        const newX = resizeStartRef.current.startX + (resizeStartRef.current.startW - newW);
        const newY = resizeStartRef.current.startY + (resizeStartRef.current.startH - newH);
        setSize({ w: newW, h: newH });
        setPos({ x: newX, y: newY });
      }
    };

    const cleanup = () => {
      isResizingRef.current = false;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', cleanup);
      dragCleanupRef.current = dragCleanupRef.current.filter(fn => fn !== cleanup);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', cleanup);
    dragCleanupRef.current.push(cleanup);
  };

  // 重置默认位置
  const resetPos = () => {
    setPos(null);
    setBtnPos(null);
    setSize({ w: 380, h: 580 });
    setIsMaximized(false);
  };

  // 内容字号放大与缩小
  const zoomIn = () => setFontScale((s) => Math.min(145, s + 15));
  const zoomOut = () => setFontScale((s) => Math.max(85, s - 15));

  const send = useCallback(
    async (text: string, displayUserText?: string) => {
      const q = text.trim();
      // 只发图不打字也算数
      if ((!q && picsRef.current.length === 0) || streaming) return;

      const userTextToShow = displayUserText || q;
      const history: ChatTurn[] = msgsRef.current
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role, content: m.content }));

      setMessages((prev) => [
        ...prev,
        { role: 'user', content: userTextToShow || `（发了 ${picsRef.current.length} 张图）` },
      ]);
      setInput('');
      const sendingPics = picsRef.current;
      setPics([]); // 图只跟这一次提问走：进历史会让后面每一轮都重发几 MB
      picsRef.current = [];
      setStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch('/api/chat/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: q, history, images: sendingPics }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const errBody = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
          setMessages((prev) => [
            ...prev,
            { role: 'assistant', content: errBody.error || `请求失败 (${res.status})`, error: true },
          ]);
          return;
        }

        setMessages((prev) => [...prev, { role: 'assistant', content: '' }]);

        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buf = '';

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
              const delta = JSON.parse(payload) as string;
              setMessages((prev) => {
                const copy = [...prev];
                const last = copy[copy.length - 1];
                copy[copy.length - 1] = { ...last, content: last.content + delta };
                return copy;
              });
            } catch {
              /* skip */
            }
          }
        }
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: '出了点问题：' + (e as Error).message.slice(0, 60), error: true },
        ]);
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [streaming]
  );

  // 最后一句用户说的话，答完之后才判。带上它去执行那一侧——
  // 只带一句话是刻意的：浮标里的铺垫在执行模式下用不上（那边不是聊天），
  // 而把整段对话塞进 URL 会撞长度上限
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const handoffGoal = !streaming && lastUser && looksActionable(lastUser.content) ? lastUser.content : '';

  const handleAnalyzePage = () => {
    if (streaming) return;
    const ctx = getPageContext(pathname);
    const userDisplayMsg = `请分析当前浏览的「${ctx.name}」页面`;
    const fullPrompt = [
      `请帮我分析当前浏览的「${ctx.name}」页面。`,
      `该页面的功能是：${ctx.desc}`,
      ctx.dataText ? `当前页面中提取到的数据摘要有：\n${ctx.dataText}` : '',
      `请结合我的账号人设和历史记忆，为我提供针对该页面的运营洞察、使用引导或具体的选题建议。`,
    ].filter(Boolean).join('\n');

    send(fullPrompt, userDisplayMsg);
  };

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  }

  const currentW = isMaximized ? Math.min(820, typeof window !== 'undefined' ? window.innerWidth - 40 : 820) : size.w;
  const currentH = isMaximized ? Math.min(760, typeof window !== 'undefined' ? window.innerHeight - 80 : 760) : size.h;

  const defaultTop = triggerPosMode === 'top' ? 136 : undefined;
  const defaultBottom = triggerPosMode === 'top' ? undefined : 92;

  const panelStyle: React.CSSProperties = {
    width: `${currentW}px`,
    height: `${currentH}px`,
    maxHeight: 'calc(100vh - 40px)',
    maxWidth: 'calc(100vw - 20px)',
    left: pos ? `${pos.x}px` : undefined,
    top: pos ? `${pos.y}px` : defaultTop !== undefined ? `${defaultTop}px` : undefined,
    right: pos ? undefined : '24px',
    bottom: pos ? undefined : defaultBottom !== undefined ? `${defaultBottom}px` : undefined,
    '--fap-font-size': `${13.5 * (fontScale / 100)}px`,
  } as React.CSSProperties;

  return (
    <>
      <style>{`
        /* 悬浮/固定客服入口按钮 */
        .float-assistant-trigger {
          position: fixed;
          right: 24px;
          width: 52px;
          height: 52px;
          border-radius: 50%;
          background: linear-gradient(135deg, var(--brand), #ff8c42);
          box-shadow: 0 4px 18px rgba(232, 85, 45, 0.35);
          display: flex;
          align-items: center;
          justify-content: center;
          color: #fff;
          cursor: pointer;
          z-index: 999;
          transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.3s ease, top 0.3s ease, bottom 0.3s ease;
          border: none;
          outline: none;
        }
        .float-assistant-trigger.pos-top {
          top: 72px; /* 位于页面上方（顶部导航栏正下方） */
          bottom: auto;
        }
        .float-assistant-trigger.pos-bottom {
          bottom: 24px; /* 位于页面右下角 */
          top: auto;
        }
        .float-assistant-trigger:hover {
          transform: scale(1.1) rotate(5deg);
          box-shadow: 0 6px 24px rgba(232, 85, 45, 0.45);
        }
        .float-assistant-trigger::after {
          content: '';
          position: absolute;
          width: 100%;
          height: 100%;
          border-radius: 50%;
          border: 2px solid var(--brand);
          opacity: 0.6;
          animation: float-pulse 2s infinite;
          pointer-events: none;
        }

        @keyframes float-pulse {
          0% { transform: scale(1); opacity: 0.6; }
          100% { transform: scale(1.4); opacity: 0; }
        }

        /* 聊天弹窗面板 */
        .float-assistant-panel {
          position: fixed;
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: var(--radius);
          box-shadow: var(--shadow-lg);
          z-index: 998;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          transition: opacity 0.2s ease, transform 0.2s ease;
          transform-origin: top right;
          opacity: 0;
          transform: scale(0.95) translateY(-10px);
          pointer-events: none;
        }
        .float-assistant-panel.pos-bottom-origin {
          transform-origin: bottom right;
          transform: scale(0.95) translateY(10px);
        }
        .float-assistant-panel.open {
          opacity: 1;
          transform: scale(1) translateY(0);
          pointer-events: auto;
        }

        /* 顶部可拖拽 Header */
        .fap-header {
          background: linear-gradient(135deg, var(--brand), #ff8c42);
          padding: 12px 16px;
          color: #fff;
          display: flex;
          justify-content: space-between;
          align-items: center;
          cursor: grab;
          user-select: none;
        }
        .fap-header:active {
          cursor: grabbing;
        }
        .fap-header-title {
          font-weight: 700;
          font-size: 14.5px;
          display: flex;
          align-items: center;
          gap: 7px;
        }
        .fap-header-actions {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .fap-zoom-controls {
          display: flex;
          align-items: center;
          background: rgba(255, 255, 255, 0.18);
          border-radius: 14px;
          padding: 1px 4px;
        }
        .fap-zoom-badge {
          font-size: 10.5px;
          font-weight: 700;
          color: #fff;
          padding: 0 4px;
          min-width: 32px;
          text-align: center;
        }
        .fap-icon-btn {
          background: transparent;
          border: none;
          color: #fff;
          width: 24px;
          height: 24px;
          border-radius: 50%;
          display: grid;
          place-items: center;
          cursor: pointer;
          transition: background 0.2s;
        }
        .fap-icon-btn:hover {
          background: rgba(255, 255, 255, 0.25);
        }
        .fap-icon-btn:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }
        .fap-header-close {
          background: rgba(255, 255, 255, 0.2);
          border: none;
          color: #fff;
          width: 24px;
          height: 24px;
          border-radius: 50%;
          display: grid;
          place-items: center;
          cursor: pointer;
          transition: background 0.2s;
        }
        .fap-header-close:hover {
          background: rgba(255, 255, 255, 0.35);
        }

        /* 当前页面状态栏与一键分析 */
        .fap-banner {
          background: var(--surface-2);
          border-bottom: 1px solid var(--border);
          padding: 8px 14px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 10px;
        }
        .fap-banner-text {
          font-size: calc(var(--fap-font-size, 13.5px) * 0.92);
          color: var(--text-2);
          display: flex;
          align-items: center;
          gap: 6px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .fap-banner-btn {
          background: var(--brand-soft);
          color: var(--brand);
          border: none;
          border-radius: var(--radius-sm);
          padding: 4px 8px;
          font-size: calc(var(--fap-font-size, 13.5px) * 0.88);
          font-weight: 600;
          display: flex;
          align-items: center;
          gap: 4px;
          cursor: pointer;
          transition: all 0.2s;
          white-space: nowrap;
        }
        .fap-banner-btn:hover {
          background: var(--brand);
          color: #fff;
        }
        .fap-banner-btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        /* 消息滚动区域 */
        .fap-body {
          flex: 1;
          overflow-y: auto;
          padding: 14px;
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        /* 气泡样式 */
        .fap-bubble {
          display: flex;
          gap: 8px;
          max-width: 88%;
          align-items: flex-start;
        }
        .fap-bubble.user {
          align-self: flex-end;
          flex-direction: row-reverse;
        }
        .fap-bubble.assistant {
          align-self: flex-start;
          flex-direction: row;
        }
        .fap-avatar {
          width: 28px;
          height: 28px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          color: #fff;
          flex-shrink: 0;
          font-size: 12px;
        }
        .fap-avatar.user {
          background: var(--surface-3, #64748b);
        }
        .fap-avatar.assistant {
          background: var(--brand);
        }
        .fap-bubble-card {
          padding: 9px 12px;
          border-radius: var(--radius-sm);
          font-size: var(--fap-font-size, 13.5px);
          line-height: 1.55;
          white-space: pre-wrap;
          word-break: break-word;
        }
        .fap-bubble-card.user {
          background: var(--brand);
          color: #fff;
        }
        .fap-bubble-card.assistant {
          background: var(--surface-2);
          color: var(--text);
          border: 1px solid var(--border);
        }
        .fap-bubble-card.error {
          background: var(--red-soft);
          color: var(--red);
          border: 1px solid var(--red);
        }

        /* 「让它直接去做」条：贴在输入框上方，与助手页的移交条同一个位置感 */
        .fap-handoff {
          padding: 8px 14px;
          border-top: 1px solid var(--border);
          background: var(--amber-soft, var(--surface));
          display: flex;
          gap: 10px;
          align-items: center;
          justify-content: space-between;
        }

        /* 参考图预览条 */
        .fap-pics {
          padding: 8px 14px 0;
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          align-items: center;
        }
        /* max-width 要显式给死：globals.css 里有一条针对卡片内图片的 max-width 100% 规则，
           它会让图片的宽度反过来依赖父容器，而父容器又靠内容撑开——解出来是 2px。
           注意这段在 style jsx 的模板串里，注释里不能出现花括号，会破坏 JSX 解析 */
        .fap-pic { width: 46px; height: 46px; max-width: 46px; object-fit: cover; border-radius: 6px; border: 1px solid var(--border); display: block; }
        .fap-pic-x {
          position: absolute; top: -6px; right: -6px;
          width: 18px; height: 18px; line-height: 1; padding: 0;
          border-radius: 50%; border: 1px solid var(--border);
          background: var(--surface); color: var(--text-2); cursor: pointer;
        }
        .fap-pic-btn {
          display: flex; align-items: center; justify-content: center;
          width: 34px; height: 34px; flex-shrink: 0;
          border: 1px solid var(--border); border-radius: 8px;
          background: var(--surface); color: var(--text-2); cursor: pointer;
        }
        .fap-pic-btn:hover { color: var(--brand); border-color: var(--brand); }

        /* 底部输入框 */
        .fap-footer {
          padding: 10px 14px;
          border-top: 1px solid var(--border);
          background: var(--surface);
          display: flex;
          gap: 8px;
          align-items: flex-end;
        }
        .fap-input {
          flex: 1;
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          padding: 8px 10px;
          min-height: 38px;
          max-height: 120px;
          resize: none;
          background: var(--surface);
          color: var(--text);
          font-size: var(--fap-font-size, 13.5px);
          outline: none;
          transition: border-color 0.2s;
        }
        .fap-input:focus {
          border-color: var(--brand);
        }
        .fap-send-btn {
          background: var(--brand);
          color: #fff;
          border: none;
          border-radius: var(--radius-sm);
          width: 36px;
          height: 36px;
          display: grid;
          place-items: center;
          cursor: pointer;
          transition: background 0.2s;
          flex-shrink: 0;
        }
        .fap-send-btn:hover {
          background: #d6431c;
        }
        .fap-send-btn:disabled {
          background: var(--border-strong);
          cursor: not-allowed;
        }

        /* 拉伸 Resize 控制手柄 */
        .fap-resize-handle {
          position: absolute;
          width: 14px;
          height: 14px;
          z-index: 10;
        }
        .fap-resize-handle.bottom-right {
          right: 0;
          bottom: 0;
          cursor: nwse-resize;
          background: linear-gradient(135deg, transparent 50%, var(--brand) 50%);
          border-bottom-right-radius: var(--radius);
          opacity: 0.6;
        }
        .fap-resize-handle.top-left {
          left: 0;
          top: 0;
          cursor: nwse-resize;
          background: linear-gradient(315deg, transparent 50%, var(--brand) 50%);
          border-top-left-radius: var(--radius);
          opacity: 0.6;
        }
      `}</style>

      {/* 位于页面上方（默认 top: 72px）或支持按住自由拖拽到任意位置的入口图标 */}
      <button
        className={`float-assistant-trigger ${!btnPos ? (triggerPosMode === 'top' ? 'pos-top' : 'pos-bottom') : ''}`}
        style={{
          left: btnPos ? `${btnPos.x}px` : undefined,
          top: btnPos ? `${btnPos.y}px` : undefined,
          right: btnPos ? undefined : '24px',
          cursor: 'grab',
        }}
        onMouseDown={onTriggerMouseDown}
        onClick={onTriggerClick}
        title="按住鼠标拖拽可自由移动图标到屏幕任意位置；点击打开 AI 运营助手"
        aria-label="打开 AI 运营助手"
      >
        {isOpen ? <Icon.x size={20} /> : <Icon.chat size={20} />}
      </button>

      {/* 侧边对话面板（支持拖拽位置、缩放字号与扩展放大窗口） */}
      <div
        className={`float-assistant-panel ${triggerPosMode === 'bottom' && !pos ? 'pos-bottom-origin' : ''}${isOpen ? ' open' : ''}`}
        style={panelStyle}
      >
        {/* 角落自由拉伸 Handle */}
        {!isMaximized && (
          <>
            <div
              className="fap-resize-handle bottom-right"
              onMouseDown={(e) => onResizeMouseDown(e, 'bottom-right')}
              title="按住拖拽调整窗口大小"
            />
            {pos && (
              <div
                className="fap-resize-handle top-left"
                onMouseDown={(e) => onResizeMouseDown(e, 'top-left')}
                title="按住拖拽调整窗口大小"
              />
            )}
          </>
        )}

        {/* 可拖拽 Header */}
        <div
          className="fap-header"
          onMouseDown={onHeaderMouseDown}
          onDoubleClick={resetPos}
          title="按住拖拽自由移动位置，双击重置默认位置"
        >
          <div className="fap-header-title">
            <Icon.move size={14} style={{ opacity: 0.8 }} />
            <Icon.sparkles size={16} />
            <span>AI 运营助手</span>
          </div>

          <div className="fap-header-actions" onClick={(e) => e.stopPropagation()}>
            {/* 内容字号放大与缩小 (A- / A+) */}
            <div className="fap-zoom-controls">
              <button
                className="fap-icon-btn"
                onClick={zoomOut}
                disabled={fontScale <= 85}
                title="缩小内容字号 (A-)"
              >
                <Icon.zoomOut size={13} />
              </button>
              <span className="fap-zoom-badge" title="当前内容字号比例">{fontScale}%</span>
              <button
                className="fap-icon-btn"
                onClick={zoomIn}
                disabled={fontScale >= 145}
                title="放大内容字号 (A+)"
              >
                <Icon.zoomIn size={13} />
              </button>
            </div>

            {/* 切换图标/助手默认位置：页面上方 <-> 页面下方 */}
            <button
              className="fap-icon-btn"
              onClick={() => {
                const next = triggerPosMode === 'top' ? 'bottom' : 'top';
                setTriggerPosMode(next);
                setPos(null);
              }}
              title={triggerPosMode === 'top' ? '切到页面下方固定' : '切到页面上方固定'}
            >
              <Icon.refresh size={13} />
            </button>

            {/* 窗口全屏/放大与还原 */}
            <button
              className="fap-icon-btn"
              onClick={() => setIsMaximized(!isMaximized)}
              title={isMaximized ? '还原窗口大小' : '放大窗口'}
            >
              {isMaximized ? <Icon.minimize size={13} /> : <Icon.maximize size={13} />}
            </button>

            {/* 关闭按钮 */}
            <button className="fap-header-close" onClick={() => setIsOpen(false)} title="关闭助手">
              <Icon.x size={14} />
            </button>
          </div>
        </div>

        {/* 当前页面上下文联动栏 */}
        <div className="fap-banner">
          <div className="fap-banner-text" title={`${pageInfo.name} - ${pageInfo.desc}`}>
            <span style={{ color: 'var(--brand)', display: 'flex', alignItems: 'center' }}>
              <Icon.radar size={14} />
            </span>
            <span>当前页面：<b>{pageInfo.name}</b></span>
          </div>
          <button
            className="fap-banner-btn"
            onClick={handleAnalyzePage}
            disabled={streaming}
            title="提取并分析当前页面数据与上下文"
          >
            <Icon.sparkles size={12} />
            <span>一键分析</span>
          </button>
        </div>

        {/* 消息历史 */}
        <div ref={listRef} className="fap-body">
          {messages.map((m, i) => {
            const isUser = m.role === 'user';
            const isError = !isUser && m.error;
            return (
              <div key={i} className={`fap-bubble ${isUser ? 'user' : 'assistant'}`}>
                <div className={`fap-avatar ${isUser ? 'user' : 'assistant'}`}>
                  {isUser ? <Icon.user size={14} /> : <Icon.chat size={14} />}
                </div>
                <div
                  className={`fap-bubble-card ${
                    isUser ? 'user' : isError ? 'error' : 'assistant'
                  }`}
                >
                  {m.content}
                </div>
              </div>
            );
          })}
          {streaming && messages[messages.length - 1]?.content === '' && (
            <div className="fap-bubble assistant">
              <div className="fap-avatar assistant">
                <Icon.chat size={14} />
              </div>
              <div className="fap-bubble-card assistant" style={{ color: 'var(--text-3)' }}>
                思考中…
              </div>
            </div>
          )}
        </div>

        {/* 「让它直接去做」：这个浮标此前只能聊天——在任意页面上说「帮我建个草稿」，
            它会热心地告诉你该怎么做，然后没有然后。而「先答后做」的移交此前只活在
            /assistant 一页，浮标是全站常驻的那个入口，缺了这一步等于说了不算。

            判据用本地规则（looksActionable），不让模型吐控制标记——模型会把标记原样
            抄给用户（提示词泄漏那三次），而这里的收益只是一个按钮显不显示。

            ⚠️ 只**预填**不自动跑：URL 参数带着就开跑的话，任意站点放一个链接就能让
            登录用户发起一次付费执行；用户刷新或分享这个地址也会重复开跑。 */}
        {handoffGoal && (
          <div className="fap-handoff">
            <span className="small">这件事我可以直接去做</span>
            <a
              className="btn btn-sm btn-primary"
              href={`/assistant?goal=${encodeURIComponent(handoffGoal)}`}
            >
              让它直接去做 →
            </a>
          </div>
        )}

        {(pics.length > 0 || picErr) && (
          <div className="fap-pics">
            {pics.map((src, i) => (
              <span key={i} style={{ position: 'relative', display: 'inline-block', width: 46, height: 46, flexShrink: 0 }}>
                <img src={src} alt={`参考图 ${i + 1}`} className="fap-pic" />
                <button
                  className="fap-pic-x"
                  aria-label="移除这张图"
                  onClick={() => setPics((l) => l.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </span>
            ))}
            {picErr && <span className="small" style={{ color: 'var(--red)' }}>{picErr}</span>}
          </div>
        )}

        {/* 输入框 */}
        <div className="fap-footer">
          <textarea
            className="fap-input"
            placeholder="输入您的问题..."
            value={input}
            disabled={streaming}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            rows={1}
          />
          <label
            className="fap-pic-btn"
            title={pics.length >= MAX_PICS ? `最多 ${MAX_PICS} 张` : '带一张参考图问'}
          >
            <Icon.upload size={15} />
            <input
              type="file"
              accept="image/*"
              multiple
              hidden
              disabled={streaming || pics.length >= MAX_PICS}
              onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ''; void addPics(fs); }}
            />
          </label>
          <button
            className="fap-send-btn"
            disabled={streaming || (!input.trim() && pics.length === 0)}
            onClick={() => send(input)}
          >
            <Icon.arrow size={16} />
          </button>
        </div>
      </div>
    </>
  );
}
