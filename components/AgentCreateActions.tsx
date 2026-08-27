'use client';

// 智能体页页头的两个新建入口（2026-08-26 用户指定「放到业务的上方」——
// 全站统一头的 action 位就是这个位置，与豆包的右上角一致）。
//
// 【为什么用自定义事件而不是把表单提到这里】新建智能体的表单与 server action
// 在 WorkflowMarket.tsx，定时的在 Schedules.tsx（后者有 scheduled-agent 源码守卫钉着
// 文件里的委托与文案，搬家会打红一片）。表单留在原地弹 Overlay，这里只发一个信号——
// 十行胶水，换来两处逻辑零搬动。
export function AgentCreateActions() {
  return (
    <span className="row" style={{ gap: 8 }}>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => window.dispatchEvent(new CustomEvent('beacon:new-schedule'))}
      >
        ＋ 定时任务
      </button>
      <button
        type="button"
        className="btn btn-sm btn-primary"
        onClick={() => window.dispatchEvent(new CustomEvent('beacon:new-agent'))}
      >
        ＋ 新建智能体
      </button>
    </span>
  );
}
