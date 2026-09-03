// 入站消息 id 去重（进程内、有界）——所有渠道共用。
//
// 【为什么要有】飞书要求 3 秒内 ack、超时会重推；企微/钉钉也会在回调超时时重投。
// 此前只有微信客服做了 msgid 去重（原来住在 wechat-kf.ts），飞书/企微/钉钉三条路的
// 注释写着「操作皆幂等」——不成立：对话烧额度、派任务起一次运行、采集试采一次，
// 三样都不是幂等的。一次重推 = 同一句话答两遍、同一个任务派两次。
//
// 【为什么进程内就够】回调都进同一个 Node 进程；蓝绿切换那几十秒的双实例窗口
// 是唯一漏洞，而平台重推间隔以秒计，大多落在同一实例上。要绝对保证得落库，
// 一张只为去重的表不值得——先把 99% 挡掉。
//
// key 由调用方拼成 `provider:msgId`，避免不同渠道的 id 空间撞车。
const SEEN_CAP = 500;
const seen = new Map<string, Set<string>>();

/** 第一次见到返回 true；见过返回 false。每个集成最多记最近 500 条。 */
export function markSeen(integrationId: string, msgId: string): boolean {
  let set = seen.get(integrationId);
  if (!set) {
    set = new Set();
    seen.set(integrationId, set);
  }
  if (set.has(msgId)) return false;
  set.add(msgId);
  if (set.size > SEEN_CAP) {
    const first = set.values().next().value;
    if (first !== undefined) set.delete(first);
  }
  return true;
}

/** 测试用：清空。 */
export function __resetSeen(): void {
  seen.clear();
}
