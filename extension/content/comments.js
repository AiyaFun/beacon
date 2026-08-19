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

  // 手抄自 lib/comment-collect-rules.ts（插件是纯 js，import 不了 TS 常量）。
  // 每一个数字都由 tests/ingest/comment-questions.test.ts 比对钉死，别单边改。
  const MAX_COMMENTS = 200;
  const MIN_LEN = 5;
  const MAX_LEN = 60;
  // 一次最多回传几条。服务端 zod 是 `.max(MAX_QUESTIONS_PER_RUN)`——插件比它大的话
  // **整批**会被 400 打回（不是截断），用户看到的是「数据格式不合法」这种看不懂的错。
  const MAX_QUESTIONS = 12;
  // 评论正文（读者原声）：与提问是**两条链路**。提问要归并、要 ≥2 人问过；
  // 正文逐条回传，用户在网页端直接读。身份信息一个字段都不多带——见文件头的不取清单。
  const MAX_COMMENT_TEXT_LEN = 300;
  const MAX_COMMENT_TEXTS = 200;

  // 前缀噪声：同 questions.ts:46 的 NOISE_PREFIX
  // ⚠️ 昵称用 [^\s:：]+ 不是 \S+：中文"回复 张三：正文"冒号前后无空格，
  // 贪婪匹配会把整句正文吃掉
  const NOISE_PREFIX = /^[\s\d.、)）:：]*(?:回复\s*[^\s:：]+\s*[:：]?\s*|@[^\s]+\s*)?/;

  // ⚠️ 与 lib/ingest/comment-questions.ts 的 PERSONAL_PATTERNS 逐条对齐，
  // 由 tests/ingest/comment-classifier-sync.test.ts 钉死，不许单边改。
  // 「微信号形态」不能写成 /[A-Za-z][\w-]{5,19}/：那会把 Chrome / Python / ChatGPT
  // 这类普通英文词当成微信号，把科技类提问整类静默丢掉（真机实测 6 条丢 5 条）。
  const PERSONAL_PATTERNS = [
    /1[3-9]\d{9}/,
    /\S+@\S+\.\S+/,
    /\d{17}[\dXx]/,
    /(?:^|[^0-9A-Za-z_-])(?=[0-9A-Za-z_-]*[0-9_-])[A-Za-z][0-9A-Za-z_-]{5,19}(?![0-9A-Za-z_-])/,
    /(?:微信|威信|薇信|v信|vx|wx|扣扣|QQ)[^0-9A-Za-z]{0,4}[0-9A-Za-z_-]{5,20}/i,
    /IP属地[:：]/,
    /来自\S{2,4}$/,
  ];

  // 各平台评论区的选择器候选（按优先级排列，第一个命中的胜出）。
  //
  // 2026-08-08 真机校准（用户真实 Chrome 逐平台实测，样本见当日会话）：
  //   douyin / bilibili / xiaohongshu / youtube / x 五平台已校准；tiktok 未登录看不到评论，仍未校准。
  // 每个平台的取数策略写在各自条目的注释里。改任何一条选择器，必须同步 tools/comments-probe.js
  // 的副本并重跑探针（tests/ingest/comment-scope.test.ts 钉死两边一致）。
  const PLATFORM_RULES = {
    douyin: {
      // 实测：video-comment / feed-comment 只存在 *-icon 变体（评论按钮），不是容器，已删。
      containers: [
        '[data-e2e="comment-list"]',
      ],
      items: [
        '[data-e2e="comment-item"]',
      ],
      // 正文节点没有任何 data-e2e 标记，类名全是编译期哈希（FduGc_lz 这类，随构建变）。
      // 唯一稳定的锚是每条评论必有的「x前·地名」时间行：正文行 = 时间行的前一个兄弟。
      // 纯表情评论没有正文行（时间行的前兄弟直接是昵称行）→ 返回 null 正确跳过。
      // 实测 10 条：6 条干净正文、4 条纯表情跳过，昵称/时间/IP属地零混入。
      textStrategy: 'time-anchor',
      textInItem: [],
    },
    bilibili: {
      containers: [
        'bili-comments',
      ],
      items: [
        'bili-comment-thread-renderer',
      ],
      // 实测：正文藏在四层 open shadow 里，逐层为
      //   thread-renderer → bili-comment-renderer → bili-rich-text → p#contents
      // thread 的 shadowRoot 里直查 bili-rich-text / #content 全部落空，textContent 也是空串
      // （shadow 边界不透传）——所以只能整链声明，readItems 逐层进 shadowRoot。
      // querySelector 取文档序第一个 bili-comment-renderer = 主楼（楼中楼在其后的
      // bili-comment-replies-renderer 里），read 口径天然 = 主楼数。
      shadowChain: ['bili-comment-renderer', 'bili-rich-text', '#contents'],
      shadow: true,
    },
    xiaohongshu: {
      containers: [
        '.comments-container',
      ],
      // :not(.comment-item-sub)：实测 20 个 .comment-item 里 10 个是楼中楼子回复，
      // 不排除的话 read 虚高一倍、子回复被当独立评论。
      items: [
        '.comment-item:not(.comment-item-sub)',
      ],
      // .content 实测干净：item 原文是「昵称+正文+时间+IP+赞数」，.content 只含正文。
      // 泛 'p' 兜底已删——.content 缺席时宁可 no_items 响亮失败，不冒采进昵称的险。
      textInItem: [
        '.content',
        '.note-text',
      ],
    },
    youtube: {
      containers: [
        'ytd-comments',
        '#comments',
      ],
      // ytd-comment-renderer 已被 YouTube 废弃（新架构是 ytd-comment-view-model），
      // thread-renderer 是唯一入口；thread 内第一个 #content-text = 主楼，实测干净。
      items: [
        'ytd-comment-thread-renderer',
      ],
      textInItem: [
        '#content-text',
      ],
    },
    x: {
      // 实测：中文界面 aria-label 是本地化文本，[aria-label*="Timeline"] 永远不命中，
      // section[role="region"] 才是稳定首选（保留 Timeline 当英文界面的备选无妨）。
      containers: [
        'section[role="region"]',
        '[aria-label*="Timeline"]',
      ],
      // [tabindex="0"]：status 详情页里主推文自己也是 article[data-testid="tweet"]，
      // 但主推文 tabindex="-1"、回复全是 "0"（实测 12 条）。不排除主推文，
      // 作者自己的话就会被当成读者评论收进去——那是记进别人名下的数据污染。
      items: [
        'article[data-testid="tweet"][tabindex="0"]',
      ],
      // '[lang]' 兜底已删：它会命中用户名等非正文节点。
      textInItem: [
        '[data-testid="tweetText"]',
      ],
    },
    tiktok: {
      // 2026-08-08 按抖音同思路配置（用户拍板「根据抖音的一样就好」）：data-e2e 埋点为主
      // （TikTok 与抖音同源的埋点体系，comment-level-1 是网页版评论正文的长期稳定标记），
      // 条目补 DivCommentItemContainer / DivCommentObjectWrapper（TikTok 网页版实际类名模式）。
      // ⚠️ 真机验证只到「[class*="CommentList"] 容器存在」（未登录评论面板空白）——
      // 登录 TikTok 后跑 tools/comments-probe.js 走一遍两道闸即算校准完成。
      // 泛 'p' 兜底已删，同全站纪律：宁可 no_items 响亮失败，不冒采进昵称/时间的险。
      containers: [
        '[data-e2e="comment-list"]',
        '[class*="CommentList"]',
      ],
      items: [
        '[data-e2e="comment-list-item"]',
        '[class*="DivCommentItemContainer"]',
        '[class*="DivCommentObjectWrapper"]',
        '[class*="CommentItem"]',
      ],
      textInItem: [
        '[data-e2e="comment-level-1"] p',
        'p[data-e2e="comment-level-1"]',
        '[data-e2e="comment-level-1"]',
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
      let els = [];
      try { els = container.el.querySelectorAll(itemSel); } catch { continue; }
      if (els.length > 0) {
        for (const el of els) {
          if (items.length >= MAX_COMMENTS) break;
          let text = null;
          if (rules.shadowChain) {
            text = extractViaShadowChain(el, rules.shadowChain);
          } else if (rules.textStrategy === 'time-anchor') {
            text = extractViaTimeAnchor(el);
          } else {
            const root = (rules.shadow && el.shadowRoot) ? el.shadowRoot : el;
            text = extractText(root, rules.textInItem);
          }
          if (text) items.push(text);
        }
        break;
      }
    }
    return items;
  }

  // 尾部清洗：三种策略共用的出口。长度不够 = 这条没有可收的文本（返回 null，不硬凑）。
  function finalizeText(raw) {
    let t = (raw || '').trim().replace(/\s+/g, ' ');
    t = t.replace(NOISE_PREFIX, '').trim();
    if (t.length > MAX_LEN) return t.slice(0, MAX_LEN);
    if (t.length >= MIN_LEN) return t;
    return null;
  }

  // B站：逐层进 open shadowRoot。链上任何一步落空（比如纯图评论没有 #contents 文本）→ null。
  function extractViaShadowChain(el, chain) {
    let node = el;
    for (const sel of chain) {
      const root = node.shadowRoot;
      if (!root) return null;
      try { node = root.querySelector(sel); } catch { return null; }
      if (!node) return null;
    }
    return finalizeText(node.textContent);
  }

  // 抖音：时间行锚点。每条评论必有「x前(·地名)」行，正文行是它的前一个兄弟；
  // 前兄弟是昵称行（含 more 按钮 / info-wrap）说明这条没有正文行（纯表情）→ null。
  // 时间与 IP 属地都在锚点行里，正文取的是它的前兄弟——两样都不会混进正文。
  const TIME_ANCHOR_RE = /^(\d+\s*[天周小时分钟月年秒]+前|刚刚|昨天|前天|今天)/;
  function extractViaTimeAnchor(item) {
    let anchor = null;
    for (const n of item.querySelectorAll('span, div, p')) {
      const own = [...n.childNodes]
        .filter((x) => x.nodeType === 3)
        .map((x) => x.textContent)
        .join('')
        .trim();
      if (own && TIME_ANCHOR_RE.test(own)) { anchor = n; break; }
    }
    if (!anchor) return null;
    let n = anchor;
    while (n && n !== item) {
      const prev = n.previousElementSibling;
      if (prev) {
        if (prev.querySelector('[data-e2e="video-comment-more"]') || /info-wrap/.test(prev.className || '')) {
          return null;
        }
        return finalizeText(prev.textContent);
      }
      n = n.parentElement;
    }
    return null;
  }

  function extractText(root, textSelectors) {
    for (const sel of textSelectors) {
      const node = root.querySelector(sel);
      if (node) {
        // 命中即定局：这个节点就是正文位，文本不够长（含 0 长——纯表情评论）就是
        // 这条没有可收的文本，返回 null 跳过这一条。绝不再试下一个选择器或兜底——
        // 2026-08-08 小红书真机：纯表情评论 .content 空串，旧逻辑落进整条 item 的
        // textContent 兜底，把「昵称+3天前+广东+赞数」当正文捞上来，形状闸整批拒发，
        // 一条脏数据毁掉整页。
        let t = (node.textContent || '').trim();
        t = t.replace(NOISE_PREFIX, '').trim();
        if (t.length > MAX_LEN) return t.slice(0, MAX_LEN);
        return t.length >= MIN_LEN ? t : null;
      }
    }
    // 指定选择器全部落空 = 页面改版，这条没有可靠正文。宁可 no_items 响亮失败
    // 让人来跑探针，也不拿整条 item 的 textContent（昵称/时间/IP 混装）顶数。
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
  // ⚠️ 只收祈使/索取结构，不收话题名词。放进「教程 / 更新 / 蹲 / 想看」这类裸词，
  // 「感谢更新」「教程收藏了」这种纯夸奖会当场被判成诉求（真机实测十条全中）。
  // 与 lib/topic/sources/questions.ts 的 DEMAND 逐字对齐，由测试钉死。
  const DEMAND = [
    '求一期', '求一个', '求个', '求更新', '求出',
    '催更', '蹲一个', '蹲一期', '蹲个',
    '什么时候出', '什么时候更新', '啥时候出', '啥时候更新',
    '能出个', '能出一期', '能不能出', '可以出个', '出一期',
    '想看你', '想看看', '还想看', '想看更多',
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

  // ── 读者原声（评论正文）──
  //
  // classifyComment 只认疑问句和内容诉求，其余一律 null——那是「提问进灵感箱、参与选题」
  // 这条链路该有的严格。但「粉丝在关心什么」恰恰大量落在被它丢掉的那些评论里：
  // 认可点在哪、吐槽什么、反复提到哪些具体名词。所以正文另走一条链路：一条都不丢，只做分类。
  //
  // ⚠️ 判定顺序不能改：DEMAND / STRONG 必须排在 PRAISE 前面。「感谢更新」「教程收藏了」
  // 这类纯夸奖里含「更新」「教程」，而 PRAISE 若排前面又会把「求更新」吃成认可——
  // 2026-08-08「裸词进 DEMAND 导致十条夸奖全判成诉求」是同一个坑的另一面。
  const PRAISE = [
    '好看', '好听', '喜欢', '爱了', '绝了', '太美', '厉害', '牛', '赞', '支持',
    '学到', '有用', '感谢', '谢谢', '收藏了', '干货', '优秀', '可爱', '漂亮',
    '感动', '治愈', '舒服', '精彩', '用心', '专业', '实用', '哈哈',
  ];
  const COMPLAINT = [
    '难看', '难听', '垃圾', '割韭菜', '恰饭', '广告', '无聊', '失望', '太贵', '好贵',
    '踩雷', '翻车', '水文', '差评', '没用', '听不清', '看不清', '字太小', '太快了',
    '太长', '骗', '假的', '智商税', '劝退', '退款', '尬',
  ];
  // 正面词前面挂了否定字就不是夸奖：「不好看」「没意思」——列举变体永远列不全，看前一个字。
  const NEGATORS = ['不', '没', '别', '莫', '难'];

  function hitsPositive(t) {
    for (const w of PRAISE) {
      let from = 0;
      for (;;) {
        const i = t.indexOf(w, from);
        if (i < 0) break;
        if (i === 0 || !NEGATORS.includes(t[i - 1])) return true;
        from = i + 1;
      }
    }
    return false;
  }

  function classifyKind(t) {
    if (DEMAND.some((w) => t.includes(w))) return 'demand';
    if (STRONG.some((w) => t.includes(w))) return 'question';
    const tail = t.replace(/[\s?？!！。,，~～、.]+$/u, '').slice(-1);
    if (TAIL.includes(tail)) return 'question';
    if (/[?？]/.test(t) && WEAK.some((w) => t.includes(w))) return 'question';
    if (COMPLAINT.some((w) => t.includes(w))) return 'complaint';
    if (hitsPositive(t)) return 'praise';
    return 'other';
  }

  function toCommentText(raw) {
    const t = raw.replace(NOISE_PREFIX, '').trim();
    if (t.length < MIN_LEN) return null;
    // PII 命中**整条丢弃**（不脱敏、不截断——留一半更危险），且判在截断**之前**：
    // 先切成 300 字再查，正好被切断的手机号就查不出来了。
    if (PERSONAL_PATTERNS.some((re) => re.test(t))) return null;
    const text = t.length > MAX_COMMENT_TEXT_LEN ? `${t.slice(0, MAX_COMMENT_TEXT_LEN)}…` : t;
    return { text, kind: classifyKind(text) };
  }

  function collectCommentTexts(rawTexts) {
    const out = [];
    const seen = new Set();
    for (const raw of rawTexts) {
      const c = toCommentText(raw);
      if (!c) continue;
      // 同页重复：同一条评论被容器和楼中楼两个选择器各命中一次时会重复出现，
      // 不去掉的话「说这话的人有几个」会虚高一倍（小红书 comment-item-sub 那次的形状）。
      if (seen.has(c.text)) continue;
      seen.add(c.text);
      out.push(c);
      if (out.length >= MAX_COMMENT_TEXTS) break;
    }
    return out;
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
      // 只有被两人以上问过的才往外发。隐私政策第 6 条 ⑥ 的原话是「孤立的单条评论不落库」，
      // 而最干净的兑现方式是**根本不传**：传了再让服务端丢，那句话在网络这一段就已经不成立了。
      // 服务端另有一道同样的闸（lib/ingest/comment-questions.ts）——插件是用户本地的旧版本，
      // 不能指望它，两道都要有。数值同 lib/comment-collect-rules.ts 的 MIN_ASKED_TO_STORE。
      .filter((q) => q.count >= 2)
      .sort((a, b) => b.count - a.count || a.text.length - b.text.length)
      .slice(0, MAX_QUESTIONS);
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

  // 正文与提问是两条独立链路，**不能共用早退**：这里原先写着「没有一条提问就直接
  // return questions: []」，正文接上去之后那个分支会连正文一起吞掉——
  // 一整页全是夸奖和吐槽（没有疑问句）时，用户看到的就是「读了 40 条，什么都没有」。
  const comments = collectCommentTexts(rawTexts);

  const classified = rawTexts.map(classifyComment).filter(Boolean);
  const questions = classified.length ? groupQuestions(classified) : [];

  // 尝试获取作品 ID、标题、作者 handle
  //
  // ⚠️ handle 是「这条提问算自有还是竞对」的唯一可靠依据，必须在这里取。
  // Service Worker 那边判不了：它读 `globalThis.__beaconSelfOnly` 永远是 undefined
  // （那个标记由 self-backend.js 写在**内容脚本的隔离世界**，SW 有自己的全局作用域），
  // 于是只剩 URL 正则 /creator|studio|manage|dashboard/ 兜底——而作品详情页
  // （www.douyin.com/video/xxx）一个词都不匹配，自己作品的读者提问会**全部**记成竞对提问。
  // 这正是 2026-07-25 回填挂错账号那类事故的同一形状：不是显示得不对，是记进了别人名下。
  let workId = null;
  let workTitle = null;
  let handle = null;
  try {
    if (typeof globalThis.__beaconParse === 'function') {
      const p = globalThis.__beaconParse();
      if (p && p.posts && p.posts[0]) {
        workId = p.posts[0].platformItemId || null;
        workTitle = p.posts[0].title || null;
      }
      if (p && p.handle) handle = String(p.handle);
    }
  } catch { /* ignore */ }

  return {
    ok: true,
    platform,
    workId,
    workTitle,
    handle,
    // 创作者后台标记：self-backend.js 一加载就置它。只有内容脚本读得到，所以在这里带出去。
    selfOnly: globalThis.__beaconSelfOnly === true,
    read: rawTexts.length,
    questions,
    // 读者原声。只有正文与粗分类两个字段——评论者是谁、什么时候说的、拿了多少赞，
    // 这里一个都没有，也不是「读了不传」，是 toCommentText 根本没去取（见文件头清单）。
    comments,
    probe: { containers: 1, items: rawTexts.length, classified: classified.length, comments: comments.length },
  };
})();
