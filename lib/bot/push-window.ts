// 机器人「每日定时推送时间」的到点判定（北京时间口径）。
//
// 【为什么需要它】用户在设置页填的是具体时刻（可多个，如 "09:00,18:00"），
// 而 cron 只能定死固定点。做法是 push_daily_brief 每 PUSH_TICK_MINUTES 分钟扫一遍，
// 判断「上一跳到这一跳之间，是否跨过了用户设定的时刻」。
// 窗口取**左开右闭** (now-tick, now]：每个时刻每天只命中一次，且**绝不早于**用户设定的时间推
// ——早推比晚推糟，用户按 9 点安排的一天，8 点 50 收到晨报等于没到点就打断。

export const PUSH_TICK_MINUTES = 10;

// 中国全境单一时区、1991 年后无夏令时，固定 +8 就是精确值。
// 不用 toLocaleString('zh-CN', { timeZone }) 是因为它依赖运行环境的 ICU 数据，
// slim 镜像上格式与可用性都不保证——推送时刻这种业务判定不该押在 ICU 上。
const BEIJING_OFFSET_MIN = 8 * 60;

// UTC 时刻 → 北京时间的「当日第几分钟」（0..1439）
export function beijingMinuteOfDay(now: Date): number {
  return (Math.floor(now.getTime() / 60_000) + BEIJING_OFFSET_MIN) % 1440;
}

// "09:00" / "09:00,18:00" / " 9:5 " → [540] / [540, 1080] / [545]；非法项丢弃
export function parsePushSchedule(raw: string | null | undefined): number[] {
  const out: number[] = [];
  for (const part of String(raw ?? '').split(/[,，]/)) {
    const m = /^\s*(\d{1,2})\s*[:：]\s*(\d{1,2})\s*$/.exec(part);
    if (!m) continue;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) continue;
    const t = h * 60 + min;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

// 本跳是否该给这个机器人推。tickMinutes 必须与 push_daily_brief 的 cron 间隔一致，
// 否则要么漏推（窗口小于间隔），要么一天推两次（窗口大于间隔）。
export function isPushDue(raw: string | null | undefined, now: Date, tickMinutes = PUSH_TICK_MINUTES): boolean {
  const nowMin = beijingMinuteOfDay(now);
  // 取模处理跨零点：设 00:00 时，00:00 这一跳的窗口是 23:51–00:00
  return parsePushSchedule(raw).some((t) => (nowMin - t + 1440) % 1440 < tickMinutes);
}
