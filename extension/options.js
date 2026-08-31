const DEFAULT_HOST = 'https://beacon.iyunci.cn';

const hostEl = document.getElementById('host');
const tokenEl = document.getElementById('token');
const msgEl = document.getElementById('msg');

const showInPageAiEl = document.getElementById('showInPageAi');
const autoCollectEl = document.getElementById('autoCollect');
const taskPollEl = document.getElementById('taskPoll');
const liveViewEl = document.getElementById('liveView');
const dailyReminderEl = document.getElementById('dailyReminder');

const scheduledCollectEl = document.getElementById('scheduledCollect');
const scheduledCollectHourEl = document.getElementById('scheduledCollectHour');
const scheduledStatusLogEl = document.getElementById('scheduledStatusLog');

const selfAutoEl = document.getElementById('selfAutoCollect');
const selfAutoHourEl = document.getElementById('selfAutoHour');

const commentCollectOwnEl = document.getElementById('commentCollectOwn');
const wechatRiskAckEl = document.getElementById('wechatRiskAck');
const autoClickPublishEl = document.getElementById('autoClickPublish');
const commentCollectRivalEl = document.getElementById('commentCollectRival');

// Populate hour dropdowns (00:00 - 23:00)
[scheduledCollectHourEl, selfAutoHourEl].forEach((selectEl) => {
  selectEl.innerHTML = '';
  for (let h = 0; h < 24; h++) {
    const o = document.createElement('option');
    o.value = String(h);
    o.textContent = `${String(h).padStart(2, '0')}:00`;
    selectEl.appendChild(o);
  }
});

function show(text, ok) {
  msgEl.textContent = text;
  msgEl.className = ok ? 'ok' : 'err';
}

function currentHost() {
  return (hostEl.value.trim() || DEFAULT_HOST).replace(/\/$/, '');
}

