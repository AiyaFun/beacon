import Link from 'next/link';
import { Card } from '@/components/ui';
import { Icon } from '@/components/icons';
import { HELP_ROUTES, navPathLabel } from '@/lib/nav';
import { getServerLang } from '@/lib/i18n/server';

import { PrivacyCard } from '../settings/PrivacyCard';
import { HubHeader } from '@/components/HubHeader';

export const dynamic = 'force-dynamic';

// 使用帮助 / 快速上手：告诉用户在哪里设置采集助手、飞书机器人、持续学习。
// 内容与 docs/用户使用说明-插件与机器人.md 对齐，改一处两处都要同步。

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
      <span
        className="row"
        style={{
          flexShrink: 0, width: 22, height: 22, borderRadius: '50%',
          background: 'var(--brand-soft)', color: 'var(--brand)', fontSize: 12, fontWeight: 700,
          justifyContent: 'center', alignItems: 'center', marginTop: 1,
        }}
      >
        {n}
      </span>
      <span className="small" style={{ lineHeight: 1.7 }}>{children}</span>
    </div>
  );
}

const COMMANDS_ZH: [string, string][] = [
  ['@机器人 + 你的问题', '直接对话，带账号人设与真实数据回答，记得住上下文'],
  ['发文章链接 / 粘一整篇正文', '抓正文存档 + 摘要 + 要点 + 对你账号的用处'],
  ['直接发短文本', '收录成选题候选'],
  ['/竞对 [名字]', '看监控中的竞对近期高热作品（带链接）'],
  ['/拆解 竞对作品链接', '它凭什么跑起来 + 你能借鉴什么'],
  ['/存 链接或正文', '明确要剪藏'],
  ['/分析 [账号名]', '给账号做一次数据体检并给反馈'],
  ['/问 你的问题', '明确要对话（不想被收录成选题时用）'],
  ['/账号 [名字]', '看 / 切换本群当前账号'],
  ['/热点', '看当前热榜 Top'],
  ['/选题 关键词', '把关键词收录成选题'],
  ['/采集 竞对主页链接', '加入竞对监控'],
  ['/优化', '触发一次记忆学习优化'],
  ['/重置', '清掉当前对话上下文'],
  ['/帮助', '看指令说明'],
];

const COMMANDS_EN: [string, string][] = [
  ['@Bot + your question', 'Direct conversation with persona & real data context'],
  ['Send article link / paste text', 'Archive post + summary + key takeaways + niche insights'],
  ['Send short text directly', 'Collect directly into topic candidate pool'],
  ['/competitor [name]', 'View monitored competitor recent trending posts (with links)'],
  ['/dissect [competitor link]', 'Why it went viral + what you can learn'],
  ['/save [link or text]', 'Explicitly save/clip to library'],
  ['/analyze [account name]', 'Run account data health check with actionable feedback'],
  ['/ask [your question]', 'Explicit dialogue (use when avoiding candidate collection)'],
  ['/account [name]', 'View / switch active account for this channel'],
  ['/trending', 'View current trending ranking Top list'],
  ['/topic [keyword]', 'Save keyword as candidate topic'],
  ['/collect [competitor profile]', 'Add profile to competitor monitoring'],
  ['/optimize', 'Trigger memory learning optimization'],
  ['/reset', 'Clear current chat context'],
  ['/help', 'View command list and instructions'],
];

const TOPIC_SOURCES_ZH: [string, string][] = [
  ['来自热点', '当前热榜在榜话题'],
  ['来自竞对', '你订阅的同行的高热作品'],
  ['抢跑窗口', '话题已在别的平台爆了，你的主战平台还没有——赶在前面做'],
  ['旧文翻新', '你做过同题内容，这个话题又重新上榜了'],
  ['跨平台补发', '你在某平台的爆款，还没发到其他主战平台'],
  ['节点日历', '618、开学季这类每年确定会来的流量节点，赢在提前量'],
  ['常青题', '赛道里常年有人问的话题，没热点的日子靠它'],
  ['灵感箱', '你自己存进收集箱的内容，和从评论里挖出来的读者提问'],
];

const TOPIC_SOURCES_EN: [string, string][] = [
  ['From Trending', 'Current topics on live trending rankings'],
  ['From Competitors', 'High-performing posts from subscribed peers'],
  ['Head-Start Window', 'Trending on other platforms but not yours yet—capture early traffic'],
  ['Repurpose Prior Post', 'You covered this topic before, and it is trending again'],
  ['Cross-Platform Repost', 'Your hit post on one channel, not yet adapted to others'],
  ['Calendar Milestones', 'Fixed traffic events like 618 or back-to-school; win with advance preparation'],
  ['Evergreen Questions', 'Perennial questions in your niche; rely on this when there is no breaking trend'],
  ['Inspiration Box', 'Content saved to your box and audience questions extracted from comments'],
];

