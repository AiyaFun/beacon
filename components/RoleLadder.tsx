import Link from 'next/link';
import { AGENT_ROLE_LIST, type AgentRoleKey } from '@/lib/agent/roles';

// 四类干活单位的分工，一处渲染、四页复用（能力 / 技能 / 智能体 / 助手）。
//
// 【为什么要在每一页都印一遍】「能力和技能有什么区别」「智能体和助手有什么区别」
// 是这个系统最容易问的两个问题，而答案此前只散落在各页的副标题里，每一页只说自己那半句。
// 用户站在任何一页，都该能一眼看出**这一页是四类里的哪一类、另外三类在哪**。
//
// 【当前这一类要高亮，且不做成链接】链到自己就是一个点了没反应的假入口
//（同任务台侧栏「切回工作台」那条纯文本的理由）。
export function RoleLadder({ here }: { here: AgentRoleKey }) {
  return (
    <div className="role-ladder">
      {AGENT_ROLE_LIST.map((r) => {
        const active = r.key === here;
        const body = (
          <>
            <b className="role-name">{r.name}</b>
            <span className="small muted role-one">{r.oneLine}</span>
            {/* 「谁决定怎么做」才是四类真正的分界——不写出来的话，
                用户会以为叫「智能体」的那个会临场思考（它不会，步骤是写死的） */}
            <span className="small muted role-by">怎么做由：{r.decidedBy}</span>
          </>
        );
        return active ? (
          <div key={r.key} className="role-cell active" aria-current="true">
            {body}
          </div>
        ) : (
          <Link key={r.key} href={r.href} className="role-cell">
            {body}
          </Link>
        );
      })}
    </div>
  );
}
