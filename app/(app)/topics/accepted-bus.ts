'use client';

// 「刚采纳了哪条」的最小事件总线：卡片（TopicActions）广播，页面级确认条（AcceptedBar）接收。
//
// 为什么要绕这一层，而不是让卡片自己弹一个按钮：采纳成功后这条选题就离开了「已推荐」分区，
// server action 返回时 Next 会重渲染当前路由，卡片连同它里面的一切当场被卸载。
// 挂在卡片里的「去工坊起这篇稿」因此是一闪即逝的——这正是用户遇到的「点了采纳就跳走了」。
// 确认条挂在页面根部、位置固定，RSC 重渲染不会重置它的 state，入口才留得住。

export type AcceptedTopic = { id: string; title: string };

type Listener = (t: AcceptedTopic) => void;

const listeners = new Set<Listener>();

/** 订阅，返回退订函数（直接当 useEffect 的 cleanup 用）。 */
export function onAccepted(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function publishAccepted(t: AcceptedTopic): void {
  for (const fn of listeners) fn(t);
}
