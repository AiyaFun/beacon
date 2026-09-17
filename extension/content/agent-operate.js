// AI 在**你日常的浏览器**里看着页面一步步操作 —— 页面侧执行端（2026-09-17）。
//
// 用户原话：「beacon 的插件也可以有这种的功能」「这样子就不用重新开启新的浏览器」。
// 桌面客户端那条路要另起一个采集专用浏览器、每个平台重登一次；插件本来就在他日常 Chrome 里，
// 登录态全都在。这个文件就是让 AI 能用上那个浏览器的那一层。
//
// ⚠️ 本文件是**真正的防线**，不是服务端那份的副本。
//    插件连的服务端地址是可配的（zip 版自己填、私有化各连各的、开发连 localhost）。
//    只在服务端判「这一下能不能点」，等于插件无条件信任服务端——一个被改过地址或被攻陷的
//    服务端就能让**用户已登录的浏览器**去点任意按钮。read-allowlist.js 那一课原文：
//    锚一旦可以被外部改写，防线就不存在。
//
// 【四条硬边界，与 lib/browser-op/actions.ts 文件头逐条对应】
//   ① 动作只有 read / navigate / click / type / scroll —— **没有 eval**，
//      服务端下发什么这里都只能在这几个动词里对号入座，认不出的一律拒绝执行；
//   ② 点击前按**按钮上的字**判不可逆（发布/删除/支付/关注/授权…），命中就**不点**，
//      交回 needConfirm 让用户自己点。认不出字的图标按钮也不点（宁可误伤）；
//   ③ 只动这一页 —— 不开标签、不切标签、不读 cookie/localStorage、不碰文件；
//   ④ 页面上挂可见标识，用户随时看得出「烽火台正在操作这一页」。
//
// 【它怎么被注入】由 sw.js 用 chrome.scripting 动态注入到**用户已单独授权**的那个站点
//（optional_host_permissions），不写进 manifest 的 content_scripts——写进去就等于申请常驻，
// 而这条路只在用户当场发起的那几分钟里存在。
(() => {
  if (globalThis.__beaconOpLoaded) return;
  globalThis.__beaconOpLoaded = true;

  // ── 与 lib/browser-op/actions.ts 逐字一致（tests/browser-op/action-contract.test.ts 对账）──
  const BEACON_OP_ACTIONS = ['read', 'navigate', 'click', 'type', 'scroll', 'wait', 'done'];

  const BEACON_IRREVERSIBLE_PATTERNS = [
    /发布|发表|投稿|提交|发送|发出|立即发|定时发|群发/,
    /\b(publish|post|submit|send|share|tweet|schedule)\b/i,
    /支付|付款|购买|下单|充值|续费|开通|升级套餐|确认订单|立即购买/,
    /\b(pay|checkout|purchase|buy|subscribe|upgrade|order)\b/i,
    /删除|移除|清空|注销|解绑|解除绑定|永久删除|放弃|撤回/,
    /\b(delete|remove|destroy|deactivate|unlink|discard|revoke)\b/i,
    /关注|取关|私信|评论|回复|点赞|转发|拉黑|举报/,
    /\b(follow|unfollow|message|comment|reply|like|retweet|block|report)\b/i,
    /授权|同意|允许|确认|接受|绑定|登录|注册|下一步/,
    /\b(authorize|allow|confirm|accept|agree|bind|login|sign\s?in|sign\s?up|continue|next)\b/i,
  ];

  /**
   * 能不能导航到这个地址。**只认 https**，与 lib/browser-op/actions.ts 的 isNavigableUrl 同一份。
   *
   * ⚠️ `javascript:` 是个合法 scheme，导航过去就是任意脚本执行——那会把「没有 eval」
   * 这条边界整条绕过去。`data:` 能内联一整个页面，`file://` 能读他的磁盘。全部拒绝。
   */
  function beaconOpNavigable(raw) {
    try { return new URL(String(raw)).protocol === 'https:'; } catch { return false; }
  }

  /** 与服务端 isIrreversibleClick 同一份判据：submit 一律算；没有可读文字的也算。 */
  function beaconIrreversible(text, type) {
    if (String(type || '').toLowerCase() === 'submit') return true;
    const t = String(text || '').trim();
    if (!t) return true;
    return BEACON_IRREVERSIBLE_PATTERNS.some((re) => re.test(t));
  }

  // ── ref 映射：每次 read 重建 ──────────────────────────────────────────────
  //
  // 【为什么每次重建而不是累加】页面是活的：SPA 切一次路由，旧的 ref 指向的节点早已不在
  // 文档里。留着旧映射，模型说「点 ref_12」时我们可能点到一个**看不见的残留节点**，
  // 或者更糟——同一个位置现在是另一个按钮。每次 read 重建 + 点击前复验「还在文档里、
  // 还看得见」，两道一起才挡得住。
  let beaconRefs = new Map();
  let beaconRefSeq = 0;

  function beaconVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  }

  /** 元素上的可读文字：优先 aria-label / placeholder / title，再退到 innerText。 */
  function beaconLabel(el) {
    const cand = [
      el.getAttribute && el.getAttribute('aria-label'),
      el.getAttribute && el.getAttribute('placeholder'),
      el.getAttribute && el.getAttribute('title'),
      el.getAttribute && el.getAttribute('alt'),
      el.value && el.type !== 'password' ? el.value : '',
      el.innerText || el.textContent,
    ];
    for (const c of cand) {
      const t = String(c || '').replace(/\s+/g, ' ').trim();
      if (t) return t.slice(0, 120);
    }
    return '';
  }

  function beaconRole(el) {
    const explicit = el.getAttribute && el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = String(el.type || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'submit' || t === 'button') return 'button';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return tag;
  }

  const BEACON_OP_SELECTOR = [
    'a[href]', 'button', 'input', 'textarea', 'select',
    '[role="button"]', '[role="link"]', '[role="textbox"]', '[role="tab"]', '[role="menuitem"]',
    '[contenteditable="true"]', '[onclick]',
  ].join(',');

  /**
   * 读这一页：可交互元素 + 可见正文。
   *
   * ⚠️ **密码框一个字节都不带回**：它的 value 是用户的密码。这条路不替用户登录，
   * 更不该把密码送进模型的上下文（出口脱敏那一课：[[beacon-prompt-leak-lessons]]）。
   */
  function beaconOpRead() {
    beaconRefs = new Map();
    beaconRefSeq = 0;
    const items = [];
    let nodes = [];
    try { nodes = Array.from(document.querySelectorAll(BEACON_OP_SELECTOR)); } catch { nodes = []; }
    for (const el of nodes) {
      if (!beaconVisible(el)) continue;
      const type = String((el.getAttribute && el.getAttribute('type')) || el.type || '').toLowerCase();
      if (type === 'password') continue; // 密码框不进树，模型永远看不到它
      const ref = `ref_${++beaconRefSeq}`;
      beaconRefs.set(ref, el);
      const label = beaconLabel(el);
      items.push({
        ref,
        role: beaconRole(el),
        name: label,
        // 点它会不会不可逆：**先告诉模型**，它就该主动交给用户点，而不是撞上闸再退回来
        irreversible: beaconRole(el) === 'link' ? false : beaconIrreversible(label, type),
        ...(el.disabled ? { disabled: true } : {}),
      });
      if (items.length >= 300) break;
    }
    const text = String((document.body && document.body.innerText) || '').replace(/\n{3,}/g, '\n\n').slice(0, 12000);
    return { ok: true, url: location.href, title: document.title, elements: items, text };
  }

  /** 点击前复验：ref 还在、节点还在文档里、还看得见、没被禁用。 */
  function beaconResolve(ref) {
    const el = beaconRefs.get(String(ref || ''));
    if (!el) return { err: `认不出 ${ref}（页面可能已经变了，请先重新读一次这一页）` };
    if (!el.isConnected) return { err: `${ref} 指的元素已经不在页面上了（页面变过，请重新读一次）` };
    if (!beaconVisible(el)) return { err: `${ref} 现在看不见（可能被弹层盖住或已收起）` };
    if (el.disabled) return { err: `${ref} 是禁用状态，点不了` };
    return { el };
  }

  function beaconOpClick(ref) {
    const r = beaconResolve(ref);
    if (r.err) return { ok: false, error: r.err };
    const el = r.el;
    const label = beaconLabel(el);
    const type = String((el.getAttribute && el.getAttribute('type')) || el.type || '').toLowerCase();
    // 【这道闸在这里才算数】服务端那份只是早失败早说清楚
    if (beaconRole(el) !== 'link' && beaconIrreversible(label, type)) {
      return {
        ok: false,
        needConfirm: true,
        label: label || '（没有可读文字的按钮）',
        error: label
          ? `「${label}」点下去可能不可逆（发布/删除/支付/关注这类），我不替你点。请你自己点一下，或者告诉我确实要点它。`
          : '这个按钮没有可读的文字，我不知道它会做什么，所以不点。请你自己点一下。',
      };
    }
    try {
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
    } catch { /* 滚不动不影响点 */ }
    el.click();
    return { ok: true, clicked: label || beaconRole(el) };
  }

  /**
   * 填写。**只填，不提交**：填完不回车、不触发 submit。
   * 触发 input/change 事件是必须的——React/Vue 受控组件不监听 value 赋值，不派发事件等于没填。
   */
  function beaconOpType(ref, text) {
    const r = beaconResolve(ref);
    if (r.err) return { ok: false, error: r.err };
    const el = r.el;
    const type = String((el.getAttribute && el.getAttribute('type')) || el.type || '').toLowerCase();
    if (type === 'password') return { ok: false, error: '这是密码框。我不替你输密码，请你自己填。' };
    if (type === 'file') return { ok: false, error: '这是文件选择框，这条路不碰你的磁盘。' };
    const value = String(text == null ? '' : text);
    try {
      el.focus();
      if (el.isContentEditable) {
        el.textContent = value;
      } else {
        // 受控组件要走原生 setter，直接赋值会被框架的 value 劫持吃掉
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value');
        if (setter && setter.set) setter.set.call(el, value);
        else el.value = value;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, typed: value.length };
    } catch (e) {
      return { ok: false, error: `填不进去：${(e && e.message) || e}` };
    }
  }

  function beaconOpScroll(direction, amount) {
    const n = Math.min(10, Math.max(1, Number(amount) || 3));
    window.scrollBy({ top: (direction === 'up' ? -1 : 1) * n * Math.round(window.innerHeight * 0.8), behavior: 'instant' });
    return { ok: true, scrollY: Math.round(window.scrollY) };
  }

  // ── 可见标识：用户随时看得出这一页正被操作 ──────────────────────────────
  // 与桌面执行器 BADGE_ON 同一个做法（executor.rs）：一圈边框 + 右上角一行字，
  // pointer-events:none 保证不挡他任何操作（他随时可以自己接管这一页）。
  function beaconOpBadge(on) {
    const ID = '__beacon_op_badge__';
    const old = document.getElementById(ID);
    if (!on) { if (old) old.remove(); return; }
    if (old) return;
    const box = document.createElement('div');
    box.id = ID;
    box.setAttribute('aria-hidden', 'true');
    box.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:2147483647', 'pointer-events:none',
      'border:3px solid #f26b3a', 'box-shadow:inset 0 0 0 1px rgba(255,255,255,.6)',
    ].join(';');
    const tag = document.createElement('div');
    tag.textContent = '烽火台 · AI 正在这一页上操作（你随时可以自己接管）';
    tag.style.cssText = [
      'position:absolute', 'top:8px', 'right:8px', 'background:#f26b3a', 'color:#fff',
      "font:600 12px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      'padding:4px 10px', 'border-radius:0 0 0 8px', 'letter-spacing:.3px',
    ].join(';');
    box.appendChild(tag);
    (document.body || document.documentElement).appendChild(box);
  }

  /**
   * 执行一步。**认不出的动作一律拒绝**——这张表就是这个页面能被做的全部事情。
   * 服务端下发 eval / 开标签 / 读 cookie 之类，这里会如实拒绝并说明，而不是「尽力而为」。
   */
  globalThis.__beaconOpStep = function (step) {
    const action = step && step.action;
    if (!BEACON_OP_ACTIONS.includes(action)) {
      return { ok: false, error: `插件不认识「${action}」这个动作，不执行。` };
    }
    beaconOpBadge(action !== 'done');
    try {
      if (action === 'read') return beaconOpRead();
      if (action === 'click') return beaconOpClick(step.ref);
      if (action === 'type') return beaconOpType(step.ref, step.text);
      if (action === 'scroll') return beaconOpScroll(step.direction, step.amount);
      if (action === 'done') { beaconOpBadge(false); return { ok: true, done: true }; }
      // navigate / wait 由 sw.js 那侧做（前者要 chrome.tabs，后者没必要进页面）
      return { ok: false, error: `「${action}」不在页面侧执行` };
    } catch (e) {
      return { ok: false, error: `执行出错：${(e && e.message) || e}` };
    }
  };

  // 供 sw.js 与单测单独验证判据本身（navigate 在 sw.js 侧执行，那里要用这道闸）
  globalThis.__beaconOpIrreversible = beaconIrreversible;
  globalThis.__beaconOpNavigable = beaconOpNavigable;
  globalThis.__beaconOpRead = beaconOpRead;
})();