async function renderScheduledStatusLog() {
  const { lastScheduledCollectLog } = await chrome.storage.local.get('lastScheduledCollectLog');
  if (!lastScheduledCollectLog || !lastScheduledCollectLog.timestamp) {
    scheduledStatusLogEl.textContent = '⏰ 定时采集状态：设定每日定时任务已挂载，等待整点自动触发';
    return;
  }
  const dateStr = new Date(lastScheduledCollectLog.timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  scheduledStatusLogEl.textContent = `⏰ 最近一次定时采集：${dateStr} | ${lastScheduledCollectLog.summary || '已触发'}`;
}

// 最近一次公众号自动回填的结果。试跑与定时走的是同一条路（runSelfAuto），
// 所以这里显示的就是定时那一轮也会得到的结论——不给「请查看系统通知」这种查不到的指引。
async function renderSelfAutoLog() {
  const el = document.getElementById('selfAutoStatusLog');
  if (!el) return;
  const { lastSelfAutoLog } = await chrome.storage.local.get('lastSelfAutoLog');
  if (!lastSelfAutoLog || !lastSelfAutoLog.timestamp) {
    el.textContent = '📥 公众号回填：还没跑过';
    return;
  }
  const dateStr = new Date(lastSelfAutoLog.timestamp).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  el.textContent = `📥 最近一次公众号回填：${dateStr} | ${lastSelfAutoLog.summary || '已触发'}`;
}

// Read settings
chrome.storage.sync
  .get([
    'host',
    'token',
    'showInPageAi',
    'autoCollect',
    'taskPoll',
    'dailyReminder',
    'scheduledCollect',
    'scheduledCollectHour',
    'selfAutoCollect',
    'selfAutoHour',
    'commentCollectOwn',
    'autoClickPublish',
    'commentCollectRival',
    'liveView',
  ])
  .then((s) => {
    hostEl.value = s.host || DEFAULT_HOST;
    if (s.token) tokenEl.value = s.token;

    showInPageAiEl.checked = s.showInPageAi !== false;
    autoCollectEl.checked = s.autoCollect !== false;
    // 默认开：不开的话「AI 派了活」对用户就是个永远不动的待办（与 sw.js armTaskPollAlarm 同一判法）
    taskPollEl.checked = s.taskPoll !== false;
    // 默认关：只有显式存过 true 才算开（与 autoClickPublish 同款判法）
    liveViewEl.checked = s.liveView === true;
    dailyReminderEl.checked = s.dailyReminder !== false;

    scheduledCollectEl.checked = s.scheduledCollect !== false; // 默认开启
    scheduledCollectHourEl.value = String(Number.isInteger(s.scheduledCollectHour) ? s.scheduledCollectHour : 9);

    selfAutoEl.checked = s.selfAutoCollect === true;
    selfAutoHourEl.value = String(Number.isInteger(s.selfAutoHour) ? s.selfAutoHour : 9);

    commentCollectOwnEl.checked = s.commentCollectOwn === true;
    // 默认关：只有显式存过 true 才算开（=== true，不是真值判断）
    autoClickPublishEl.checked = s.autoClickPublish === true;
    commentCollectRivalEl.checked = s.commentCollectRival === true;

    renderScheduledStatusLog();
    renderSelfAutoLog();
  });

// 公众号采集的风险确认。**不走 storage.sync**：它是「这台设备上这个人」作出的意思表示，
// 不该跨设备同步；而且它带版本号（告知内容改了要重新确认），判定逻辑只有 sw.js 一份。
// 这里只问 sw.js 要状态、把结果反映到开关上。
chrome.runtime.sendMessage({ type: 'wechat-risk-status' })
  .then((r) => { if (wechatRiskAckEl) wechatRiskAckEl.checked = r?.acked === true; })
  .catch(() => {});

// ── 回填归属：绑定一个创作账号 ──
// 不绑定就由服务端按平台猜（同平台第一个活跃账号）。一个工作区经营两个抖音号时这必然错一半，
// 而挂错账号在数据看板上是**彻底看不见**（每页都 where accountId=当前账号），
// 还会带着另一个号的数字污染基线与学习信号（2026-07-25 真机事故）。
const selfAccountEl = document.getElementById('selfAccount');
const ACCOUNT_PLATFORM_NAME = {
  bilibili: 'B站', douyin: '抖音', xiaohongshu: '小红书', youtube: 'YouTube',
  x: 'X', wechat: '公众号', shipinhao: '视频号', tiktok: 'TikTok', multi: '多平台',
};

async function loadAccounts(force = false) {
  const r = await chrome.runtime.sendMessage({ type: 'beacon-get-accounts', force });
  // 「（按平台自动匹配）」那一项是模板的一部分，重建时保留
  selfAccountEl.length = 1;
  if (!r?.ok) {
    if (force) show(r?.error || '拉取账号列表失败——请先填好服务器地址与令牌并保存', false);
    return;
  }
  for (const a of r.accounts || []) {
    const o = document.createElement('option');
    o.value = a.id;
    // textContent 而不是 innerHTML：账号名是用户自己填的，可能带 < >
    o.textContent = `${ACCOUNT_PLATFORM_NAME[a.platform] || a.platform} · ${a.name}${a.status !== 'active' ? '（已停用）' : ''}`;
    selfAccountEl.appendChild(o);
  }
  selfAccountEl.value = r.selfAccountId || '';
  if (force) {
    show(
      (r.accounts || []).length ? `✓ 已拉到 ${r.accounts.length} 个账号` : '这个工作区还没有创作账号，请先到烽火台里建一个',
      (r.accounts || []).length > 0,
    );
  }
}

selfAccountEl.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({ type: 'beacon-set-account', accountId: selfAccountEl.value });
  const label = selfAccountEl.options[selfAccountEl.selectedIndex]?.textContent || '';
  show(selfAccountEl.value ? `✓ 之后的「这是我的作品」都回填到「${label}」` : '✓ 已改回「按平台自动匹配」', true);
});
document.getElementById('refreshAccounts').addEventListener('click', () => loadAccounts(true));
loadAccounts();