const HELP_WHAT_EN: Record<string, string> = {
  '装插件采公开数据': 'Install extension to collect public data',
  '生成采集令牌': 'Generate collection token',
  '配机器人（飞书 / 钉钉 / 企微 / 微信）': 'Configure bots (Feishu / DingTalk / WeCom / WeChat)',
  '看有什么在跑 / 什么在等我处理': 'Check running tasks / tasks waiting for review',
  '让一串步骤自己跑完（智能体 / 工作流模板）': 'Run multi-step tasks automatically (Agents / Workflow templates)',
  '让智能体每天定时自己跑': 'Schedule agents to run automatically every day',
  '管 AI 能替我动哪些能力（关掉某项）': 'Manage AI capabilities (enable or disable actions)',
  '让 AI 直接替我做事（问一句 → 让它去做）': 'Let AI act directly (one prompt → AI executes)',
  '找回一次停在「等你确认」的 AI 执行': 'Resume an AI execution waiting for confirmation',
  '让 AI 自己挑技能来改稿（不用手动进工坊）': 'Let AI select skills to polish drafts automatically',
  '看今天该做什么选题': 'See recommended topics for today',
  '存下刷到的灵感 / 从评论挖问题': 'Save inspirations / extract questions from comments',
  '给一条选题找差异化角度': 'Find differentiated angles for a topic',
  '自己起稿 / 粘一版旧稿来打磨': 'Draft from scratch / paste an existing draft to refine',
  '要几张图（不绑草稿、不上字）': 'Generate images (standalone, no text overlays)',
  '发之前查一遍平台红线': 'Check platform compliance before publishing',
  '写完了要发出去': 'Publish or schedule completed posts',
  '看发出去之后跑得怎么样': 'Track post performance after publishing',
  '看效果：数据表现 / 什么跑得动 / 平台怎么想': 'View analytics: performance / what works / platform algorithm',
  '优化记忆 / 看学习建议': 'Optimize memory / view learning suggestions',
  '让 AI 写得像我自己写的': 'Train AI to mimic your own writing style',
  '问题反馈 / 意见交流': 'Feedback & community discussion',
  '查看隐私与数据安全声明': 'View Privacy & Data Security Statement',
};

const NAV_LABEL_EN: Record<string, string> = {
  '内容板块': 'Content',
  '设置': 'Settings',
  '今天': 'Today',
  '问 AI': 'Ask AI',
  '技能 · 连接器': 'Skills & Connectors',
  '任务记录': 'Run Center',
  '选题': 'Topics',
  '创作工坊': 'Content Studio',
  '看同行': 'Competitor Monitor',
  '我存的资料': 'Content Library',
  '智能体': 'Agents',
  '配图': 'Image Studio',
  '查红线': 'Compliance Check',
  '发出去': 'Publish',
  '我的素材': 'Material Library',
  '数据看板': 'Analytics',
  '人设与记忆': 'Persona & Memory',
  '爆款基因': 'Viral Genes',
  '平台怎么想': 'Algorithm Coach',
  '接入与密钥': 'Keys & Access',
  '机器人与通知': 'Bots & Notifications',
  '使用帮助': 'Help',
  '账号与安全': 'Account & Privacy',
};

const ARROW_SEP = [' ', '\u2192', ' '].join('');
function translateNavPath(path: string): string {
  const parts = path.split(ARROW_SEP);
  return parts.map((p) => NAV_LABEL_EN[p] ?? p).join(ARROW_SEP);
}

