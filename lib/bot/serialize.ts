// 同一把 key 上的处理串行化（进程内）。
//
// 【为什么】同一个群里连发两句，飞书/企微/钉钉的回调几乎同时到，两次 handleInbound 并发跑：
// 各自读到旧的 turns 再 upsert → 后写覆盖前写，丢一轮上下文；两条「帮我写…」还会派出两个任务。
// 此前只有微信客服做了（runSerialized 原来住在 wechat-kf.ts），现在搬出来给 router 的入口用。
// 进程内锁够用：一台实例上的回调都进同一个 Node 进程；蓝绿切换那几十秒的双实例窗口由 msgId 去重兜。
const chains = new Map<string, Promise<unknown>>();

export function runSerialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  chains.set(key, next);
  return next.finally(() => { if (chains.get(key) === next) chains.delete(key); });
}
