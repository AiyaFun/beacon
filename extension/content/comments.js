// 评论读取器——按需注入（executeScript），不进 manifest。
// ⚠️ 必须整体 IIFE 包裹：内容脚本共用同一个 isolated world 的全局词法环境，
// 顶层 const/function 第二次注入直接 SyntaxError("Identifier has already been declared")，
// 整个文件不执行。
//
// 读什么、不读什么（这条边界就是产品本身）：
//   读：评论正文文本节点。
//   不取：昵称、头像、主页链接、用户ID、IP属地、点赞数、时间、楼中楼回复关系、@提及。
//   不是"读了不传"——是根本不取。payload 里没有 author 字段。
//
// 不滚动、不翻页、不点「加载更多」。一行 scrollIntoView/scrollBy/sleep 都不写。
// 这不是省事——它是能写进披露的那句字面为真的话：
//   "插件只读取你当前屏幕上已经显示出来的评论，不替你翻页、不替你展开、不加载你没看到的内容。"

(function () {
  'use strict';

  const MAX_COMMENTS = 200;
  const MIN_LEN = 5;
  const MAX_LEN = 60;

  // 前缀噪声：同 questions.ts:46 的 NOISE_PREFIX
  // ⚠️ 昵称用 [^\s:：]+ 不是 \S+：中文"回复 张三：正文"冒号前后无空格，
  // 贪婪匹配会把整句正文吃掉
  const NOISE_PREFIX = /^[\s\d.、)）:：]*(?:回复\s*[^\s:：]+\s*[:：]?\s*|@[^\s]+\s*)?/;

  const PERSONAL_PATTERNS = [
    /1[3-9]\d{9}/,
    /\S+@\S+\.\S+/,
    /\d{17}[\dXx]/,
    /[A-Za-z][\w-]{5,19}/,
    /IP属地[:：]/,
    /来自\S{2,4}$/,
  ];

  // 各平台评论区的选择器候选（按优先级排列，第一个命中的胜出）
  // ⚠️ 全部未经真机校准——上线前必须跑 tools/comments-probe.js
  const PLATFORM_RULES = {
    douyin: {
      containers: [
        '[data-e2e="comment-list"]',
        '[data-e2e="video-comment"]',
        '[data-e2e="feed-comment"]',
      ],
      items: [
        '[data-e2e="comment-item"]',
        '[data-e2e="comment-list-item"]',
      ],
      // 正文节点：评论容器内要排除昵称/时间/点赞/回复按钮，只取纯文本段落
      textInItem: [
        '[data-e2e="comment-text"]',
        'p',
        'span:not([class*="name"]):not([class*="time"]):not([class*="like"]):not([class*="reply"])',
      ],
    },
    bilibili: {
      containers: [
        'bili-comments',
      ],
      items: [
        'bili-comment-thread-renderer',
      ],
      textInItem: [
        'bili-rich-text',
        '#content',
        '.reply-content',
      ],
      shadow: true,
    },
    xiaohongshu: {
      containers: [
        '.comments-container',
        '.comment-wrapper',
        '[class*="comment-list"]',
      ],
      items: [
        '.comment-item',
        '[class*="commentItem"]',
      ],
      textInItem: [
        '.content',
        '.note-text',
        'p',
      ],
    },
    youtube: {
      containers: [
        '#comments',
        'ytd-comments',
      ],
      items: [
        'ytd-comment-thread-renderer',
        'ytd-comment-renderer',
      ],
      textInItem: [
        '#content-text',
        'yt-formatted-string#content-text',
      ],
    },
    x: {
      containers: [
        '[aria-label*="Timeline"]',
        'section[role="region"]',
      ],
      items: [
        'article[data-testid="tweet"]',
      ],
      textInItem: [
        '[data-testid="tweetText"]',
        '[lang]',
      ],
    },
    tiktok: {
      containers: [
        '[data-e2e="comment-list"]',
        '[class*="CommentList"]',
      ],
      items: [
        '[data-e2e="comment-list-item"]',
        '[class*="CommentItem"]',
      ],
      textInItem: [
        '[data-e2e="comment-level-1"] p',
        'p[data-e2e="comment-level-1"]',
        'p',
      ],
    },
  };

  function detectPlatform() {
    const h = location.hostname;
    if (h.includes('douyin.com')) return 'douyin';
    if (h.includes('bilibili.com')) return 'bilibili';
    if (h.includes('xiaohongshu.com')) return 'xiaohongshu';
    if (h.includes('youtube.com')) return 'youtube';
    if (h.includes('x.com') || h.includes('twitter.com')) return 'x';
    if (h.includes('tiktok.com')) return 'tiktok';
    return null;
  }

  function findContainer(rules) {
    for (const sel of rules.containers) {
      if (sel === 'bili-comments') {
        const el = document.querySelector(sel);
        if (el && el.shadowRoot) return { el: el.shadowRoot, shadow: true };
        if (el) return { el, shadow: false };
        continue;
      }
      const el = document.querySelector(sel);
      if (el) return { el, shadow: false };
    }
    return null;
  }

  function readItems(container, rules) {
    const items = [];
    for (const itemSel of rules.items) {
      const els = container.el.querySelectorAll(itemSel);
      if (els.length > 0) {
        for (const el of els) {
          if (items.length >= MAX_COMMENTS) break;
          // 如果是 shadow host (bili), 尝试进 shadowRoot
          const root = (rules.shadow && el.shadowRoot) ? el.shadowRoot : el;
          const text = extractText(root, rules.textInItem);
          if (text) items.push(text);
        }
        break;
      }
    }
    return items;
  }

  function extractText(root, textSelectors) {
    for (const sel of textSelectors) {
      const node = root.querySelector(sel);
      if (node) {
        let t = (node.textContent || '').trim();
        t = t.replace(NOISE_PREFIX, '').trim();
        if (t.length >= MIN_LEN && t.length <= MAX_LEN) return t;
        if (t.length > MAX_LEN) return t.slice(0, MAX_LEN);
        if (t.length > 0 && t.length < MIN_LEN) return null;
      }
    }
    // 最后兜底：取整个 item 的 textContent 然后截取
    const raw = (root.textContent || '').trim();
    const cleaned = raw.replace(NOISE_PREFIX, '').trim();
    if (cleaned.length >= MIN_LEN) {
      return cleaned.length > MAX_LEN ? cleaned.slice(0, MAX_LEN) : cleaned;
    }
    return null;
  }

  // ── 来源闸：确认抓到的是评论列表，不是导航/推荐位/作品简介 ──
  function validateSource(items) {
    if (items.length < 3) return { ok: false, reason: 'too_few' };
    // 单条长度方差过小（像标题列而不像评论）
    const lens = items.map((t) => t.length);
    const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
    const variance = lens.reduce((a, b) => a + (b - avg) ** 2, 0) / lens.length;
    if (variance < 4 && items.length > 5) return { ok: false, reason: 'uniform_length' };
    return { ok: true };
  }

  // ── 出口形状闸：确认昵称没被当成正文前缀带上来 ──
  function validateShape(items) {
    // 任一条命中时间戳 → 整批拒
    if (items.some((t) => /\d+[天小时分钟秒]前/.test(t))) {
      return { ok: false, reason: 'timestamp_in_text' };
    }
    // 任一条以 UI 文本结尾 → 整批拒
    if (items.some((t) => /(回复|展开|查看全部|更多回复)$/.test(t))) {
      return { ok: false, reason: 'ui_text_suffix' };
    }
    // ≥60% 共享同一个 2-4 字前缀 → 那就是昵称列
    if (items.length >= 5) {
      const prefixes = {};
      for (const t of items) {
        for (let len = 2; len <= 4 && len < t.length; len++) {
          const p = t.slice(0, len);
          prefixes[p] = (prefixes[p] || 0) + 1;
        }
      }
      for (const [p, count] of Object.entries(prefixes)) {
        if (count >= items.length * 0.6 && p.length >= 2) {
          return { ok: false, reason: 'shared_prefix', prefix: p };
        }
      }
    }
    return { ok: true };
  }

  // 简单的 isQuestion 判定（与 questions.ts 同一逻辑，但不引入模块依赖）
  const STRONG = [
    '为什么', '为啥', '怎么办', '怎么弄', '怎么做', '如何', '是不是', '能不能', '可不可以',
    '有没有', '要不要', '值不值', '值得吗', '哪个好', '哪家好', '求推荐', '求教程', '求分享',
    '请问', '想问', '想知道', '有推荐吗', '多久', '多少钱', '贵不贵', '难不难', '靠谱吗',
  ];
  const DEMAND = [
    '求一期', '什么时候出', '想看', '蹲', '能出个', '教程', '催更', '更新',
    '求一个', '出一期', '讲一下', '说一下', '详细讲', '展开讲',
  ];
  const TAIL = ['吗', '呢'];
  const WEAK = ['怎么', '哪个', '哪些', '什么时候', '在哪'];

  function classifyComment(text) {
    const t = text.replace(NOISE_PREFIX, '').trim();
    if (t.length < MIN_LEN || t.length > MAX_LEN) return null;
    if (PERSONAL_PATTERNS.some((re) => re.test(t))) return null;
    if (DEMAND.some((w) => t.includes(w))) return { text: t, kind: 'demand' };
    if (STRONG.some((w) => t.includes(w))) return { text: t, kind: 'question' };
    const tail = t.replace(/[\s?？!！。,，~～、.]+$/u, '').slice(-1);
    if (TAIL.includes(tail)) return { text: t, kind: 'question' };
    if (!/[?？]/.test(t)) return null;
    if (WEAK.some((w) => t.includes(w))) return { text: t, kind: 'question' };
    return null;
  }

  // 归并（共享 ≥1 个非功能词 2-gram）
  const STOP_BIGRAMS = new Set([
    '怎么', '么办', '有没', '没有', '能做', '做吗', '什么', '这个', '一下', '可以', '不是',
    '是不', '不能', '能不', '要不', '不要', '为什', '如何', '哪个', '哪些', '还是',
  ]);

  function bigrams(text) {
    const out = new Set();
    for (let i = 0; i < text.length - 1; i++) {
      const bg = text.slice(i, i + 2);
      if (!STOP_BIGRAMS.has(bg)) out.add(bg);
    }
    return out;
  }

  function groupQuestions(classified) {
    const groups = [];
    for (const c of classified) {
      const bg = bigrams(c.text);
      const hit = groups.find((g) => {
        for (const x of bg) {
          if (g.bigrams.has(x)) return true;
        }
        return false;
      });
      if (hit) {
        hit.members.push(c.text);
        hit.kind = hit.kind === 'demand' ? 'demand' : c.kind;
        if (c.text.length > hit.rep.length) hit.rep = c.text;
        for (const x of bg) hit.bigrams.add(x);
      } else {
        groups.push({ rep: c.text, kind: c.kind, bigrams: bg, members: [c.text] });
      }
    }
    return groups
      .map((g) => ({
        text: g.rep,
        count: g.members.length,
        variants: [...new Set(g.members.filter((m) => m !== g.rep))].slice(0, 3),
        kind: g.kind,
      }))
      .sort((a, b) => b.count - a.count || a.text.length - b.text.length)
      .slice(0, 12);
  }

  // ── 主流程 ──
  const platform = detectPlatform();
  if (!platform) {
    return { ok: false, reason: 'unknown_platform' };
  }

  const rules = PLATFORM_RULES[platform];
  if (!rules) {
    return { ok: false, reason: 'no_rules', platform };
  }

  const container = findContainer(rules);
  if (!container) {
    return { ok: false, reason: 'no_container', platform, probe: { tried: rules.containers } };
  }

  const rawTexts = readItems(container, rules);
  if (rawTexts.length === 0) {
    return { ok: false, reason: 'no_items', platform, probe: { container: true, items: 0 } };
  }

  const srcCheck = validateSource(rawTexts);
  if (!srcCheck.ok) {
    return { ok: false, reason: srcCheck.reason, platform, probe: { items: rawTexts.length } };
  }

  const shapeCheck = validateShape(rawTexts);
  if (!shapeCheck.ok) {
    return { ok: false, reason: shapeCheck.reason, platform, probe: { items: rawTexts.length, detail: shapeCheck } };
  }

  const classified = rawTexts.map(classifyComment).filter(Boolean);
  if (classified.length === 0) {
    return { ok: true, platform, read: rawTexts.length, questions: [] };
  }

  const questions = groupQuestions(classified);

  // 尝试获取作品 ID 和标题
  let workId = null;
  let workTitle = null;
  try {
    if (typeof globalThis.__beaconParse === 'function') {
      const p = globalThis.__beaconParse();
      if (p && p.posts && p.posts[0]) {
        workId = p.posts[0].platformItemId || null;
        workTitle = p.posts[0].title || null;
      }
    }
  } catch { /* ignore */ }

  return {
    ok: true,
    platform,
    workId,
    workTitle,
    read: rawTexts.length,
    questions,
    probe: { containers: 1, items: rawTexts.length, classified: classified.length },
  };
})();
