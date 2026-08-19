// 烽火台 · 发布填充脚本（半自动发布）。
//
// ⚠️ 这个脚本**永远不点发布按钮**。它只做一件事：把烽火台里备好的标题/正文/标签填进
// 你自己的创作后台表单，然后停下来。发布是对外的意思表示，必须由你亲手点——
// 这既是各平台创作者协议的要求，也是「填错了还能改」和「已经发出去了」之间唯一的分界。
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
  };

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
        status.textContent = r.ok ? '已填好，检查无误后你自己点发布' : r.reason;
        status.style.color = r.ok ? '#12a150' : '#c4841d';
        // 回执如实报：填不进去就是 failed，绝不因为「点过按钮了」就报 filled
        await send('publish:receipt', {
          taskId: task.id,
          status: r.ok ? 'filled' : 'failed',
          error: r.ok ? undefined : r.reason,
        });
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