export default async function HelpPage() {
  const lang = await getServerLang();
  const isEn = lang === 'en';

  const commands = isEn ? COMMANDS_EN : COMMANDS_ZH;
  const topicSources = isEn ? TOPIC_SOURCES_EN : TOPIC_SOURCES_ZH;

  return (
    <>
      <HubHeader
        title={isEn ? 'Help & Documentation' : '使用帮助'}
        hint={isEn ? '10 minutes on day one to get started, then spend your time creating' : '第一天 10 分钟跑通，之后只需要花在创作上'}
      />

      {/* 0. 快速上手 */}
      <Card
        title={isEn ? '🚀 Day One: 10-Minute Walkthrough' : '🚀 第一天 10 分钟跑通'}
        sub={isEn ? 'Create Persona → Generate Recommendations → Adopt → Draft → Register Publication' : '建人设 → 生成推荐 → 采纳 → 起稿 → 登记发布'}
        style={{ marginBottom: 16 }}
      >
        <div className="stack" style={{ gap: 10 }}>
          <Step n={1}>
            {isEn ? (
              <>Go to <a href="/persona">Persona & Memory</a> to create your unique persona in one sentence—the foundation of all recommendations.</>
            ) : (
              <>到<a href="/persona">人设与记忆</a>，一句话创建专属人设——这是所有推荐的地基。</>
            )}
          </Step>
          <Step n={2}>
            {isEn ? (
              <>Return to the <a href="/">Dashboard</a> and click "Generate Today's Recommendations". AI will pick 5–10 topics tailored to your persona.</>
            ) : (
              <>回<a href="/">首页</a>点「生成今日推荐」，AI 会按你的人设挑 5-10 条选题。</>
            )}
          </Step>
          <Step n={3}>
            {isEn ? (
              <>Head over to <a href="/topics">Topic Engine</a> to adopt one, then visit <a href="/studio">Content Studio</a> and click "AI Generate Draft".</>
            ) : (
              <>到<a href="/topics">选题引擎</a>挑 1 条采纳，然后到<a href="/studio">创作工坊</a>点「AI 生成初稿」。</>
            )}
          </Step>
          <Step n={4}>
            {isEn ? (
              <>After finalizing and posting to your platform, return to <a href="/studio">Content Studio</a>, click "Register Post", and paste the link.</>
            ) : (
              <>改好后发布到平台，回<a href="/studio">创作工坊</a>点「登记发布」，贴上作品链接。</>
            )}
          </Step>
          <Step n={5}>
            {isEn ? (
              <>Go to <a href="/data">Analytics</a> and log your first performance metrics—recommendations will get sharper over time.</>
            ) : (
              <>到<a href="/data">数据看板</a>回填第一条表现数据——推荐会越来越准。</>
            )}
          </Step>
          <p className="small muted">
            {isEn
              ? "Once you run through this once, you'll know what Beacon can do for you daily. The browser extension and chat bots below are advanced enhancements."
              : '以上跑通一遍，你就知道烽火台每天能帮你做什么了。下面的采集助手和飞书机器人是进阶配置。'}
          </p>
        </div>
      </Card>

      {/* 1. 采集助手 */}
      <Card
        title={isEn ? '① Install Browser Extension' : '① 装浏览器采集助手'}
        sub={isEn ? 'Collect public data into your mission room effortlessly' : '顺手把公开数据收进作战室'}
        style={{ marginBottom: 16 }}
        action={
          <Link href="/extension" className="btn btn-sm btn-primary">
            <Icon.download size={13} /> {isEn ? 'Download' : '去下载'}
          </Link>
        }
      >
        <div className="stack" style={{ gap: 10 }}>
          <Step n={1}>
            {isEn
              ? 'Select your browser to download & install (Chrome, Edge, 360, Brave supported; Safari coming soon).'
              : '选你的浏览器下载安装（Chrome / Edge / 360 / Brave 通用；Safari 即将支持）。'}
          </Step>
          <Step n={2}>
            {isEn
              ? 'Go to "Keys & Access → Extension Ingest Token" to generate a token, then paste it into extension settings.'
              : '到「接入与密钥 → 插件采集令牌」点生成，把令牌复制进插件设置页。'}
          </Step>
          <Step n={3}>
            {isEn
              ? 'In "Competitor Monitor", subscribe to peers. Opening their public homepage auto-collects data; backfill data from your own posts in 1 click.'
              : '到「竞对监控」订阅竞对，打开对方公开主页即自动采集；自己作品页可一键回填数据。'}
          </Step>
          <p className="small muted">
            {isEn
              ? 'Only public data visible on screen is collected; daily scheduled scraping is enabled by default (runs in background for subscribed peers, closes when done, toggleable in extension settings).'
              : '只采你在页面上亲眼可见的公开数据；每日定时采集默认开启（后台开页采你已订阅的竞对，采完即关，可在插件设置关闭）。'}
          </p>
        </div>
      </Card>

      {/* 2. 飞书机器人 */}
      <Card
        title={isEn ? '② Configure Bots (Feishu / DingTalk / WeCom / WeChat)' : '② 配机器人（飞书 / 钉钉 / 企微 / 微信）'}
        sub={isEn ? 'Push updates to group chats and send commands directly; WeChat users can chat 1-on-1' : '内容推到群，群里也能发指令；微信用户可直接对话'}
        style={{ marginBottom: 16 }}
        action={
          <Link href="/notifications" className="btn btn-sm btn-primary">
            <Icon.chat size={13} /> {isEn ? 'Configure' : '去设置'}
          </Link>
        }
      >
        <div className="stack" style={{ gap: 14 }}>
          <p className="small muted">
            {isEn ? 'Location: "Tools → Bots & Notifications" page.' : '位置：「工具 → 机器人与通知」页面。'}
          </p>

          <div className="stack" style={{ gap: 8 }}>
            <div className="small">
              <b>{isEn ? 'Outbound Push (2 mins, recommended first)' : '出站推送（2 分钟，推荐先配）'}</b>
              {isEn ? ' —— Push daily topics / trending / compliance alerts / learning summaries to group' : ' —— 每日选题 / 热点 / 合规告警 / 学习小结推到群'}
            </div>
            <Step n={1}>
              {isEn
                ? 'Feishu group → Settings → Group Bots → Add "Custom Bot", copy webhook URL.'
                : '飞书群 → 设置 → 群机器人 → 添加「自定义机器人」，复制 webhook。'}
            </Step>
            <Step n={2}>
              {isEn
                ? 'Paste into settings, select events to push, click "Save" then "Test Send". You\'re set once received.'
                : '粘进设置页，勾选要推的事件，「保存」→「测试发送」，群里收到就通了。'}
            </Step>
          </div>

          <div className="stack" style={{ gap: 8 }}>
            <div className="small">
              <b>{isEn ? 'Inbound ChatOps (Advanced)' : '入站 ChatOps（进阶）'}</b>
              {isEn ? ' —— Send links/text in group to ingest, send commands to drive engine' : ' —— 群里发链接/文本即收录、发指令驱动引擎'}
            </div>
            <Step n={1}>
              {isEn
                ? 'Expand "Inbound ChatOps", click "Open Feishu Open Platform" to create a custom app, copy App ID & App Secret.'
                : '展开「入站 ChatOps」，点「打开飞书开放平台」建自建应用，填 App ID / App Secret。'}
            </Step>
            <Step n={2}>
              {isEn
                ? 'Go to Feishu "Event Subscriptions": paste callback URL in "Callback Configuration" (or select WebSocket long-connection mode), copy Verification Token (and Encrypt Key) back to system.'
                : '前往飞书「事件订阅」：在「回调配置」贴回调地址（或在「订阅方式」选长连接模式），将 Verification Token（和 Encrypt Key）填回系统。'}
            </Step>
            <Step n={3}>
              {isEn
                ? 'In "Event Configuration" click "Add Event" and add im.message.receive_v1, grant messaging permissions, enable bot capability, and publish.'
                : '在「事件配置」点「添加事件」加入 im.message.receive_v1，开通消息权限、加机器人功能并发布。'}
            </Step>
          </div>

          <div className="stack" style={{ gap: 8 }}>
            <div className="small">
              <b>{isEn ? 'WeChat (Personal Use)' : '微信（自己用）'}</b>
              {isEn
                ? ' —— Official WeChat iLink bot interface (same as WeChat ClawBot), scan QR to bind; bot appears in your WeChat contacts'
                : ' —— 微信官方 iLink 机器人接口（微信 ClawBot 同一套），扫码即绑，机器人出现在你微信的联系人里'}
            </div>
            <Step n={1}>
              {isEn
                ? 'In "Channels" click "Connect" on WeChat card, scan QR code and confirm on your phone—no credentials required.'
                : '「消息渠道」点「微信」卡「接入」，用微信扫码并在手机上确认，什么都不用填。'}
            </Step>
            <Step n={2}>
              {isEn
                ? 'Send a message to the bot in WeChat: questions, article links, or topic ideas all work. Only the scanned account can chat, and it only responds passively; scan again if session expires.'
                : '在微信里给刚出现的机器人发一句话：问题、文章链接、一句选题都行。只有扫码的这个号能聊，它只回复不主动发；登录态过期回来重扫。'}
            </Step>
            <div className="small" style={{ marginTop: 4 }}>
              <b>{isEn ? 'WeChat Customer Service (Public facing)' : '微信客服（对外接客）'}</b>
              {isEn
                ? ' —— WeCom WeChat Customer Service channel: customers scan your QR to reach you; anyone can chat, login/delegation disabled, defaults to chat, clipping, candidate collection, and trending'
                : ' —— 企业微信的微信客服通道：客户扫你企业的客服码找你；谁扫码都能聊，登录/派任务不可用，默认只开对话、剪藏、收录、热榜'}
            </div>
            <Step n={3}>
              {isEn
                ? 'WeCom Admin → App Management → WeChat Customer Service, create account and generate API Secret; click "Connect" on WeChat KF card, enter CorpID / Secret / Callback Token / EncodingAESKey, copy callback URL back to WeCom, and run "Health Check" to verify.'
                : '企业微信后台 → 应用管理 → 微信客服，新建客服账号并生成 API Secret；点「微信客服」卡「接入」填 CorpID / Secret / 回调 Token / EncodingAESKey，把回调 URL 粘回企微后台，点「体检」验证。'}
            </Step>
          </div>

          <div className="stack" style={{ gap: 0, marginTop: 2 }}>
            <div className="small" style={{ marginBottom: 6 }}>
              <b>{isEn ? 'How to use in group after setup' : '装好后在群里怎么用'}</b>
            </div>
            {commands.map(([cmd, act], i) => (
              <div key={i} className="row-between" style={{ padding: '7px 0', borderTop: '1px solid var(--surface-2)', gap: 12 }}>
                <code className="small mono" style={{ color: 'var(--brand)' }}>{cmd}</code>
                <span className="small muted" style={{ textAlign: 'right' }}>{act}</span>
              </div>
            ))}
          </div>
          <p className="small muted">
            {isEn
              ? 'Collected items only enter candidate pool without auto-publishing; generated content is always subject to compliance checks.'
              : '收录只进候选池、不自动发布；生成内容仍全程过合规。'}
          </p>
        </div>
      </Card>

      {/* 3. 持续学习 */}
      <Card
        title={isEn ? '③ Continual Learning: Smarter Memory Over Time' : '③ 让记忆越用越懂你'}
        sub={isEn ? 'Continuous Learning & Optimization' : '持续学习优化'}
        style={{ marginBottom: 16 }}
        action={
          <Link href="/persona" className="btn btn-sm btn-primary">
            <Icon.user size={13} /> {isEn ? 'Persona & Memory' : '去人设与记忆'}
          </Link>
        }
      >
        <div className="stack" style={{ gap: 10 }}>
          <p className="small muted">
            {isEn ? 'Location: "Persona & Memory → Continual Learning & Optimization card".' : '位置：「人设与记忆 →『持续学习与优化』卡片」。'}
          </p>
          <Step n={1}>
            {isEn
              ? 'The system optimizes memory automatically once daily (deduplicating, promoting verified findings, and decaying stale observations).'
              : '系统每天自动优化一次记忆（去重、让反复验证的结论生效、给老旧观察降权遗忘）。'}
          </Step>
          <Step n={2}>
            {isEn
              ? 'To optimize immediately, click "⚡ Optimize Memory Now" on the card.'
              : '想立刻优化，点卡片里的「⚡ 立即优化记忆」。'}
          </Step>
          <Step n={3}>
            {isEn
              ? 'Persona improvement suggestions will appear below—these are advisory only; click edit on the Persona Card to adopt changes yourself.'
              : '下方会给出人设改进建议——只是建议，改不改由你，去「人设卡」点编辑自行采纳。'}
          </Step>
        </div>
      </Card>

      {/* 4. 选题引擎怎么读 */}
      <Card
        title={isEn ? '④ Understanding Daily Topic Recommendations' : '④ 看懂每天的选题推荐'}
        sub={isEn ? 'Which to pick first, why it was suggested, and how to execute' : '先做哪个、为什么推给你、怎么开工'}
        style={{ marginBottom: 16 }}
        action={
          <Link href="/topics" className="btn btn-sm btn-primary">
            <Icon.bulb size={13} /> {isEn ? 'Topic Engine' : '去选题引擎'}
          </Link>
        }
      >
        <div className="stack" style={{ gap: 14 }}>
          <div className="stack" style={{ gap: 8 }}>
            <div className="small">
              {isEn ? (
                <><b>Recommendations are grouped into 3 queues by timing</b>, not ranked by score alone</>
              ) : (
                <><b>推荐按「什么时候做」分三队</b>，不是按分数排一长条</>
              )}
            </div>
            <Step n={1}>
              {isEn ? (
                <><b>Today's Sprint</b>: Time-sensitive window, expires quickly—act today or miss out.</>
              ) : (
                <><b>今日突击</b>：有时间窗口，过期作废——今天不动手就没了。</>
              )}
            </Step>
            <Step n={2}>
              {isEn ? (
                <><b>This Week's Window</b>: High momentum without immediate urgency, fits nicely into weekly production.</>
              ) : (
                <><b>本周窗口</b>：有节奏但不紧急，适合排进本周产能。</>
              )}
            </Step>
            <Step n={3}>
              {isEn ? (
                <><b>Evergreen Reserve</b>: Independent of hot trends, evergreen value anytime; use when exploring or during capacity gaps.</>
              ) : (
                <><b>常青储备</b>：不依赖热点，什么时候做都成立；没头绪或产能有空档时用。</>
              )}
            </Step>
            <p className="small muted">
              {isEn
                ? "Overall score answers 'is it worth doing', while queue answers 'which to do first'—they complement each other."
                : '综合分回答「值不值得做」，队列回答「先做哪个」——两件事，不互相顶替。'}
            </p>
          </div>

          <div className="stack" style={{ gap: 8 }}>
            <div className="small">
              <b>{isEn ? 'Three key elements on every topic card' : '每条卡片上的三样东西'}</b>
            </div>
            <Step n={1}>
              {isEn ? (
                <><b>Differentiated Angle</b>: AI-crafted creative angle explaining how to avoid generic content.</>
              ) : (
                <><b>差异化切入角</b>：AI 给的创意，一句话说清怎么避开同质化。</>
              )}
            </Step>
            <Step n={2}>
              {isEn ? (
                <>
                  <b>Why Recommended</b>: Grounded <b>facts</b> queried from your data (past hit posts, when and where the topic trended).
                  Kept separate from the angle so you can distinguish creative advice from factual evidence.
                </>
              ) : (
                <>
                  <b>为什么推给你</b>：查你的数据查出来的<b>事实</b>（哪条旧作跑赢过、话题几点在哪上的榜）。
                  它和切入角分开放，就是为了让你分得清哪句是创意、哪句是证据。
                </>
              )}
            </Step>
            <Step n={3}>
              {isEn ? (
                <>
                  <b>Battle Card</b> (expand to view): Peer benchmark samples, your personal best posting hours, 72-hour competition density,
                  and your real baseline on that platform. <b>Facts only, no speculative predictions</b>—no fabricated estimates like "expected views".
                </>
              ) : (
                <>
                  <b>作战卡</b>（点开折叠）：同行做过的参考样本、你自己的最佳发布时段、近 72 小时的竞争密度、
                  你在该平台的真实水位。<b>只放事实，不给预测</b>——不编「预计播放多少」这种数。
                </>
              )}
            </Step>
          </div>

          <div className="stack" style={{ gap: 0, marginTop: 2 }}>
            <div className="small" style={{ marginBottom: 6 }}>
              <b>{isEn ? 'Where recommendations come from (badge at card top-left)' : '推荐从哪儿来（卡片左上角的徽标）'}</b>
            </div>
            {topicSources.map(([name, what], i) => (
              <div key={i} className="row-between" style={{ padding: '7px 0', borderTop: '1px solid var(--surface-2)', gap: 12 }}>
                <span className="small" style={{ flexShrink: 0 }}><b>{name}</b></span>
                <span className="small muted" style={{ textAlign: 'right' }}>{what}</span>
              </div>
            ))}
          </div>
          <p className="small muted">
            {isEn ? (
              <>
                You'll also encounter the <b>"Blue Ocean"</b> badge: topics that stay on ranking boards for a long duration, diffuse across platforms, and have low coverage by your monitored peers.
                It calculates observable on-platform signals (board duration × cross-platform spread × competitor density), <b>not a black-box web search index</b>.
              </>
            ) : (
              <>
                还会看到<b>「蓝海」</b>标：这个话题在榜上活得久、跨平台扩散广，而你监控的同行还没怎么做。
                它算的是站内可观测的信号（在榜时长 × 扩散平台数 × 竞对同题密度），<b>不是全网搜索指数</b>。
              </>
            )}
          </p>
        </div>
      </Card>

      {/* 5. 灵感收集箱 */}
      <Card
        title={isEn ? '⑤ Capture Fleeting Ideas into Inspiration Box' : '⑤ 把转瞬即逝的念头存下来'}
        sub={isEn ? 'Inspiration Box · Audience Inquiries' : '灵感收集箱 · 读者提问'}
        style={{ marginBottom: 16 }}
        action={
          <Link href="/topics?view=inspiration" className="btn btn-sm btn-primary">
            <Icon.plus size={13} /> {isEn ? 'Inspiration Box' : '去收集箱'}
          </Link>
        }
      >
        <div className="stack" style={{ gap: 10 }}>
          <Step n={1}>
            {isEn ? (
              <>
                When encountering notable content, click "Save to Inspiration" in the extension sidebar, or add manually on the page.
                <b> The note field is most valuable</b>—when filled, the engine uses your note as the candidate angle rather than the raw title.
              </>
            ) : (
              <>
                刷到值得记一笔的内容，用采集助手侧栏的「收进灵感箱」一键存下来；也可以在页面上手动记。
                <b>备注那栏最有用</b>——有备注时系统会拿你写的那句话当选题，而不是原标题。
              </>
            )}
          </Step>
          <Step n={2}>
            {isEn ? (
              <>
                Click "Extract Questions from Comments" and paste comments; the system extracts only <b>interrogative questions</b>.
                Highly queried questions make prime content topics.
              </>
            ) : (
              <>
                点「从评论里挖问题」，把评论区的文字整段粘进去，系统只挑出<b>提问句</b>存起来。
                被问得越多的问题，越值得做成内容。
              </>
            )}
          </Step>
          <Step n={3}>
            {isEn ? (
              <>
                Saved items <b>actively participate in daily recommendations</b>: if a breaking trend matches, it pairs with a note like "You bookmarked this 3 weeks ago";
                otherwise it enters "This Week's Window". Once adopted into a topic, it departs the queue automatically.
              </>
            ) : (
              <>
                存进来的东西会<b>主动参与每天的推荐</b>：撞上热点时它会带着「你 3 周前收藏过这个」一起推给你；
                没撞上就自己进「本周窗口」。变成选题被采纳后自动出队，不会重复出现。
              </>
            )}
          </Step>
        </div>
      </Card>

      {/* 6. 爆款基因 */}
      <Card
        title={isEn ? '⑥ See What Content Actually Performs on Your Account' : '⑥ 看什么样的内容在你账号真的跑得动'}
        sub={isEn ? 'Viral Genes · Verify Every Metric Independently' : '爆款基因 · 每个数都能自己验算'}
        style={{ marginBottom: 16 }}
        action={
          <Link href="/genes" className="btn btn-sm btn-primary">
            <Icon.gauge size={13} /> {isEn ? 'View Genes' : '去看基因'}
          </Link>
        }
      >
        <div className="stack" style={{ gap: 10 }}>
          <Step n={1}>
            {isEn ? (
              <>Calculates win rate across 4 dimensions: <b>Topic Source / Platform / Posting Hour / Angle</b>.</>
            ) : (
              <>按<b>选题来源 / 平台 / 发布时段 / 切入角</b>四个维度，算出你已发布内容的真实胜率。</>
            )}
          </Step>
          <Step n={2}>
            {isEn ? (
              <>
                Win rate = posts in category exceeding your platform median views ÷ total posts in category. <b>Categories with fewer than 3 posts display count only, omitting win rate</b>
                —1 win out of 2 posts is inconclusive, not 50%.
              </>
            ) : (
              <>
                胜率 = 该类里跑赢你同平台均播的条数 ÷ 该类总条数。<b>不足 3 条的类别只报条数、不报胜率</b>
                ——2 条里赢 1 条不是 50% 胜率，是没有结论。
              </>
            )}
          </Step>
          <Step n={3}>
            {isEn ? (
              <>
                To populate "Topic Source" and "Angle" data, attach topic attribution when publishing—posts adopted from Topic Engine and crafted in Content Studio.
              </>
            ) : (
              <>
                要让「选题来源」和「切入角」两维有数据，发布时需要带上选题归因——
                也就是从选题引擎采纳、再去创作工坊做出来的内容。
              </>
            )}
          </Step>
        </div>
      </Card>

      {/* 7. 创作工坊：写出不像 AI 写的东西 */}
      <Card
        title={isEn ? '⑦ Write Natural, Humanized Content in Content Studio' : '⑦ 在创作工坊写出不像 AI 写的东西'}
        sub={isEn ? 'Freeform Drafting · Human Touch Health Check · Multi-Platform Adaptation · Title Matrix' : '自由起稿 · 人味体检 · 一稿多平台 · 标题矩阵'}
        style={{ marginBottom: 16 }}
        action={
          <Link href="/studio" className="btn btn-sm btn-primary">
            <Icon.pen size={13} /> {isEn ? 'Content Studio' : '去创作工坊'}
          </Link>
        }
      >
        <div className="stack" style={{ gap: 10 }}>
          <Step n={1}>
            {isEn ? (
              <>
                <b>You don't have to start from a topic.</b> Click "New Draft" at top right: paste an <b>existing manuscript</b>,
                provide a <b>single-sentence premise</b> to expand, or start blank.
              </>
            ) : (
              <>
                <b>不一定要从选题开始。</b>点右上角「新建草稿」：可以<b>粘一段你已经写好的稿</b>、
                也可以只给<b>一句话想法</b>让它展开成初稿，或者先开个空白稿自己写。
              </>
            )}
          </Step>
          <Step n={2}>
            {isEn ? (
              <>
                <b>To make AI sound like you, feed it your writing.</b> Head to <Link href="/material">Material Library</Link> and add "Style Samples" (paste entire passages of your past writing).
                All subsequent generations will align with that voice—far more effective than vague persona prompts like "tone: humorous".
                Draft sources and published posts also enter this pool automatically.
              </>
            ) : (
              <>
                <b>想让 AI 写得像你，就喂它你写过的东西。</b>到
                <Link href="/material">素材库</Link>加几条「文风样本」（整段贴你自己写过的稿子），
                之后所有生成都会照着那个语感写——这比在人设里写「语气：幽默」有用得多。
                你粘进来建草稿的原稿、你发布过的正文，也会自动进入样本池。
              </>
            )}
          </Step>
          <Step n={3}>
            {isEn ? (
              <>
                Beside "Algorithm Coach", the editor features a <b>Human Touch Health Check</b>: detects LLM clichés, rhythm,
                parallelism density, and casual phrasing using deterministic rules (costs 0 AI tokens). If a draft feels too artificial, click
                <b> "Debuzzword / Humanize"</b>—it refines phrasing while keeping facts intact.
                <span className="muted"> (Under 120 words receives no score: rhythm cannot be reliably measured on short snippets.)</span>
              </>
            ) : (
              <>
                编辑框里除了「算法教练」，还有一张<b>人味体检</b>：检测大模型套话、句子节奏、
                排比密度、口语碎句，全是确定性规则、不花 AI 额度。觉得哪版太「AI」，点
                <b>「一键去 AI 味」</b>——它只换说法，信息一个不加一个不减。
                <span className="muted">（不足 120 字不出分：那么短算不出节奏，给分等于骗你。）</span>
              </>
            )}
          </Step>
          <Step n={4}>
            {isEn ? (
              <>
                You can toggle <b>"Deep Mode"</b> when drafting: it first outlines key takeaways (focusing on what to say),
                then expands outlines into prose using your style samples (focusing on how to say it).
                Disentangling these avoids default LLM dilution. Costs <b>2 AI calls</b>, so it is strictly opt-in.
              </>
            ) : (
              <>
                起草时可以勾<b>「深度模式」</b>：它先只列要点大纲（只管想清楚说什么），
                再照着你的原句样本把大纲写成成稿（只管怎么说）。
                一次生成里这两件事互相抢注意力，模型的默认解法就是保内容、丢文风——拆开之后才像你写的。
                代价是<b>两次 AI 调用</b>，所以要你自己勾，不做默认。
              </>
            )}
          </Step>
          <Step n={5}>
            {isEn ? (
              <>
                Once the text is set, click <b>"Generate Title Matrix + Cover Advice"</b>: provides 6 distinct angles
                (Result-First, Suspense, Counter-Intuitive, Audience Identity, Numbered List, Pain-Point Inquiry), each with length and word diagnosis.
                Compliance violations are flagged immediately.
              </>
            ) : (
              <>
                正文定了再点<b>「生成标题矩阵 + 封面建议」</b>：一次给 6 个角度互不相同的标题
                （结果前置 / 悬念 / 反常识 / 身份指向 / 数字清单 / 痛点提问），每条附长度与用词诊断，
                命中合规红线的会被直接拦下。
              </>
            )}
          </Step>
          <Step n={6}>
            {isEn ? (
              <>
                To distribute one article across channels, use <b>"Multi-Platform Adaptation"</b>: generates tailored drafts for each channel,
                tracking publishing and data separately. Later, this view highlights <b>which platform the piece performed best on</b>.
              </>
            ) : (
              <>
                同一篇要发几个平台，用<b>「一稿多平台」</b>派生：每个平台生成一份独立草稿，
                各自登记发布、各自回流数据，之后这里会告诉你<b>同一篇内容在哪个平台跑赢了</b>。
              </>
            )}
          </Step>
          <Step n={7}>
            {isEn ? (
              <>
                Skills always run on the <b>latest draft version</b> (the result card specifies the exact version used);
                expand "Current Requirements" to customize length, tone, or specific materials.
              </>
            ) : (
              <>
                技能永远基于<b>最新一版</b>正文运行（结果卡上会写明用了第几版）；
                展开「本次要求」还能指定这一次的篇幅、语气和要用上的素材。
              </>
            )}
          </Step>
        </div>
      </Card>

      {/* 8. 隐私与数据安全声明 */}
      <PrivacyCard />

      {/* 一句话总览 */}
      <Card
        title={isEn ? 'One-Sentence Overview' : '一句话总览'}
        sub={isEn ? 'What you want to do · Where to go' : '想做什么 · 去哪'}
      >
        <div className="stack" style={{ gap: 0 }}>
          {HELP_ROUTES.map(({ what, href }, i) => {
            const rawLabel = navPathLabel(href);
            const displayLabel = rawLabel ? (isEn ? translateNavPath(rawLabel) : rawLabel) : '';
            return (
              <Link
                key={i}
                href={href}
                className="row-between"
                style={{ padding: '10px 0', borderTop: '1px solid var(--surface-2)', gap: 12, textDecoration: 'none', color: 'inherit' }}
              >
                <span className="small">
                  <b>{isEn ? (HELP_WHAT_EN[what] ?? what) : what}</b>
                </span>
                <span className="row small muted" style={{ gap: 6, alignItems: 'center', textAlign: 'right' }}>
                  {displayLabel} <Icon.arrow size={13} />
                </span>
              </Link>
            );
          })}
        </div>
      </Card>
    </>
  );
}
