import Link from 'next/link';
import { getSession } from '@/lib/session';
import { Card, Stat, Empty } from '@/components/ui';
import { Icon } from '@/components/icons';
import { fmtDateTime } from '@/lib/format';
import { NAV } from '@/lib/nav';
import { listRuns, countByStatus, KIND_LABEL, STATUS_LABEL, type RunEntry, type RunStatus } from '@/lib/runs';
import { ActionButton } from '@/components/ActionButton';
import { actRerunWorkflow, actCancelBrowserTask } from './actions';
import { HubHeader } from '@/components/HubHeader';

export const dynamic = 'force-dynamic';

// 运行中心：系统里所有会「跑起来」的东西，一处看全。
//
// 这一页只回答两个问题，别往上加别的：
//   ① 有什么在等我处理？（waiting 置顶，因为不点它永远不动）
//   ② 刚才那件事跑完了没、跑到哪一步停的？
//
// 【为什么是就地展开而不是点进详情页】AI 执行那条要看的是「它调了哪些工具」，
// 而 /assistant 是个**看不见这次运行**的页面——直接把行做成链接就成了「指路指到空页面」。
// 展开写在行里，跳转按钮放在展开体末尾：想看明细不用离开这一页，想去干活也走得掉。
// （另一个理由：/runs/[id] 这种动态路由会被 nav-layout 的「每个页面都要有侧栏入口」用例判成孤儿页。）
//
// 口径与「为什么不收 JobRun」「为什么不按账号过滤」都写在 lib/runs/index.ts 顶部。

const STATUS_CLASS: Record<RunStatus, string> = {
  waiting: 'badge-accent',
  running: 'badge-gray',
  done: 'badge-green',
  failed: 'badge-red',
  cancelled: 'badge-gray',
};

/**
 * 跳转按钮上的字从 NAV 取——导航改了名字，这里不会变成谎话。
 * 先剥锚点**与 query**：`/extension#browser-tasks`、`/assistant?run=xxx` 与它们的
 * 光杆路径是同一页，不剥的话按钮会退化成「去相关页面」这种废话。
 */