// Event Listeners for Quick Auto-Save Toggles
showInPageAiEl.addEventListener('change', () => chrome.storage.sync.set({ showInPageAi: showInPageAiEl.checked }));
autoCollectEl.addEventListener('change', () => chrome.storage.sync.set({ autoCollect: autoCollectEl.checked }));
// 存进 sync 就够了：sw.js 的 onChanged 监听到 taskPoll 变化会自己重设/清掉闹钟
taskPollEl.addEventListener('change', () => chrome.storage.sync.set({ taskPoll: taskPollEl.checked }));
liveViewEl.addEventListener('change', () => chrome.storage.sync.set({ liveView: liveViewEl.checked }));
dailyReminderEl.addEventListener('change', () => chrome.storage.sync.set({ dailyReminder: dailyReminderEl.checked }));

scheduledCollectEl.addEventListener('change', () => {
  chrome.storage.sync.set({ scheduledCollect: scheduledCollectEl.checked });
  show(
    scheduledCollectEl.checked
      ? `已开启每日定时自动采集：每天 ${String(scheduledCollectHourEl.value).padStart(2, '0')}:00 执行`
      : '已暂停每日定时采集',
    true,
  );
});

scheduledCollectHourEl.addEventListener('change', () => {
  const hour = Number(scheduledCollectHourEl.value);
  chrome.storage.sync.set({ scheduledCollectHour: hour });
  if (scheduledCollectEl.checked) {
    show(`已将每日定时采集调整为每天 ${String(hour).padStart(2, '0')}:00 执行`, true);
  }
});

selfAutoEl.addEventListener('change', () => {
  chrome.storage.sync.set({ selfAutoCollect: selfAutoEl.checked });
  show(
    selfAutoEl.checked
      ? `已开启：每天 ${String(selfAutoHourEl.value).padStart(2, '0')}:00 自动回填公众号数据`
      : '已关闭公众号数据自动回填',
    true,
  );
});

selfAutoHourEl.addEventListener('change', () => {
  chrome.storage.sync.set({ selfAutoHour: Number(selfAutoHourEl.value) });
  if (selfAutoEl.checked) show(`已改为每天 ${String(selfAutoHourEl.value).padStart(2, '0')}:00 执行公众号回填`, true);
});

commentCollectOwnEl.addEventListener('change', () => {
  chrome.storage.sync.set({ commentCollectOwn: commentCollectOwnEl.checked });
  show(commentCollectOwnEl.checked ? '已开启自有作品评论提问采集' : '已关闭自有作品评论提问采集', true);
});
wechatRiskAckEl?.addEventListener('change', async () => {
  const on = wechatRiskAckEl.checked;
  const r = await chrome.runtime.sendMessage({ type: 'wechat-risk-ack', acked: on }).catch(() => null);
  // 以 sw.js 回的结果为准再回写一次开关：写失败时开关不能停在用户以为生效的那个位置，
  // 那会让人觉得「我明明关了」而它还在采。
  wechatRiskAckEl.checked = r?.acked === true;
  show(
    wechatRiskAckEl.checked
      ? '已开启公众号竞对采集：风险由你自己的公众号账号承担'
      : '已关闭公众号竞对采集：插件不再发起任何公众号后台请求',
    true,
  );
});
autoClickPublishEl.addEventListener('change', () => {
  chrome.storage.sync.set({ autoClickPublish: autoClickPublishEl.checked });
  show(
    autoClickPublishEl.checked
      ? '已开启代点发布：填完会有 5 秒倒计时，随时可取消'
      : '已关闭代点发布：只填内容，发布按钮由你自己点',
    true,
  );
});

commentCollectRivalEl.addEventListener('change', () => {
  chrome.storage.sync.set({ commentCollectRival: commentCollectRivalEl.checked });
  show(commentCollectRivalEl.checked ? '已开启竞对作品评论提问采集' : '已关闭竞对作品评论提问采集', true);
});

// Test Scheduled Collect Trial
document.getElementById('runScheduledNow').addEventListener('click', async () => {
  show('正在触发每日定时采集试跑… 正在后台轮询更新竞对并生成概览通知', true);
  await chrome.runtime.sendMessage({ type: 'beacon-run-scheduled-now' }).catch(() => {});
  setTimeout(renderScheduledStatusLog, 2000);
});

