// 烽火台 · 发布填充脚本（半自动发布）。
//
// ⚠️ 这个脚本**默认不点发布按钮**：只把烽火台里备好的标题/正文/标签填进你自己的创作后台表单，
// 然后停下来。发布是对外的意思表示，「填错了还能改」和「已经发出去了」之间就靠这一下分界。
//
// 用户可以在插件设置里**显式打开「代点发布」**（autoClickPublish，默认关）。打开之后：
//   · 只有**标题与正文都填成功**才会去找发布按钮——半填状态绝不点；
//   · 点之前有 **5 秒倒计时 + 取消按钮**，这是不可逆动作前的最后一道刹车；
//   · 找不到明确的发布按钮就**不点**，如实报 filled，绝不乱点页面上别的按钮；
//   · 一旦点了，回执报 published 但**不带链接**（拿不到作品地址），由用户回填。
// 平台创作者协议普遍不欢迎自动化发布，风险由打开开关的人自己承担——设置页和这里都写明了。
//
// ⚠️ 选择器**尚未真机校准**（2026-08-18）。平台后台改版频繁，填不进去是预期内的情况，
// 所以每一步都有诚实降级：找不到输入框就把内容复制到剪贴板并如实告诉你「没填进去，已复制」，
// 绝不假装填好了。回执里报的也是 failed 而不是 filled。

