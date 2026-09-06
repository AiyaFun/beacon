import Link from 'next/link';
import Image from 'next/image';
import { headers } from 'next/headers';
import { SLOGAN, SLOGAN_EN, SUBLINE, SUBLINE_EN } from '@/lib/brand';
import { PRICING, TRIAL_DAYS, BYOK_LIFETIME_FEN } from '@/lib/pay/pricing';
import { TOPIC_SOURCE_LABEL } from '@/lib/constants';
import { readDesktopManifest, pickDesktopBuild, storeLinks, DESKTOP_OS_LABEL } from '@/lib/downloads';
import { getServerLang } from '@/lib/i18n/server';
import { GuestButton } from '@/app/login/GuestButton';
import { TrackView } from '@/components/growth/TrackView';
import { TrackLink } from '@/components/growth/TrackLink';

// 公开首页（2026-09-05 增长缺口整改）。
//
// 【它要回答的四个问题，按屏】① 这是什么、给谁 ② 它凭什么不一样（八来源） ③ 多少钱 ④ 怎么拿到。
// 一屏一句话，动图位用产品截图顶（marketing/shots 那批，演示黄条故意留着：通篇讲不编数据，
// 截图里拿示例数据当战绩会自己打自己脸）。
//
// 【三条硬规矩】不写「毫秒级」「实时监控」这类别处处处强调不编数据、这里却吹的词；
// 「我们坚决没做的」那一屏是信任不是道歉，放在价格之后、下载之前；
// 所有下载/体验按钮都记漏斗事件（TrackLink / GuestButton 内部），否则这一页做了也不知道有没有用。
//
// 只在 SaaS 未登录时由 app/(app)/page.tsx 渲染；整机/私有化没有对外营销面。
export async function Landing() {
  const lang = await getServerLang();
  const en = lang === 'en';
  const ua = (await headers()).get('user-agent');
  const manifest = readDesktopManifest();
  const rec = pickDesktopBuild(manifest, ua);
  const chrome = storeLinks().chrome;

  const SOURCES: { key: string; own: boolean }[] = [
    { key: 'hot', own: false }, { key: 'competitor', own: false },
    { key: 'gap', own: true }, { key: 'recycle', own: true }, { key: 'crossplat', own: true },
    { key: 'calendar', own: true }, { key: 'evergreen', own: true }, { key: 'inspiration', own: true },
  ];

  const NOT_DONE = en
    ? [
        ['No "expected views" guesses', 'A subjective LLM score times your average views looks like data and isn’t. Worse than nothing, because you would trust it.'],
        ['No fake trending items', 'When a platform has no real channel we say "source not enabled" instead of padding the list.'],
        ['No login-state hosting', 'Publishing fills your creator backend and stops before the publish button. You press it.'],
        ['No back-door scraping of WeChat', 'That channel used your own account against unofficial endpoints. We removed it; it will not come back.'],
      ]
    : [
        ['不做「预期播放量区间」', '账号均播 × 模型打的流量分，是一个看起来像数据的猜测。比没有数据更危险，因为你会信它。'],
        ['不用示例数据凑热榜', '某平台没有真实通道就如实标「数据源未启用」，一条示例都不进推荐。'],
        ['不托管你的登录态', '发布只把内容填进创作后台，停在发布按钮前。那一下由你点。'],
        ['不走公众号非官方接口', '那条通道用的是你自己的后台登录态，踩线被限的是你的号。已整条删除，不会恢复。'],
      ];

  return (
    <div className="landing">
      <TrackView name="landing_view" />

      {/* ① 一句话 */}
      <section className="landing-hero">
        <div className="landing-hero-copy">
          <span className="landing-eyebrow">{en ? 'For creators who publish every week' : '给持续更新的创作者'}</span>
          <h1>{en ? SLOGAN_EN : SLOGAN}</h1>
          <p className="landing-sub">{en ? SUBLINE_EN : SUBLINE}</p>
          <div className="landing-cta">
            <Link href="/login" className="btn btn-primary landing-btn">{en ? `Start free · ${TRIAL_DAYS} days Pro` : `免费开始 · 送 ${TRIAL_DAYS} 天标准版`}</Link>
            <Link href="/topics-today" className="btn landing-btn">{en ? 'See today’s topics' : '先看今日选题榜'}</Link>
          </div>
          <div className="landing-guest"><GuestButton /></div>
          <ul className="landing-trust">
            <li>{en ? 'Chrome Web Store listed' : 'Chrome 应用商店已上架'}</li>
            <li>{en ? 'macOS app signed & notarized' : 'macOS 客户端已签名公证'}</li>
            <li>{en ? 'AGPL-3.0 open source' : 'AGPL-3.0 开源'}</li>
            <li>{en ? 'No card for trial' : '试用不要卡、不自动扣费'}</li>
          </ul>
        </div>
        <div className="landing-hero-shot">
          <Image src="/landing/topics.png" alt={en ? 'Topic engine: every recommendation says why you and why now' : '选题引擎：每条推荐都带「为什么是你、为什么是现在」'} width={1440} height={900} priority sizes="(max-width: 900px) 100vw, 56vw" />
          <div className="landing-shot-caption">{en ? 'Every card says why you, why now, and the window left.' : '每张卡都写着：为什么推给你、凭什么是现在、抢跑窗口还剩几小时。'}</div>
        </div>
      </section>

      {/* ② 八来源 */}
      <section className="landing-section">
        <h2>{en ? 'Eight sources of topics. Only two look at the charts.' : '选题从八个地方来，只有两个跟今天的热榜有关'}</h2>
        <p className="landing-lead">
          {en
            ? 'Most days have no hot topic. A recommender that only chases trends politely hands you filler on those days. Six of our eight sources do not depend on today’s charts at all.'
            : '大部分日子是没有热点的。只会追热点的推荐系统，在那些天会体面地推给你一堆凑数的东西。八条来源里有六条与今天的热榜完全无关。'}
        </p>
        <div className="landing-sources">
          {SOURCES.map(({ key, own }) => {
            const r = TOPIC_SOURCE_LABEL[key];
            return (
              <div key={key} className={`landing-source${own ? ' own' : ''}`}>
                <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                  <span className={`badge ${r.badge}`}>{en ? r.nameEn : r.name}</span>
                  {own && <span className="small muted">{en ? 'needs your data' : '靠你的数据'}</span>}
                </div>
                <p>{en ? r.hintEn : r.hint}</p>
              </div>
            );
          })}
        </div>
        <p className="small muted" style={{ marginTop: 10 }}>
          {en
            ? 'Rule for the gap window: it only fires when we can actually observe that your platform does not have the topic yet. If we cannot observe, the source stays silent.'
            : '抢跑窗口有一条硬规则：只在能真正观测到「你的平台还没有」时才产出。观测不到就整个来源沉默，不许猜。'}
        </p>
      </section>

      {/* ③ 一天怎么过 */}
      <section className="landing-section">
        <h2>{en ? 'A day with it' : '用它的一天'}</h2>
        <div className="landing-steps">
          <div className="landing-step">
            <Image src="/landing/today.png" alt="今日概览" width={1440} height={900} sizes="(max-width: 900px) 100vw, 30vw" />
            <b>{en ? '08:00 · Open, see today’s brief' : '08:00 · 打开，看今天的选题'}</b>
            <p>{en ? 'Three to six topics ranked for your account, each with evidence pulled from the database, not written by the model.' : '三到六条按你的账号排好的选题，证据是查库查出来的事实，不是模型编的话术。'}</p>
          </div>
          <div className="landing-step">
            <Image src="/landing/studio.png" alt="创作工坊" width={1440} height={900} sizes="(max-width: 900px) 100vw, 30vw" />
            <b>{en ? '08:20 · Draft, rewrite per platform, check' : '08:20 · 起稿、按平台改写、查红线'}</b>
            <p>{en ? 'One draft into platform-native versions; a four-tier sensitive-word scan before anything leaves.' : '一稿改成各平台的样子；发之前过一遍四级敏感词库和分平台规则。'}</p>
          </div>
          <div className="landing-step">
            <Image src="/landing/sources.png" alt="八来源说明" width={1440} height={900} sizes="(max-width: 900px) 100vw, 30vw" />
            <b>{en ? 'Next morning · Data flows back' : '第二天早上 · 数据自己回来'}</b>
            <p>{en ? 'Real performance calibrates tomorrow’s brief. Absent metrics stay blank instead of pretending to be zero.' : '真实表现反过来校准明天的推荐。拿不到的指标如实留空，不冒充 0。'}</p>
          </div>
        </div>
      </section>

      {/* ④ 价格 */}
      <section className="landing-section">
        <h2>{en ? 'Pricing' : '价格'}</h2>
        <div className="landing-prices">
          <div className="landing-price">
            <b>{en ? 'Free' : '免费版'}</b>
            <div className="landing-price-num">¥0</div>
            <p>{en ? 'Every feature, 30 AI calls a day, no expiry.' : '功能全开，AI 每天 30 次，没有到期日。'}</p>
          </div>
          <div className="landing-price featured">
            <b>{PRICING.personal.name}</b>
            <div className="landing-price-num">¥{PRICING.personal.monthFen / 100}<span>/{en ? 'mo' : '月'}</span></div>
            <p>{en ? `AI by platform key, 200 calls a day. Annual ¥${PRICING.personal.yearFen / 100}.` : `AI 由平台提供，每天 200 次。年付 ¥${PRICING.personal.yearFen / 100}（付 10 个月用 12 个月）。`}</p>
          </div>
          <div className="landing-price">
            <b>{PRICING.byok.name}</b>
            <div className="landing-price-num">¥{PRICING.byok.monthFen / 100}<span>/{en ? 'mo' : '月'}</span></div>
            <p>{en ? `Bring your own model key. Lifetime ¥${BYOK_LIFETIME_FEN / 100}.` : `自带模型 Key，平台只收工具费。永久买断 ¥${BYOK_LIFETIME_FEN / 100}。`}</p>
          </div>
        </div>
        <p className="small muted" style={{ marginTop: 10 }}>
          {en ? `Sign up and get ${TRIAL_DAYS} days of Pro. No payment method. ` : `注册即送 ${TRIAL_DAYS} 天标准版，不用填付款方式。`}
          <Link href="/pricing" style={{ color: 'var(--brand)', fontWeight: 600 }}>{en ? 'Full comparison →' : '完整对照表 →'}</Link>
        </p>
      </section>

      {/* ⑤ 坚决没做的 */}
      <section className="landing-section landing-notdone">
        <h2>{en ? 'What we deliberately did not build' : '我们坚决没做的'}</h2>
        <p className="landing-lead">{en ? 'A product is defined by what it refuses to fake.' : '不做的清单，比功能清单更能说明一个产品。'}</p>
        <div className="landing-notdone-grid">
          {NOT_DONE.map(([t, d]) => (
            <div key={t} className="landing-notdone-item"><b>{t}</b><p>{d}</p></div>
          ))}
        </div>
      </section>

      {/* ⑤½ 手机上 */}
      <section className="landing-section">
        <h2>{en ? 'On your phone' : '手机上怎么用'}</h2>
        <p className="landing-lead">
          {en
            ? 'Ideas show up while you scroll. Three things work well on a phone today; the rest is better on a desktop.'
            : '灵感是刷手机的时候来的。今天在手机上顺手的是这三件事，其余的在电脑上更好用。'}
        </p>
        <div className="landing-get-grid">
          <div className="landing-get-item">
            <b>{en ? 'Add to home screen' : '添加到主屏幕'}</b>
            <p>{en ? 'Open the site in Safari / Chrome, choose “Add to Home Screen”. Long-press the icon for: today’s topics, save an idea, yesterday’s numbers.' : '用 Safari / Chrome 打开本站，选「添加到主屏幕」。长按图标直达：看今天的选题、存一个灵感、看昨天的数据。'}</p>
          </div>
          <div className="landing-get-item">
            <b>{en ? 'Ask the bot in your chat app' : '在群里问机器人'}</b>
            <p>{en ? 'Bind a Feishu / DingTalk / WeCom / WeChat bot once; then “what should I make today” works from your phone.' : '飞书 / 钉钉 / 企微 / 微信机器人绑定一次，之后在手机上问一句「今天做什么」就有答案；派任务也行。'}</p>
          </div>
          <div className="landing-get-item">
            <b>{en ? 'Honest limit' : '如实说'}</b>
            <p>{en ? 'Collection and publishing run through the desktop app or the extension; there is no mobile app yet.' : '采集与发布走桌面客户端或插件，目前没有手机 App。'}</p>
          </div>
        </div>
      </section>

      {/* ⑥ 拿到它 */}
      <section className="landing-section landing-get">
        <h2>{en ? 'Get it' : '怎么拿到'}</h2>
        <div className="landing-get-grid">
          <div className="landing-get-item">
            <b>{en ? 'Use it in the browser' : '网页直接用'}</b>
            <p>{en ? 'Everything works in the browser. Nothing to install.' : '所有功能网页里都有，不装任何东西也能用。'}</p>
            <Link href="/login" className="btn btn-primary btn-sm">{en ? 'Start free' : '免费开始'}</Link>
          </div>
          <div className="landing-get-item">
            <b>{en ? 'Desktop app: data syncs itself' : '桌面客户端：数据自己回来'}</b>
            <p>{en ? 'Mac / Windows. Competitor updates and your X / TikTok profile metrics flow back daily without the extension.' : 'Mac / Windows。同行动态与你在 X / TikTok 的主页数据每天自动回流，不用装插件。'}</p>
            <div className="row wrap" style={{ gap: 8 }}>
              {rec ? (
                <TrackLink event="download_click" meta={rec.os} href={rec.file} download className="btn btn-sm btn-primary">
                  {en ? `Download for ${DESKTOP_OS_LABEL[rec.os]}` : `下载 ${DESKTOP_OS_LABEL[rec.os]} 版`} · {rec.sizeMB} MB
                </TrackLink>
              ) : null}
              <Link href="/desktop" className="btn btn-sm">{en ? 'All builds' : '全部安装包'}</Link>
            </div>
            {manifest && !manifest.builds.some((b) => b.os === 'win') && (
              <p className="small muted" style={{ marginTop: 6 }}>{en ? 'Windows build is not published yet; the web version has every feature.' : 'Windows 包还没发出来；网页版功能一样不少。'}</p>
            )}
          </div>
          <div className="landing-get-item">
            <b>{en ? 'Browser extension' : '浏览器插件'}</b>
            <p>{en ? 'Save inspiration while browsing; backfill your own posts’ metrics with one click.' : '浏览时顺手存灵感，在自己作品页一键回填表现数据。'}</p>
            <div className="row wrap" style={{ gap: 8 }}>
              {chrome && <TrackLink event="download_click" meta="ext-store" href={chrome} target="_blank" rel="noreferrer" className="btn btn-sm btn-primary">{en ? 'Chrome Web Store' : 'Chrome 应用商店'}</TrackLink>}
              <Link href="/extension" className="btn btn-sm">{en ? 'Details & zip' : '详情与 zip 版'}</Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
