import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { at, orderedBefore } from '../helpers/anchor';

// 渠道总览（2026-09-01 依用户截图重排）：机器人绑定此前是一张大卡 + 平台下拉，
// 「支持哪些渠道、各自连没连」全藏在下拉里。总览卡把这两件事摊到一屏。
// 这里钉住三件容易在后续改版里被悄悄退掉的事。
const SRC = fs.readFileSync(
  path.join(__dirname, '../../app/(app)/settings/BotIntegrationCard.tsx'), 'utf8',
);
const TYPES = fs.readFileSync(path.join(__dirname, '../../lib/bot/types.ts'), 'utf8');

describe('机器人渠道总览', () => {
  it('🔒 总览来自 BOT_PROVIDERS 单一真相源，不许手抄渠道名单', () => {
    // 手抄一份 ['feishu','dingtalk',…] 的后果：types.ts 加新渠道后总览永远缺一格。
    at(SRC, 'BOT_PROVIDERS.map((p)');
    const stripped = SRC.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    // 允许出现在 find()/name 查询里，但不许出现字面渠道数组
    expect(stripped).not.toMatch(/\[\s*'feishu'\s*,\s*'dingtalk'/);
  });

  it('🔒 未关联的渠道给「接入」主按钮并预选渠道（不让用户再进下拉找一遍）', () => {
    at(SRC, 'openAddFor(c.key)');
    // openAddFor 必须真的设 provider——只开表单不预选，就退回了「藏在下拉里」的老样子
    const fn = SRC.slice(at(SRC, 'function openAddFor'), at(SRC, 'setShowForm(true);', at(SRC, 'function openAddFor')));
    expect(fn).toContain('setProvider(key)');
    // telegram/slack 没有入站路由，预选时必须落 webhook 模式，
    // 否则用户面对的是一张填了也白填的「自建应用」表单
    expect(fn).toMatch(/telegram.*slack.*webhook|webhook.*telegram/s);
  });

  it('🔒 指令权限在卡上只做摘要+launcher，绝不就地编辑（收口的闸不许拆成六个入口）', () => {
    // 2026-09-01 Accio 式改版后：卡上**读** allowCommands 做「默认集/自定义 N 项」摘要是合法的，
    // 不许出现的是**编辑态**（setCommands/逐项开关）——那套开关在编辑表单里有唯一入口。
    const grid = SRC.slice(at(SRC, '{/* 渠道总览'), at(SRC, '{/* 已配置列表与详细配置信息 */}'));
    expect(grid).not.toContain('setCommands');
    // launcher 指向编辑表单（同一个入口），不是新增
    const perm = grid.slice(at(grid, '指令权限'), at(grid, '最近活动'));
    expect(perm, '指令权限的入口没指到编辑表单').toContain('openEdit(c.first!)');
    // 且总览在已配置列表之前（先看全局再看明细）
    orderedBefore(SRC, '{/* 渠道总览', '{/* 已配置列表与详细配置信息 */}');
  });

  it('🔒 统计三格全是真数（beacon 没有配对审核，不许摆恒 0 的「待处理」装样子）', () => {
    const gridRaw = SRC.slice(at(SRC, '{/* 渠道总览'), at(SRC, '{/* 已配置列表与详细配置信息 */}'));
    // 剥掉注释再断言：注释里*说明*为什么不搬「待处理」是应该的，渲染出来才是问题
    //（「被自己的注释骗」假绿清单第五形，本文件已第二次撞上）
    const grid = gridRaw.replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
    // 2026-09-02：三格改成 Accio 同款「用户 / 群聊」（+ 推送订阅），点开是「群聊与用户」抽屉
    expect(grid).toContain("'用户'");
    expect(grid).toContain("'群聊'");
    expect(grid, '搬了 Accio 的「待处理」格——那个量在 beacon 不存在').not.toContain('待处理');
    // 用户/群数来自真表 BotConversation 的会话画像（summarizeChats 汇总），不是写死的
    const stat = SRC.slice(at(SRC, 'const channelStat'), at(SRC, '{/* 渠道总览'));
    expect(stat).toContain('summarizeChats(');
    // 抽屉真的挂上了（数字能点开看是哪些群、哪些人）
    expect(grid).toContain('setChatsFor(c.key)');
    expect(SRC).toContain('<BotChatsDialog');
  });

  it('🔒 已连渠道的「设置机器人」直接打开该绑定的编辑（不是又开一个新增表单）', () => {
    // 2026-09-01 用户第三次拿 Accio 截图来：每张渠道卡要有自己的设置入口。
    // 点「设置」却打开空白新增表单 = 把已配好的人引去重配一遍。
    const grid = SRC.slice(at(SRC, '{/* 渠道总览'), at(SRC, '{/* 已配置列表与详细配置信息 */}'));
    expect(grid).toContain('openEdit(c.first');
  });

  it('🔒 最近活动同时看出站与入站（只看一个会把另一方向的机器人冤枉成没动静）', () => {
    const stat = SRC.slice(at(SRC, 'const channelStat'), at(SRC, '{/* 渠道总览'));
    expect(stat).toContain('lastOutboundAt');
    expect(stat).toContain('lastInboundAt');
  });

  it('🔒 报错的机器人在卡上有红字提示（lastError 不许静默）', () => {
    const grid = SRC.slice(at(SRC, '{/* 渠道总览'), at(SRC, '{/* 已配置列表与详细配置信息 */}'));
    expect(grid).toMatch(/erring|lastError/);
    expect(grid).toContain('报错');
  });

  it('🔒 接入/设置表单是 Overlay 弹窗，不是就地渲染（2026-09-01 Accio 式改版）', () => {
    // 就地渲染的 fixed 遮罩会被 .card:hover 的 transform 关进卡片（Overlay.tsx 文件头 602×110 实测）。
    // 这条守卫和付款/退款那批同源：所有弹层必须走 components/Overlay。
    const form = SRC.slice(at(SRC, '{showForm ? ('), at(SRC, '</Overlay>'));
    expect(form, '表单没包在 Overlay 里——又回到就地渲染').toContain('<Overlay');
    expect(form, '弹窗里少了关闭钮').toContain('aria-label="关闭"');
  });

  it('🔒 连接弹窗里有「渠道默认智能体」且真的随保存提交（Accio 会话默认插件位）', () => {
    const form = SRC.slice(at(SRC, '{showForm ? ('), at(SRC, '</Overlay>'));
    expect(form).toContain('渠道默认智能体');
    // 只画下拉不提交 = 选了白选（写了没接的 UI 版）
    expect(SRC, 'save 的 payload 没带 agentTemplateId').toMatch(/actSaveBot\(\{[\s\S]*?agentTemplateId: agentTpl/);
    // 编辑态要把已绑的带回表单，否则一保存就静默清空
    expect(SRC, 'openEdit 没回填 agentTpl —— 编辑一次就把绑定冲掉').toContain('setAgentTpl(r.agentTemplateId ?? ');
  });

  it('🔒 微信两条路都是真渠道（2026-09-02 定稿）：主卡=官方 iLink 扫码绑定，客服卡=企业微信对外服务', () => {
    // 演进：09-01 说明卡 → 客服真渠道 → 09-02 查实微信官方 iLink 接口后，主「微信」卡改成它，
    // 网关扫码那套（非官方协议）整个删除。真相源里两条都要在，且分工说破。
    expect(TYPES).toMatch(/key:\s*'wechat'/);
    expect(TYPES, '主卡没说破是官方 iLink').toMatch(/key:\s*'wechat'[^\n]*iLink/);
    expect(TYPES).toMatch(/key:\s*'wechat_kf'/);
    expect(TYPES, '客服真相源里没说破只答不推').toMatch(/48\s*小时|48h/);
    const form = SRC.slice(at(SRC, '{showForm ? ('), at(SRC, '</Overlay>'));
    // 客服弹窗里要把两条路的分工说在做决定的地方：自己用 → 微信卡；对外接客 → 客服
    expect(form).toMatch(/对外服务/);
    expect(form).toMatch(/「微信」卡/);
    // 微信主卡新接入直接走扫码组件，不套通用密钥表单
    expect(form).toContain("provider === 'wechat' && !editing ? (");
    expect(form).toContain('<WechatIlinkConnect');
    // 推送开关对只答不推的渠道（微信 iLink / 微信客服）必须整段隐藏（摆开关=空承诺）
    expect(form).toContain("!isReplyOnlyProvider(provider) && (");
    // 绝不再出现「非官方协议 / 封号」那套措辞——那是被删掉的网关方案的口径，留着就是说谎
    const stripped = SRC.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\/[^\n]*/g, '');
    expect(stripped).not.toMatch(/非官方协议|封号/);
  });

  it('telegram/slack 在真相源里标了仅出站（总览 hint 直接透出，别在这骗人）', () => {
    expect(TYPES).toMatch(/telegram[\s\S]{0,120}仅出站/);
    expect(TYPES).toMatch(/slack[\s\S]{0,120}仅出站/);
  });
});
