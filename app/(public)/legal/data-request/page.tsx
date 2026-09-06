import Link from 'next/link';
import { DataRequestForm } from './DataRequestForm';
import { getServerLang } from '@/lib/i18n/server';

export async function generateMetadata() {
  const lang = await getServerLang();
  return {
    title: lang === 'en' ? 'Data Removal Request — Beacon' : '被监控账号移除申请 — 烽火台',
  };
}

export default async function DataRequestPage() {
  const lang = await getServerLang();
  const isEn = lang === 'en';

  if (isEn) {
    return (
      <article className="legal-article">
        <h1>Data Removal Request</h1>
        <p className="small muted">Pursuant to Personal Information Protection Law · Right to Refuse</p>

        <h2>About Our Data Sources</h2>
        <p>
          Beacon&apos;s competitor monitoring features only collect <b>publicly published</b> profile information and post metadata
          (such as public handle, bio, post titles, and engagement stats) to provide content benchmarking for our users.
          In addition, users may manually extract <b>displayed</b> comment text from public comment sections (excluding any commenter identity data).
          This content has two purposes: <b>comment text</b> is stored for up to 90 days for user reading and word frequency analysis before <b>automatic physical deletion</b>;
          questions asked by <b>two or more</b> individuals may be retained as topic inspirations. Neither enters AI training corpora, nor are they exported.
          We do not collect private messages, drafts, backend data, or store any third-party platform credentials.
        </p>

        <h2>Your Rights</h2>
        <p>
          If you are the owner or authorized representative of a monitored account or website, you have the right to request that we stop collecting and remove previously collected public information
          (including <b>comment text and topic questions</b> extracted from your posts—both will be deleted together).
          Please fill out the form below. We will verify and process your request, during which new data collection for the target will be paused.
        </p>

        <DataRequestForm />

        <p className="small muted" style={{ marginTop: 16 }}>
          By submitting, you confirm that you hold legitimate rights to the specified account or website. We may request further verification to prevent misuse.
        </p>

        <div className="legal-nav">
          <Link href="/legal/privacy">Privacy Policy →</Link>
          <span style={{ margin: '0 8px', color: 'var(--muted, #94a3b8)' }}>·</span>
          <Link href="/legal/terms">Terms of Service →</Link>
        </div>
      </article>
    );
  }

  return (
    <article className="legal-article">
      <h1>被监控账号移除申请</h1>
      <p className="small muted">依据《中华人民共和国个人信息保护法》· 权利人拒绝权</p>

      <h2>关于我们的数据来源</h2>
      <p>
        烽火台的竞对监控功能仅采集各平台<b>已公开发布</b>的账号主页信息与作品数据
        （如公开昵称、简介、公开作品的标题与互动量），用于向我们的用户提供内容对标分析。
        此外，用户可手动提取作品评论区中<b>已显示</b>的评论文本（不含评论者任何身份信息）。
        这部分内容有两个去处：<b>评论正文</b>逐条留存供该用户阅读与词频统计，<b>最长 90 天后自动物理删除</b>；
        其中被<b>两人以上</b>问过的提问短句另外进入选题参考。两者都不进入任何 AI 生成语料、不导出。
        我们不采集任何非公开信息，不获取私信、草稿、后台数据，也不托管任何平台的登录凭证。
      </p>

      <h2>你的权利</h2>
      <p>
        如果你是被监控账号的主体或其合法授权代表，你有权要求我们停止采集并移除已收集的相关公开信息
        （含从您作品评论区提取的<b>评论正文与提问短句</b>——两者会一并删除，不是只删其中一种）。
        请填写下方表单，我们会在核实后处理，核实期间暂停对该账号的新增采集。
      </p>

      <DataRequestForm />

      <p className="small muted" style={{ marginTop: 16 }}>
        提交即表示你确认对所填账号享有相应权利。为防止冒用，我们可能需要进一步核实你的身份。
      </p>

      <div className="legal-nav">
        <Link href="/legal/privacy">隐私政策 →</Link>
        <span style={{ margin: '0 8px', color: 'var(--muted, #94a3b8)' }}>·</span>
        <Link href="/legal/terms">服务条款 →</Link>
      </div>
    </article>
  );
}

