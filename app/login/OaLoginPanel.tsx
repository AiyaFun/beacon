import { prisma } from '@/lib/db';
import { botProviderName } from '@/lib/bot/types';

// 企业版登录页：这里没有手机号表单，因为整机/私有化版根本没有短信通道
// （lib/auth.ts 的 requestLoginCode 在形态闸上直接返回）。
// 登录方式只有一条：私聊企业应用里的机器人。这一屏的唯一职责是把那句话说清楚，
// 免得用户对着一个填不进去的表单发呆。
export async function OaLoginPanel({ err, webAuth }: { err?: string; webAuth?: boolean }) {
  // 装机向导里配的是哪家（飞书/钉钉/企微），文案就说哪家——说错了用户会去翻错的 App。
  const bot = await prisma.botIntegration.findFirst({
    where: { enabled: true },
    orderBy: { createdAt: 'asc' },
    select: { provider: true },
  });
  const name = bot ? botProviderName(bot.provider) : null;

  return (
    <div>
      {err ? (
        <div
          className="small"
          style={{
            background: '#fef2f2', color: '#b91c1c', padding: '10px 14px',
            borderRadius: 8, marginBottom: 20, fontSize: 13, lineHeight: 1.7,
          }}
        >
          {err}
        </div>
      ) : null}

      {name ? (
        <ol style={{ lineHeight: 2.1, paddingLeft: 20, color: '#334155', fontSize: 14 }}>
          <li>打开{name}，<b>私聊</b>本团队的烽火台机器人</li>
          <li>发送「<b>登录</b>」两个字</li>
          <li>点它回给你的链接即可进入（链接 5 分钟内有效，只能用一次）</li>
        </ol>
      ) : (
        <div
          className="small"
          style={{
            background: '#fffbeb', color: '#92400e', padding: '12px 14px',
            borderRadius: 8, fontSize: 13, lineHeight: 1.8,
          }}
        >
          这台实例还没有配置企业应用，暂时没有可用的登录方式。
          <br />
          请管理员用装机时那个浏览器（登录态还在）打开「设置 → 机器人与通知」把飞书/钉钉/企业微信配上，
          再到「账号与安全」绑定自己的企业应用账号。
        </div>
      )}

      {/* 网页授权按钮只在私有化版出现：它要求 redirect_uri 在飞书后台登记，
          而整机版跑在 localhost，局域网里的同事点了也跳不回来 —— 给一个必然失败的按钮
          比不给更糟。 */}
      {webAuth && name === '飞书' ? (
        <a className="btn btn-primary" href="/api/auth/oa/feishu/redirect" style={{ display: 'block', textAlign: 'center', marginTop: 16 }}>
          用飞书登录
        </a>
      ) : null}

      <p style={{ marginTop: 20, fontSize: 13, color: '#64748b', lineHeight: 1.9 }}>
        还不是成员？请管理员在「成员与权限」生成邀请码，然后私聊机器人发「<b>加入 &lt;邀请码&gt;</b>」。
      </p>
    </div>
  );
}
