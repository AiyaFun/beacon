import { platformName } from '../constants';

// ── 确认卡上那句人话 ────────────────────────────────────────────────────────
//
// 确认卡是「AI 要动手了，你看一眼再点头」的那一层。它的价值全在**用户真的看懂了**——
// 而在此之前卡上渲染的是 `JSON.stringify(args, null, 2)`：
//
//     {
//       "draftId": "cm4x9k2p0001...",
//       "platforms": ["xiaohongshu", "wechat"]
//     }
//
// 对着这个点「确认执行」，用户点的其实是「我信你」，不是「我看懂了」。而这个产品的用户
// 是内容创作者，不是读 JSON 的人。一层看不懂的确认，和没有这层确认差别不大。
//
// 【为什么是纯函数、不查库】它要在渲染确认卡时同步算出来。id 类参数没法翻成名字
//（那要查库），所以口径是：**能说人话的说人话，说不了的就老实标成「id」并截短**——
// 关键信息（发几个平台、几点跑、印什么字）本来就不在 id 里。

const KEY_LABEL: Record<string, string> = {
  title: '标题',
  content: '正文',
  platform: '平台',
  platforms: '平台',
  draftId: '草稿',
  draft_id: '草稿',
  topicId: '选题',
  publishId: '作品',
  competitor_id: '对标账号',
  competitorId: '对标账号',
  agent_id: '智能体',
  skill_id: '技能',
  slug: '技能',
  limit: '条数',
  count: '数量',
  url: '链接',
  note: '备注',
  keyword: '关键词',
  text: '文案',
  type: '类型',
  scope: '范围',
  days: '天数',
  hour: '几点',
  minute: '几分',
  weekdays: '周几',
  name: '名字',
  persona: '职责说明',
  steps: '步骤',
  subtitle: '副标题',
  topic: '题目',
  kind: '要做的事',
  wait_for_result: '等结果',
  status: '状态',
};

const DOW = ['日', '一', '二', '三', '四', '五', '六'];

/** id 类的值说不出名字，但要让用户看出「这是个内部编号」而不是乱码。 */
function isIdLike(key: string, v: string): boolean {
  return /(^|[A-Za-z])id$|_id$/i.test(key) && v.length > 12;
}

function formatValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return '（空）';
  if (typeof value === 'boolean') return value ? '是' : '否';

  if (Array.isArray(value)) {
    if (value.length === 0) return '（空）';
    // 周几：0=周日。**空数组是「每天」**，但那由调用方在拼句子时说，这里只管非空的
    if (key === 'weekdays') return value.map((d) => `周${DOW[Number(d)] ?? d}`).join('、');
    if (key === 'platforms') return value.map((p) => platformName(String(p))).join('、');
    if (key === 'steps') return `${value.length} 步`;
    return value.map((v) => formatValue(key, v)).slice(0, 6).join('、');
  }

  if (typeof value === 'object') return JSON.stringify(value).slice(0, 60);

  const s = String(value);
  if (key === 'platform') return platformName(s);
  if (isIdLike(key, s)) return `#${s.slice(-6)}`;
  // 正文类参数只给开头：确认卡不是预览器，用户要确认的是「要写一篇稿子」不是逐字读它
  if (s.length > 60) return `${s.slice(0, 60)}…`;
  return s;
}

/**
 * 把工具参数写成一句用户看得懂的话。
 *
 * 空参数返回空串——调用方据此决定「不显示参数区」，而不是显示一个空的 `{}`。
 */
export function describeArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === '' || value === null) continue;
    const label = KEY_LABEL[key] ?? key;
    // 周几为空数组在定时那里的含义是「每天」，是个高频且**反直觉**的口径，单独说清楚
    if (key === 'weekdays' && Array.isArray(value) && value.length === 0) {
      parts.push('周几：每天');
      continue;
    }
    parts.push(`${label}：${formatValue(key, value)}`);
  }
  return parts.join('　');
}
