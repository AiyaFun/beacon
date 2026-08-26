// 定时计划「什么时候跑」的人话说法。
//
// 【为什么单独一个文件】需要它的有两处：定时那张表（客户端组件 Schedules.tsx）和
// AI 的 list_schedules（服务端）。而 lib/workflow/schedule.ts 里有 prisma，
// 客户端一 import 就打包失败——同 [[beacon-dual-shell]] 里 next/headers 那个坑的形状：
// tsc 与单测都不会红，只有真机打开页面才炸。所以纯函数单独放在这里，两侧都能 import。
//
// 【口径只有一处】weekdays **空数组 = 每天**（见 lib/workflow/schedule.ts 的 shouldRun：
// 长度为 0 时直接跳过星期判断）。写成「长度 7 才算每天」是错的，而且错得很静——
// 界面上会把一条天天跑的计划显示成「每周日、一、二…」，或者反过来把空数组显示成
// 「一天都不跑」，用户据此以为计划坏了。

/** 周几的字。勾选框那一排也用它——两处各写一份的话，改了顺序只会改到一边 */
export const DOW = ['日', '一', '二', '三', '四', '五', '六'];

export const hhmm = (h: number, m: number) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

/** 「每天 09:00」/「每周一、三 09:00」。时刻一律北京时间（容器跑 UTC，直说数字会差 8 小时）。 */
export function scheduleWhen(weekdays: number[], atHour: number, atMinute: number): string {
  const t = hhmm(atHour, atMinute);
  return weekdays.length === 0 ? `每天 ${t}` : `每周${weekdays.map((d) => DOW[d]).join('、')} ${t}`;
}

/**
 * 这条定时到点了派什么，给人看的一句话。
 *
 * 【为什么要有它】定时现在可以指向两种东西：一条流水线模板，或一条预设任务
 *（后者可能跑的是自主智能体）。三个地方要显示它——设置页的表、跑动记录、
 * 还有喂给模型的 list_schedules。各写各的迟早对不上，而且都要处理
 * 「模板/卡被删了」这种情况（那时字段是 null）。
 */
export function scheduleTargetLabel(row: {
  targetKind?: string | null;
  template?: { emoji: string; name: string } | null;
  preset?: { title: string } | null;
}): string {
  if (row.targetKind === 'task') {
    return row.preset ? `⚡ ${row.preset.title}` : '（这条一键任务已经被删了）';
  }
  return row.template ? `${row.template.emoji} ${row.template.name}` : '（这个智能体已经被删了）';
}