// Test Self Auto Run
document.getElementById('selfAutoRunNow').addEventListener('click', async () => {
  if (!selfAutoEl.checked) {
    show('请先开启上面的「每天自动回填我的公众号数据」开关', false);
    return;
  }
  show('已开始试跑：将在后台标签页打开公众号后台并自动处理，结果会显示在下面这行', true);
  await chrome.runtime.sendMessage({ type: 'beacon-self-auto-run-now' }).catch(() => {});
  // 一轮最长 90 秒（SELF_AUTO_TIMEOUT_MS），中途每 3 秒刷一次；结果落盘后这行就会变。
  const started = Date.now();
  const poll = setInterval(async () => {
    await renderSelfAutoLog();
    if (Date.now() - started > 95000) clearInterval(poll);
  }, 3000);
});

document.getElementById('jumpHome').addEventListener('click', () => {
  chrome.tabs.create({ url: currentHost() });
});

document.getElementById('openTokenPage').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: `${currentHost()}/settings` });
});

// Save configuration
document.getElementById('save').addEventListener('click', async () => {
  const host = currentHost();
  const token = tokenEl.value.trim();
  if (!/^https?:\/\//.test(host)) return show('服务器地址需以 http(s):// 开头', false);
  hostEl.value = host;
  await chrome.storage.sync.set({
    host,
    token,
    showInPageAi: showInPageAiEl.checked,
    autoCollect: autoCollectEl.checked,
    taskPoll: taskPollEl.checked,
    dailyReminder: dailyReminderEl.checked,
    scheduledCollect: scheduledCollectEl.checked,
    scheduledCollectHour: Number(scheduledCollectHourEl.value),
    selfAutoCollect: selfAutoEl.checked,
    selfAutoHour: Number(selfAutoHourEl.value),
  });
  show('✓ 配置与定时采集规则已成功保存！', true);
});

// Test API Connection
document.getElementById('test').addEventListener('click', async () => {
  const host = currentHost();
  const token = tokenEl.value.trim();
  if (!token) return show('请先输入采集令牌 (Ingest Token)', false);
  show('正在测试与 Beacon 烽火台服务器的连接…', true);
  try {
    const res = await fetch(`${host}/api/ingest/competitor`, { headers: { 'x-beacon-ingest-token': token } });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) show(`✓ 连接成功！工作区：${data.workspace}`, true);
    else show(data.error || `连接失败（HTTP ${res.status}）`, false);
  } catch (e) {
    show(`连接失败：${e && e.message ? e.message : e}`, false);
  }
});

// 顶部徽标的版本号：只有 manifest 是唯一事实来源。任何写死的副本都会在下一次发版时变成谎言。
(() => {
  const el = document.getElementById('brandVersion');
  if (!el) return;
  try { el.textContent = `v${chrome.runtime.getManifest().version}`; } catch { el.remove(); }
})();

// ── 版本与更新 ──
// 商店版和 zip 版是两条通道、天然不同步（商店随审核走）。这里把「你装的是哪一种」也说出来，
// 否则用户对着「有新版」却不知道该去商店等、还是该下 zip。
(async () => {
  const sub = document.getElementById('versionSub');
  const btn = document.getElementById('checkUpdate');
  if (!sub || !btn) return;
  const render = (info) => {
    if (!info) return;
    const via = info.from === 'normal' ? '商店安装' : info.from === 'development' ? '开发者模式加载' : '安装方式未知';
    if (info.error) { sub.textContent = `当前 v${info.current}（${via}）· 检查失败：${info.error}`; return; }
    sub.textContent = info.hasUpdate
      ? `当前 v${info.current}（${via}）· 有新版 v${info.latest}`
      : `当前 v${info.current}（${via}）· 已是最新`;
  };
  const ask = async (m) => { try { return await chrome.runtime.sendMessage(m); } catch (e) { return { error: String(e && e.message || e) }; } };
  render(await ask({ type: 'beacon-check-update' }));
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    sub.textContent = '正在检查…';
    const info = await ask({ type: 'beacon-check-update', force: true });
    render(info);
    if (info && info.hasUpdate) {
      const r = await ask({ type: 'beacon-apply-update' });
      // 结果照后台原话显示：zip 版无法自我替换，这一步必须说清楚要人接手
      if (r && (r.message || r.error)) sub.textContent = r.message || r.error;
    }
    btn.disabled = false;
  });
})();
