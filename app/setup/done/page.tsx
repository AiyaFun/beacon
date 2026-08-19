import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { getSessionOrNull } from '@/lib/session';
import { can } from '@/lib/edition';
import { notFound } from 'next/navigation';
import { issueBindCode } from '@/lib/auth/oa';
import { botProviderName } from '@/lib/bot/types';

// 装机完成页。
//
// 【为什么它必须是一个独立路由，而不是向导里的一屏】
// 向导完成时会写 cookie 并让 Next 重新拉 /setup 的 RSC —— 那一刻 isInitialized() 已经为真，
// 服务端组件立刻 redirect 走，客户端刚 setState 的「完成」界面**根本来不及显示**。
// 真机 2026-08-18 首次跑通时就是这样：初始化成功、直接落到工作台，
// 而采集令牌（只在那一屏出现）用户一眼都没看到。
//
// 现在令牌不再由 action 一次性返回，而是这一页从库里读——反正登录的就是 owner 本人，
// 他在「下载采集助手」页也随时能再看到同一串。
export const dynamic = 'force-dynamic';

export default async function SetupDonePage() {
  if (!can('setupWizard')) notFound();
  const session = await getSessionOrNull();
  if (!session) redirect('/login');

  const ws = await prisma.workspace.findUnique({
    where: { id: session.workspaceId },
    select: { name: true, ingestToken: true },
  });
  const bot = await prisma.botIntegration.findFirst({
    where: { workspaceId: session.workspaceId },
    select: { provider: true, inboundKey: true },
  });
  const siteUrl = process.env.BEACON_SITE_URL || process.env.BEACON_PUBLIC_URL || 'http://localhost:3070';

  // 绑定码直接印在这一页上。
  // 【为什么不让他自己去设置里找】装机管理员是这台机器上唯一一个「已经登录、但还没有
  // 企业应用身份」的人 —— 不绑的话，这次会话过期之后他自己也登不回来，而那时候
  // 他既没有短信通道、机器人也不认识他，只能重装。这一步太关键了，不能靠他记得去找。
  const me = await prisma.member.findUnique({
    where: { id: session.memberId },
    select: { oaIdentity: true },
  });
  const bindCode = bot && !me?.oaIdentity ? await issueBindCode(session.memberId) : null;
  const botName = bot ? botProviderName(bot.provider) : null;

  return (
    <div className="app-shell" style={{ maxWidth: 760, margin: '0 auto', padding: 24 }}>
      <div className="card">
        <div className="card-title">✅ 初始化完成</div>
        <p className="card-sub">
          「{ws?.name ?? '你的团队'}」已经建好，你是这台实例的管理员，登录态已经生效。
        </p>

        <div className="field">
          <div className="field-label">插件采集令牌</div>
          <code style={{ display: 'block', wordBreak: 'break-all', padding: 10, borderRadius: 8, background: 'var(--bg-subtle, #f6f7f9)' }}>
            {ws?.ingestToken ?? '（未生成，请到「下载采集助手」页签发）'}
          </code>
          <p className="card-sub">忘了也不要紧——「工具 → 下载采集助手」里随时能再看到。</p>
        </div>

        {bindCode ? (
          <div className="field">
            <div className="field-label">⚠️ 先做这一步：把你自己接上{botName}</div>
            <p className="card-sub">
              打开{botName} <b>私聊</b>本团队的烽火台机器人，发送下面这条。不做的话，这次登录过期后你自己也进不来。
            </p>
            <code style={{ display: 'block', padding: 10, borderRadius: 8, background: 'var(--bg-subtle, #f6f7f9)' }}>
              绑定 {bindCode}
            </code>
            <p className="card-sub">10 分钟内有效。过期了可以在「设置 → 账号与安全」再要一个。</p>
          </div>
        ) : null}

        <div className="field">
          <div className="field-label">接下来三步</div>
          <ol style={{ lineHeight: 2, paddingLeft: 20, margin: 0 }}>
            <li>每位同事在 Chrome 里装「烽火台采集助手」，服务器地址填 <code>{siteUrl}</code>，令牌粘上面那串</li>
            <li>
              {bot
                ? `企业应用（${botName}）已填好 —— 到「机器人与通知」把回调地址配进去，再把机器人拉进群`
                : '还没配企业应用 —— 到「机器人与通知」里补上飞书/钉钉/企微的 AppID 与 Secret'}
            </li>
            <li>
              同事要用的时候，<b>私聊机器人发「登录」</b>两个字就行 —— 不是成员的会当场加进来，
              你在通知红点里能看到是谁
            </li>
            <li>建一个创作者人设，右上角才会开始出推荐</li>
          </ol>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link className="btn btn-primary" href="/">进入工作台</Link>
          <Link className="btn btn-ghost" href="/extension">下载采集助手</Link>
          <Link className="btn btn-ghost" href="/notifications">机器人与通知</Link>
        </div>
      </div>
    </div>
  );
}