function navLabel(href: string): string {
  const route = href.split(/[#?]/)[0];
  return NAV.flatMap((g) => g.items).find((i) => i.href === route)?.label ?? '相关页面';
}

const STEP_KIND_LABEL: Record<string, string> = {
  tool_call: '调用',
  rejected: '你拒绝了',
  error: '出错',
};

function RunRow({ r }: { r: RunEntry }) {
  const steps = r.steps ?? [];
  return (
    <details className="run-row">
      <summary className="run-sum">
        <span className={`badge ${STATUS_CLASS[r.status]}`}>{STATUS_LABEL[r.status]}</span>
        <span className="run-main">
          <span className="run-title">{r.title}</span>
          <span className="small muted">
            {KIND_LABEL[r.kind]}
            {r.accountName ? ` · ${r.accountName}` : ''}
            {r.detail ? ` · ${r.detail}` : ''}
          </span>
        </span>
        <span className="small muted run-time">{fmtDateTime(r.at)}</span>
        <span className="run-caret" aria-hidden="true"><Icon.chevron size={15} /></span>
      </summary>
      <div className="run-body">
        {r.kind === 'agent' && (
          steps.length > 0 ? (
            <ol className="run-steps small">
              {steps.map((st) => (
                <li key={st.seq} className={st.ok ? undefined : 'run-step-bad'}>
                  <strong>{STEP_KIND_LABEL[st.kind] ?? st.kind}</strong>
                  {st.tool ? ` ${st.tool}` : ''}
                  {st.result ? ` — ${st.result}` : ''}
                </li>
              ))}
            </ol>
          ) : (
            <p className="small muted">这次执行还没有产生工具调用。</p>
          )
        )}
        {r.kind !== 'agent' && r.detail && <p className="small muted">{r.detail}</p>}
        <div className="row wrap" style={{ gap: 8 }}>
          {/* href 指回本页的行不渲染跳转按钮：浏览器任务的落点 2026-08-26 改成了 /runs，
              于是这里出现过「在运行中心里点『去运行中心 →』」——原地跳转，用户点了以为坏了
              （原话「点击后完成无法跑得动」）。等浏览器领活的行，能做的事只有开着浏览器
              让插件醒来，按钮换成指向插件页的「检查插件 →」才是真出口。 */}
          {r.href.split(/[#?]/)[0] !== '/runs' ? (
            <Link href={r.href} className="btn btn-sm">
              {/* 停在「等你确认」的那条，按钮字要说的是「去处理」而不是「去 AI 助手」——
                  用户要的是把这件事了结，不是去参观一个页面 */}
              {r.status === 'waiting' && r.kind === 'agent' ? '去确认这一步 →' : `去${navLabel(r.href)} →`}
            </Link>
          ) : (
            r.kind === 'browser' && r.status === 'waiting' && (
              <Link href="/extension" className="btn btn-sm">检查插件装好没 →</Link>
            )
          )}

          {/* 失败的工作流原地重来。不加这个的话，用户得记住是哪条、走到智能体页、
              翻出那个模板、再点一次跑——而这一页明明已经知道是哪条了 */}
          {r.kind === 'workflow' && (r.status === 'failed' || r.status === 'cancelled') && (
            <ActionButton
              action={actRerunWorkflow.bind(null, r.id)}
              loadingText="重跑中…"
              confirmText="重新跑一遍这条智能体？会重新消耗额度。"
            >
              重跑一次
            </ActionButton>
          )}

          {/* 只有还没被浏览器领走的活能取消：已经在跑的那条插件那边标签页都开了，
              库里改成取消也停不下它，只会让交活时撞上「状态不对」白白重试 */}
          {r.kind === 'browser' && r.status === 'waiting' && (
            <ActionButton action={actCancelBrowserTask.bind(null, r.id)} loadingText="取消中…">
              不用采了
            </ActionButton>
          )}
        </div>
      </div>
    </details>
  );
}

function RunGroup({ rows }: { rows: RunEntry[] }) {
  return (
    <div className="stack" style={{ gap: 2 }}>
      {rows.map((r) => <RunRow key={`${r.kind}-${r.id}`} r={r} />)}
    </div>
  );
}

export default async function RunsPage() {
  const s = await getSession();
  const rows = await listRuns(s.workspaceId);
  const n = countByStatus(rows);

  const waiting = rows.filter((r) => r.status === 'waiting');
  const active = rows.filter((r) => r.status === 'running');
  const rest = rows.filter((r) => r.status !== 'waiting' && r.status !== 'running').slice(0, 30);

  return (
    <>
      <HubHeader
        title="运行中心"
        hint="AI 执行、工作流、采集、发布——所有跑起来的东西在这里看全。跨账号都收，每条标明归属。"
      />

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="等你处理" value={n.waiting} foot="不点它不会自己动" />
        <Stat label="进行中" value={n.running} foot="系统正在跑" />
        <Stat label="失败" value={n.failed} foot="停在半路的" />
        <Stat label="已完成" value={n.done} foot="近期跑完的" />
      </div>

      {waiting.length > 0 && (
        <Card
          title="等你处理"
          sub="这些不是「在跑」，是停下来等人：等你确认写操作、等你去平台点发布"
          style={{ marginBottom: 16 }}
        >
          <RunGroup rows={waiting} />
        </Card>
      )}

      {active.length > 0 && (
        <Card title="进行中" sub="系统正在推进，不用管" style={{ marginBottom: 16 }}>
          <RunGroup rows={active} />
        </Card>
      )}

      <Card title="最近跑过" sub="按时间倒序 · 失败的排在前面 · 点开看这次都干了什么">
        {rows.length === 0 ? (
          <Empty
            icon="🛰"
            text="还没有任何运行记录。让 AI 助手替你做一件事，或者跑一条工作流模板，这里就会有内容。"
          />
        ) : rest.length === 0 ? (
          <p className="small muted">上面两栏已经是全部了。</p>
        ) : (
          <RunGroup rows={rest} />
        )}
      </Card>
    </>
  );
}
