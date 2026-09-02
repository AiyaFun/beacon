import Link from 'next/link';
import { Card } from '@/components/ui';
import { Icon } from '@/components/icons';
import { HELP_ROUTES, navPathLabel } from '@/lib/nav';

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

const COMMANDS: [string, string][] = [
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


// 选题引擎的八种候选来源。这张表就是「推荐从哪儿来」的完整答案——
// 不写出来的话，用户看到卡片上的「抢跑窗口」「旧文翻新」这些徽标只能猜。
const TOPIC_SOURCES: [string, string][] = [
  ['来自热点', '当前热榜在榜话题'],
  ['来自竞对', '你订阅的同行的高热作品'],
  ['抢跑窗口', '话题已在别的平台爆了，你的主战平台还没有——赶在前面做'],
  ['旧文翻新', '你做过同题内容，这个话题又重新上榜了'],
  ['跨平台补发', '你在某平台的爆款，还没发到其他主战平台'],
  ['节点日历', '618、开学季这类每年确定会来的流量节点，赢在提前量'],
  ['常青题', '赛道里常年有人问的话题，没热点的日子靠它'],
  ['灵感箱', '你自己存进收集箱的内容，和从评论里挖出来的读者提问'],
];

export default function HelpPage() {
  return (
    <>
      <HubHeader title="使用帮助" hint="第一天 10 分钟跑通，之后只需要花在创作上" />

      {/* 0. 快速上手 */}
      <Card
        title="🚀 第一天 10 分钟跑通"
        sub="建人设 → 生成推荐 → 采纳 → 起稿 → 登记发布"
        style={{ marginBottom: 16 }}
      >
        <div className="stack" style={{ gap: 10 }}>
          <Step n={1}>到<a href="/persona">人设与记忆</a>，一句话创建专属人设——这是所有推荐的地基。</Step>
          <Step n={2}>回<a href="/">首页</a>点「生成今日推荐」，AI 会按你的人设挑 5-10 条选题。</Step>
          <Step n={3}>到<a href="/topics">选题引擎</a>挑 1 条采纳，然后到<a href="/studio">创作工坊</a>点「AI 生成初稿」。</Step>
          <Step n={4}>改好后发布到平台，回<a href="/studio">创作工坊</a>点「登记发布」，贴上作品链接。</Step>
          <Step n={5}>到<a href="/data">数据看板</a>回填第一条表现数据——推荐会越来越准。</Step>
          <p className="small muted">以上跑通一遍，你就知道烽火台每天能帮你做什么了。下面的采集助手和飞书机器人是进阶配置。</p>
        </div>
      </Card>

      {/* 1. 采集助手 */}
      <Card
        title="① 装浏览器采集助手"
        sub="顺手把公开数据收进作战室"
        style={{ marginBottom: 16 }}
        action={<Link href="/extension" className="btn btn-sm btn-primary"><Icon.download size={13} /> 去下载</Link>}
      >
        <div className="stack" style={{ gap: 10 }}>
          <Step n={1}>选你的浏览器下载安装（Chrome / Edge / 360 / Brave 通用；Safari 即将支持）。</Step>
          <Step n={2}>到「接入与密钥 → 插件采集令牌」点生成，把令牌复制进插件设置页。</Step>
          <Step n={3}>到「竞对监控」订阅竞对，打开对方公开主页即自动采集；自己作品页可一键回填数据。</Step>
          <p className="small muted">只采你在页面上亲眼可见的公开数据；每日定时采集默认开启（后台开页采你已订阅的竞对，采完即关，可在插件设置关闭）。</p>
        </div>
      </Card>

      {/* 2. 飞书机器人 */}
      <Card
        title="② 配机器人（飞书 / 钉钉 / 企微 / 微信）"
        sub="内容推到群，群里也能发指令；微信用户可直接对话"
        style={{ marginBottom: 16 }}
        action={<Link href="/notifications" className="btn btn-sm btn-primary"><Icon.chat size={13} /> 去设置</Link>}
      >
        <div className="stack" style={{ gap: 14 }}>
          <p className="small muted">位置：「工具 → 机器人与通知」页面。</p>

          <div className="stack" style={{ gap: 8 }}>
            <div className="small"><b>出站推送（2 分钟，推荐先配）</b> —— 每日选题 / 热点 / 合规告警 / 学习小结推到群</div>
            <Step n={1}>飞书群 → 设置 → 群机器人 → 添加「自定义机器人」，复制 webhook。</Step>
            <Step n={2}>粘进设置页，勾选要推的事件，「保存」→「测试发送」，群里收到就通了。</Step>
          </div>

          <div className="stack" style={{ gap: 8 }}>
            <div className="small"><b>入站 ChatOps（进阶）</b> —— 群里发链接/文本即收录、发指令驱动引擎</div>
            <Step n={1}>展开「入站 ChatOps」，点「打开飞书开放平台」建自建应用，填 App ID / App Secret。</Step>
            <Step n={2}>前往飞书「事件订阅」：在「回调配置」贴回调地址（或在「订阅方式」选长连接模式），将 Verification Token（和 Encrypt Key）填回系统。</Step>
            <Step n={3}>在「事件配置」点「添加事件」加入 im.message.receive_v1，开通消息权限、加机器人功能并发布。</Step>
          </div>

          <div className="stack" style={{ gap: 8 }}>
            <div className="small"><b>微信（自己用）</b> —— 微信官方 iLink 机器人接口（微信 ClawBot 同一套），扫码即绑，机器人出现在你微信的联系人里</div>
            <Step n={1}>「消息渠道」点「微信」卡「接入」，用微信扫码并在手机上确认，什么都不用填。</Step>
            <Step n={2}>在微信里给刚出现的机器人发一句话：问题、文章链接、一句选题都行。只有扫码的这个号能聊，它只回复不主动发；登录态过期回来重扫。</Step>
            <div className="small" style={{ marginTop: 4 }}><b>微信客服（对外接客）</b> —— 企业微信的微信客服通道：客户扫你企业的客服码找你；谁扫码都能聊，登录/派任务不可用，默认只开对话、剪藏、收录、热榜</div>
            <Step n={3}>企业微信后台 → 应用管理 → 微信客服，新建客服账号并生成 API Secret；点「微信客服」卡「接入」填 CorpID / Secret / 回调 Token / EncodingAESKey，把回调 URL 粘回企微后台，点「体检」验证。</Step>
          </div>

          <div className="stack" style={{ gap: 0, marginTop: 2 }}>
            <div className="small" style={{ marginBottom: 6 }}><b>装好后在群里怎么用</b></div>
            {COMMANDS.map(([cmd, act], i) => (
              <div key={i} className="row-between" style={{ padding: '7px 0', borderTop: '1px solid var(--surface-2)', gap: 12 }}>
                <code className="small mono" style={{ color: 'var(--brand)' }}>{cmd}</code>
                <span className="small muted" style={{ textAlign: 'right' }}>{act}</span>
              </div>
            ))}
          </div>
          <p className="small muted">收录只进候选池、不自动发布；生成内容仍全程过合规。</p>
        </div>
      </Card>

      {/* 3. 持续学习 */}
      <Card
        title="③ 让记忆越用越懂你"
        sub="持续学习优化"
        style={{ marginBottom: 16 }}
        action={<Link href="/persona" className="btn btn-sm btn-primary"><Icon.user size={13} /> 去人设与记忆</Link>}
      >
        <div className="stack" style={{ gap: 10 }}>
          <p className="small muted">位置：「人设与记忆 →『持续学习与优化』卡片」。</p>
          <Step n={1}>系统每天自动优化一次记忆（去重、让反复验证的结论生效、给老旧观察降权遗忘）。</Step>
          <Step n={2}>想立刻优化，点卡片里的「⚡ 立即优化记忆」。</Step>
          <Step n={3}>下方会给出人设改进建议——只是建议，改不改由你，去「人设卡」点编辑自行采纳。</Step>
        </div>
      </Card>

      {/* 4. 选题引擎怎么读 */}
      <Card
        title="④ 看懂每天的选题推荐"
        sub="先做哪个、为什么推给你、怎么开工"
        style={{ marginBottom: 16 }}
        action={<Link href="/topics" className="btn btn-sm btn-primary"><Icon.bulb size={13} /> 去选题引擎</Link>}
      >
        <div className="stack" style={{ gap: 14 }}>
          <div className="stack" style={{ gap: 8 }}>
            <div className="small"><b>推荐按「什么时候做」分三队</b>，不是按分数排一长条</div>
            <Step n={1}><b>今日突击</b>：有时间窗口，过期作废——今天不动手就没了。</Step>
            <Step n={2}><b>本周窗口</b>：有节奏但不紧急，适合排进本周产能。</Step>
            <Step n={3}><b>常青储备</b>：不依赖热点，什么时候做都成立；没头绪或产能有空档时用。</Step>
            <p className="small muted">
              综合分回答「值不值得做」，队列回答「先做哪个」——两件事，不互相顶替。
            </p>
          </div>

          <div className="stack" style={{ gap: 8 }}>
            <div className="small"><b>每条卡片上的三样东西</b></div>
            <Step n={1}><b>差异化切入角</b>：AI 给的创意，一句话说清怎么避开同质化。</Step>
            <Step n={2}>
              <b>为什么推给你</b>：查你的数据查出来的<b>事实</b>（哪条旧作跑赢过、话题几点在哪上的榜）。
              它和切入角分开放，就是为了让你分得清哪句是创意、哪句是证据。
            </Step>
            <Step n={3}>
              <b>作战卡</b>（点开折叠）：同行做过的参考样本、你自己的最佳发布时段、近 72 小时的竞争密度、
              你在该平台的真实水位。<b>只放事实，不给预测</b>——不编「预计播放多少」这种数。
            </Step>
          </div>

          <div className="stack" style={{ gap: 0, marginTop: 2 }}>
            <div className="small" style={{ marginBottom: 6 }}><b>推荐从哪儿来</b>（卡片左上角的徽标）</div>
            {TOPIC_SOURCES.map(([name, what], i) => (
              <div key={i} className="row-between" style={{ padding: '7px 0', borderTop: '1px solid var(--surface-2)', gap: 12 }}>
                <span className="small" style={{ flexShrink: 0 }}><b>{name}</b></span>
                <span className="small muted" style={{ textAlign: 'right' }}>{what}</span>
              </div>
            ))}
          </div>
          <p className="small muted">
            还会看到<b>「蓝海」</b>标：这个话题在榜上活得久、跨平台扩散广，而你监控的同行还没怎么做。
            它算的是站内可观测的信号（在榜时长 × 扩散平台数 × 竞对同题密度），<b>不是全网搜索指数</b>。
          </p>
        </div>
      </Card>

      {/* 5. 灵感收集箱 */}
      <Card
        title="⑤ 把转瞬即逝的念头存下来"
        sub="灵感收集箱 · 读者提问"
        style={{ marginBottom: 16 }}
        action={<Link href="/topics?view=inspiration" className="btn btn-sm btn-primary"><Icon.plus size={13} /> 去收集箱</Link>}
      >
        <div className="stack" style={{ gap: 10 }}>
          <Step n={1}>
            刷到值得记一笔的内容，用采集助手侧栏的「收进灵感箱」一键存下来；也可以在页面上手动记。
            <b>备注那栏最有用</b>——有备注时系统会拿你写的那句话当选题，而不是原标题。
          </Step>
          <Step n={2}>
            点「从评论里挖问题」，把评论区的文字整段粘进去，系统只挑出<b>提问句</b>存起来。
            被问得越多的问题，越值得做成内容。
          </Step>
          <Step n={3}>
            存进来的东西会<b>主动参与每天的推荐</b>：撞上热点时它会带着「你 3 周前收藏过这个」一起推给你；
            没撞上就自己进「本周窗口」。变成选题被采纳后自动出队，不会重复出现。
          </Step>
        </div>
      </Card>

      {/* 6. 爆款基因 */}
      <Card
        title="⑥ 看什么样的内容在你账号真的跑得动"
        sub="爆款基因 · 每个数都能自己验算"
        style={{ marginBottom: 16 }}
        action={<Link href="/genes" className="btn btn-sm btn-primary"><Icon.gauge size={13} /> 去看基因</Link>}
      >
        <div className="stack" style={{ gap: 10 }}>
          <Step n={1}>
            按<b>选题来源 / 平台 / 发布时段 / 切入角</b>四个维度，算出你已发布内容的真实胜率。
          </Step>
          <Step n={2}>
            胜率 = 该类里跑赢你同平台均播的条数 ÷ 该类总条数。<b>不足 3 条的类别只报条数、不报胜率</b>
            ——2 条里赢 1 条不是 50% 胜率，是没有结论。
          </Step>
          <Step n={3}>
            要让「选题来源」和「切入角」两维有数据，发布时需要带上选题归因——
            也就是从选题引擎采纳、再去创作工坊做出来的内容。
          </Step>
        </div>
      </Card>

      {/* 7. 创作工坊：写出不像 AI 写的东西 */}
      <Card
        title="⑦ 在创作工坊写出不像 AI 写的东西"
        sub="自由起稿 · 人味体检 · 一稿多平台 · 标题矩阵"
        style={{ marginBottom: 16 }}
        action={<Link href="/studio" className="btn btn-sm btn-primary"><Icon.pen size={13} /> 去创作工坊</Link>}
      >
        <div className="stack" style={{ gap: 10 }}>
          <Step n={1}>
            <b>不一定要从选题开始。</b>点右上角「新建草稿」：可以<b>粘一段你已经写好的稿</b>、
            也可以只给<b>一句话想法</b>让它展开成初稿，或者先开个空白稿自己写。
          </Step>
          <Step n={2}>
            <b>想让 AI 写得像你，就喂它你写过的东西。</b>到
            <Link href="/material">素材库</Link>加几条「文风样本」（整段贴你自己写过的稿子），
            之后所有生成都会照着那个语感写——这比在人设里写「语气：幽默」有用得多。
            你粘进来建草稿的原稿、你发布过的正文，也会自动进入样本池。
          </Step>
          <Step n={3}>
            编辑框里除了「算法教练」，还有一张<b>人味体检</b>：检测大模型套话、句子节奏、
            排比密度、口语碎句，全是确定性规则、不花 AI 额度。觉得哪版太「AI」，点
            <b>「一键去 AI 味」</b>——它只换说法，信息一个不加一个不减。
            <span className="muted">（不足 120 字不出分：那么短算不出节奏，给分等于骗你。）</span>
          </Step>
          <Step n={4}>
            起草时可以勾<b>「深度模式」</b>：它先只列要点大纲（只管想清楚说什么），
            再照着你的原句样本把大纲写成成稿（只管怎么说）。
            一次生成里这两件事互相抢注意力，模型的默认解法就是保内容、丢文风——拆开之后才像你写的。
            代价是<b>两次 AI 调用</b>，所以要你自己勾，不做默认。
          </Step>
          <Step n={5}>
            正文定了再点<b>「生成标题矩阵 + 封面建议」</b>：一次给 6 个角度互不相同的标题
            （结果前置 / 悬念 / 反常识 / 身份指向 / 数字清单 / 痛点提问），每条附长度与用词诊断，
            命中合规红线的会被直接拦下。
          </Step>
          <Step n={6}>
            同一篇要发几个平台，用<b>「一稿多平台」</b>派生：每个平台生成一份独立草稿，
            各自登记发布、各自回流数据，之后这里会告诉你<b>同一篇内容在哪个平台跑赢了</b>。
          </Step>
          <Step n={7}>
            技能永远基于<b>最新一版</b>正文运行（结果卡上会写明用了第几版）；
            展开「本次要求」还能指定这一次的篇幅、语气和要用上的素材。
          </Step>
        </div>
      </Card>

      {/* 8. 隐私与数据安全声明 */}
      <PrivacyCard />

      {/* 一句话总览 */}
      <Card title="一句话总览" sub="想做什么 · 去哪">
        <div className="stack" style={{ gap: 0 }}>
          {HELP_ROUTES.map(({ what, href }, i) => (
            <Link
              key={i}
              href={href}
              className="row-between"
              style={{ padding: '10px 0', borderTop: '1px solid var(--surface-2)', gap: 12, textDecoration: 'none', color: 'inherit' }}
            >
              <span className="small"><b>{what}</b></span>
              <span className="row small muted" style={{ gap: 6, alignItems: 'center', textAlign: 'right' }}>
                {navPathLabel(href) ?? ''} <Icon.arrow size={13} />
              </span>
            </Link>
          ))}
        </div>
      </Card>
    </>
  );
}