(function () {
  if (window.__beaconPublishFillLoaded) return;
  window.__beaconPublishFillLoaded = true;

  const PLATFORM_BY_HOST = {
    'creator.douyin.com': 'douyin',
    'creator.xiaohongshu.com': 'xiaohongshu',
    'member.bilibili.com': 'bilibili',
    'channels.weixin.qq.com': 'shipinhao',
    // ── 大陆图文平台（0.9.5）：这几家都没有对个人开放的发布接口，只能走这条半自动的路 ──
    'zhuanlan.zhihu.com': 'zhihu',
    'www.zhihu.com': 'zhihu',
    'mp.toutiao.com': 'toutiao',
    'baijiahao.baidu.com': 'baijiahao',
    'cp.kuaishou.com': 'kuaishou',
  };

  const platform = PLATFORM_BY_HOST[location.hostname];
  if (!platform) return;

  // 各平台发布页的输入框。**多写几个候选**：后台改版通常只换掉其中一个，
  // 留一串候选比只押一个能多扛几次改版。全都落空时走降级，不猜、不乱填。
  const SELECTORS = {
    douyin: {
      title: ['input[placeholder*="标题"]', '.title-input input', 'input.semi-input[maxlength]'],
      body: ['div[data-placeholder*="作品简介"]', '.editor-kit-container [contenteditable="true"]', 'div[contenteditable="true"]'],
    },
    xiaohongshu: {
      title: ['input[placeholder*="标题"]', '.title-input input', '.d-text input'],
      body: ['div[contenteditable="true"]', '#post-textarea', 'textarea[placeholder*="正文"]'],
    },
    bilibili: {
      title: ['input[placeholder*="标题"]', '.video-title input', 'input.input-val'],
      body: ['div[contenteditable="true"]', 'textarea[placeholder*="简介"]', '.video-desc textarea'],
    },
    shipinhao: {
      title: ['input[placeholder*="标题"]', '.post-title input'],
      body: ['div[contenteditable="true"]', 'textarea[placeholder*="描述"]'],
    },
    zhihu: {
      title: ['textarea[placeholder*="标题"]', '.WriteIndex-titleInput textarea', 'input[placeholder*="标题"]'],
      body: ['div[contenteditable="true"]', '.public-DraftEditor-content', '.Editable-unstyled'],
    },
    toutiao: {
      title: ['input[placeholder*="标题"]', 'textarea[placeholder*="标题"]', '.article-title input'],
      body: ['div[contenteditable="true"]', '.ProseMirror', '.ql-editor'],
    },
    baijiahao: {
      title: ['input[placeholder*="标题"]', 'textarea[placeholder*="标题"]', '.cheetah-input'],
      body: ['div[contenteditable="true"]', '.editor-content', '.ql-editor'],
    },
    kuaishou: {
      title: ['input[placeholder*="标题"]', '.title-input input'],
      body: ['div[contenteditable="true"]', 'textarea[placeholder*="描述"]', 'textarea[placeholder*="简介"]'],
    },
  };

  // 发布按钮。**宁可找不到，也不许找错**：错点一个别的按钮（存草稿/删除/退出）比不点严重得多。
  // 所以这里只认「文字里带发布且不带草稿/预览/定时」的按钮，且必须可见、可点。
  const PUBLISH_BUTTON_TEXT = /^(发布|立即发布|发表|确认发布|发布视频|发布笔记|发布文章)$/;
  const PUBLISH_BUTTON_DENY = /(草稿|预览|定时|设置|取消|返回|删除)/;

  function findPublishButton() {
    const cands = [...document.querySelectorAll('button, [role="button"], a.btn, div[class*="publish"]')];
    for (const el of cands) {
      const txt = (el.innerText || el.textContent || '').replace(/\s+/g, '');
      if (!txt || txt.length > 8) continue;
      if (PUBLISH_BUTTON_DENY.test(txt)) continue;
      if (!PUBLISH_BUTTON_TEXT.test(txt)) continue;
      if (el.offsetParent === null) continue; // 不可见的不算
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      return el;
    }
    return null;
  }

  function pick(list) {
    for (const sel of list || []) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) return el;
    }
    return null;
  }

  // React/Vue 受控组件不认直接赋值：必须走原生 setter + 派发 input 事件，
  // 否则你看到框里有字、框架的 state 里却是空的，一点发布就又变回空白。
  function setInputValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setEditable(el, text) {
    el.focus();
    // contenteditable 编辑器（抖音/小红书/B站都是自研富文本）对 innerText 赋值多半不认，
    // execCommand 虽然被标记为废弃，却是目前唯一能让这些编辑器收到「用户输入」的通道。
    const ok = document.execCommand && document.execCommand('insertText', false, text);
    if (!ok) {
      el.innerText = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
  }

  async function fillTask(task) {
    const conf = SELECTORS[platform] || {};
    const titleEl = pick(conf.title);
    const bodyEl = pick(conf.body);

    if (!titleEl && !bodyEl) {
      await copyFallback(task);
      return { ok: false, reason: '这一页没找到标题/正文输入框（可能是后台改版，或当前不在发布页）。内容已复制到剪贴板，手动粘贴即可。' };
    }
    if (titleEl) setInputValue(titleEl, task.title || '');
    if (bodyEl) {
      const body = [task.content || '', (task.topics || []).map((t) => `#${t}`).join(' ')].filter(Boolean).join('\n\n');
      if (bodyEl.tagName === 'TEXTAREA' || bodyEl.tagName === 'INPUT') setInputValue(bodyEl, body);
      else setEditable(bodyEl, body);
    }
    // 只填了一半也要说清楚是哪一半——用户才知道自己还得补什么
    if (!titleEl || !bodyEl) {
      return { ok: false, reason: `只填进了${titleEl ? '标题' : '正文'}，另一半没找到输入框，请手动补。` };
    }
    return { ok: true };
  }

  /** 不可逆动作前的最后一道刹车：n 秒倒计时，点「取消」就不点了。返回 true = 用户取消。 */
  function countdown(statusEl, seconds) {
    return new Promise((resolve) => {
      let left = seconds;
      const cancel = document.createElement('button');
      cancel.textContent = '取消';
      cancel.style.cssText = 'margin-left:8px;padding:2px 8px;border-radius:6px;border:1px solid #c4841d;background:#fff;color:#c4841d;cursor:pointer';
      statusEl.after(cancel);
      const tick = () => {
        statusEl.textContent = `${left} 秒后自动点发布…`;
        statusEl.style.color = '#c4841d';
        if (left <= 0) {
          clearInterval(timer);
          cancel.remove();
          resolve(false);
          return;
        }
        left -= 1;
      };
      cancel.onclick = () => {
        clearInterval(timer);
        cancel.remove();
        resolve(true);
      };
      tick();
      const timer = setInterval(tick, 1000);
    });
  }

  async function copyFallback(task) {
    try {
      await navigator.clipboard.writeText(`${task.title}\n\n${task.content}`);
    } catch {
      /* 剪贴板可能因为页面没聚焦而失败，不影响主流程 */
    }
  }

  function send(type, payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type, ...payload }, (r) => resolve(r || { ok: false, error: '插件后台没有响应' }));
    });
  }

  function panel(tasks) {
    const box = document.createElement('div');
    box.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483000',
      'width:300px', 'max-height:60vh', 'overflow:auto', 'background:#fff',
      'border:1px solid #e5e5e5', 'border-radius:12px', 'padding:12px',
      'box-shadow:0 8px 28px rgba(0,0,0,.14)', 'font:13px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif',
      'color:#1a1a1a',
    ].join(';');

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;font-weight:600';
    head.innerHTML = '<span>烽火台 · 待发布</span>';
    const close = document.createElement('button');
    close.textContent = '×';
    close.style.cssText = 'border:none;background:none;font-size:18px;cursor:pointer;line-height:1';
    close.onclick = () => box.remove();
    head.appendChild(close);
    box.appendChild(head);

    const note = document.createElement('div');
    note.style.cssText = 'font-size:12px;color:#666;margin-bottom:8px';
    note.textContent = '内容只会被填进表单，发布按钮由你自己点。';
    box.appendChild(note);

    tasks.forEach((task) => {
      const row = document.createElement('div');
      row.style.cssText = 'border-top:1px solid #f0f0f0;padding-top:8px;margin-top:8px';
      const title = document.createElement('div');
      title.textContent = task.title;
      title.style.cssText = 'font-weight:600;margin-bottom:6px;word-break:break-all';
      row.appendChild(title);

      const status = document.createElement('div');
      status.style.cssText = 'font-size:12px;color:#666;margin-top:6px';

      const btn = document.createElement('button');
      btn.textContent = '填入本页';
      btn.style.cssText = 'padding:5px 10px;border-radius:8px;border:1px solid #e8552d;background:#e8552d;color:#fff;cursor:pointer';
      btn.onclick = async () => {
        btn.disabled = true;
        status.textContent = '填充中…';
        const r = await fillTask(task);
        if (!r.ok) {
          status.textContent = r.reason;
          status.style.color = '#c4841d';
          await send('publish:receipt', { taskId: task.id, status: 'failed', error: r.reason });
          btn.disabled = false;
          return;
        }

        // 填成功了。默认到此为止；开了代点才继续，且要先走完倒计时。
        const cfg = await chrome.storage.sync.get(['autoClickPublish']);
        if (cfg.autoClickPublish !== true) {
          status.textContent = '已填好，检查无误后你自己点发布';
          status.style.color = '#12a150';
          await send('publish:receipt', { taskId: task.id, status: 'filled' });
          btn.disabled = false;
          return;
        }

        const target = findPublishButton();
        if (!target) {
          // 找不到就**不点**。这是刻意的：乱点比不点危险得多。
          status.textContent = '已填好，但没认出发布按钮（可能是后台改版）——请你自己点一下发布';
          status.style.color = '#c4841d';
          await send('publish:receipt', { taskId: task.id, status: 'filled' });
          btn.disabled = false;
          return;
        }

        const cancelled = await countdown(status, 5);
        if (cancelled) {
          status.textContent = '已取消代点，内容还在表单里，你可以自己检查后再发';
          status.style.color = '#c4841d';
          await send('publish:receipt', { taskId: task.id, status: 'filled' });
          btn.disabled = false;
          return;
        }

        target.click();
        // 点了就是点了：如实报 published。但**没有作品链接**——平台跳转与审核都要时间，
        // 这里拿不到地址，回执不带 url，由用户之后在发布中心回填。
        status.textContent = '已代你点了发布。去平台确认一下，然后把作品链接贴回发布中心';
        status.style.color = '#12a150';
        await send('publish:receipt', { taskId: task.id, status: 'published' });
        btn.disabled = false;
      };
      row.appendChild(btn);
      row.appendChild(status);
      box.appendChild(row);
    });

    document.body.appendChild(box);
  }

  async function boot() {
    const r = await send('publish:pending', { platform });
    if (!r || !r.ok || !Array.isArray(r.tasks) || r.tasks.length === 0) return;
    panel(r.tasks);
  }

  // 后台是 SPA，进站时未必已经在发布页；延后一点再问，且只问一次（不做轮询——
  // 轮询会在用户完全没有发布意图时反复打断他）。
  setTimeout(boot, 1500);
})();
