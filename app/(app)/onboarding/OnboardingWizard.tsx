'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui';
import { Icon } from '@/components/icons';
import { PLATFORM_LIST, platformName, platformColor } from '@/lib/constants';
import { PRESET_NICHES } from '@/lib/topic/niches';
import { parseCompetitorUrl } from '@/lib/competitor-url';
import {
  actOnboardingProfile,
  actOnboardingSuggest,
  actOnboardingCompetitors,
  actOnboardingGenerate,
  actOnboardingReadiness,
} from './actions';

// 十分钟开场向导的界面（2026-09-06 视觉与交互全新升级）。
// 三步闭环：① 你是谁（赛道+平台+主页） ② 同行（订阅+找感） ③ 开跑（八源就绪雷达+起稿）。
// 服务端回执如实显示：派出去了就说派出去了，派不出去就说为什么，不替系统圆场。

type Suggest = Awaited<ReturnType<typeof actOnboardingSuggest>>[number];
type Readiness = Awaited<ReturnType<typeof actOnboardingReadiness>>;
type Note = { url: string; ok: boolean; note: string };

const MAIN_PLATFORMS = ['douyin', 'xiaohongshu', 'wechat', 'bilibili', 'shipinhao', 'x', 'youtube', 'tiktok'];

export function OnboardingWizard({ initial, lang }: { initial: { niche: string; platforms: string[]; identity: string; handle: string }; lang: string }) {
  const en = lang === 'en';
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [niche, setNiche] = useState(initial.niche);
  const [platforms, setPlatforms] = useState<string[]>(initial.platforms.length > 0 ? initial.platforms : ['xiaohongshu', 'douyin']);
  const [sentence, setSentence] = useState(initial.identity);
  const [profileUrl, setProfileUrl] = useState('');
  const [profileNote, setProfileNote] = useState<Note | null>(null);
  const [suggests, setSuggests] = useState<Suggest[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [urls, setUrls] = useState('');
  const [compNotes, setCompNotes] = useState<Note[]>([]);
  const [genMsg, setGenMsg] = useState('');
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [err, setErr] = useState('');
  const [pending, start] = useTransition();

  // 实时解析用户粘贴的主页链接
  const parsedProfile = profileUrl.trim() ? parseCompetitorUrl(profileUrl.trim()) : null;

  const togglePlatform = (p: string) => {
    setPlatforms((cur) => {
      if (cur.includes(p)) {
        return cur.filter((x) => x !== p);
      }
      if (cur.length >= 5) {
        setErr(en ? 'Maximum 5 main platforms allowed.' : '主战平台最多选 5 个，建议聚焦 1–3 个主力战场');
        return cur;
      }
      setErr('');
      return [...cur, p];
    });
  };

  function submitProfile() {
    setErr('');
    if (!niche.trim() || niche.trim().length < 2) {
      setErr(en ? 'Please enter a niche with 2–20 characters.' : '请填写你的赛道（2–20 字）');
      return;
    }
    if (platforms.length === 0) {
      setErr(en ? 'Please select at least 1 main platform.' : '请至少选择 1 个主战平台');
      return;
    }
    start(async () => {
      const r = await actOnboardingProfile({ niche, platforms, sentence, profileUrl });
      if (!r.ok) {
        setErr(r.error);
        return;
      }
      setProfileNote(r.profile);
      setSuggests(await actOnboardingSuggest(niche));
      setStep(2);
    });
  }

  function submitCompetitors() {
    setErr('');
    start(async () => {
      const r = await actOnboardingCompetitors({
        urls: urls.split('\n').map((x) => x.trim()).filter(Boolean),
        competitorIds: picked,
      });
      if (!r.ok) {
        setErr(r.error);
        return;
      }
      setCompNotes(r.results);
      setStep(3);
      setGenMsg(en ? 'Generating the first brief (hotlists → peers → ranking)…' : '正在生成第一份推荐（热榜 → 同行 → 精排）…');
      const g = await actOnboardingGenerate();
      setGenMsg(g.ok ? (en ? `Done: ${g.created} topics recommended.` : `推荐就绪：生成了 ${g.created} 条精排选题。`) : (en ? `Generation stopped: ${g.error}` : `生成没跑完：${g.error}`));
      setReadiness(await actOnboardingReadiness());
    });
  }

  return (
    <div className="ob-container">
      {/* ── 步骤指示器 ── */}
      <div className="ob-stepper">
        {/* 步骤 1 */}
        <div className={`ob-step-item ${step === 1 ? 'ob-step-active' : step > 1 ? 'ob-step-done' : ''}`}>
          <div className="ob-step-circle">
            {step > 1 ? <Icon.check size={16} /> : '1'}
          </div>
          <div className="ob-step-texts">
            <span className="ob-step-title">{en ? 'Profile & Channels' : '账号与赛道'}</span>
            <span className="ob-step-sub">{en ? 'Who you are' : '创作者底色'}</span>
          </div>
        </div>

        {/* 连线 1-2 */}
        <div className={`ob-step-line ${step > 1 ? 'active' : ''}`} />

        {/* 步骤 2 */}
        <div className={`ob-step-item ${step === 2 ? 'ob-step-active' : step > 2 ? 'ob-step-done' : ''}`}>
          <div className="ob-step-circle">
            {step > 2 ? <Icon.check size={16} /> : '2'}
          </div>
          <div className="ob-step-texts">
            <span className="ob-step-title">{en ? 'Benchmark Peers' : '对标同行'}</span>
            <span className="ob-step-sub">{en ? 'Subscribe & Learn' : '订阅与找感'}</span>
          </div>
        </div>

        {/* 连线 2-3 */}
        <div className={`ob-step-line ${step > 2 ? 'active' : ''}`} />

        {/* 步骤 3 */}
        <div className={`ob-step-item ${step === 3 ? 'ob-step-active' : ''}`}>
          <div className="ob-step-circle">
            {step === 3 && readiness ? <Icon.check size={16} /> : '3'}
          </div>
          <div className="ob-step-texts">
            <span className="ob-step-title">{en ? 'Ignite & Launch' : '全擎开跑'}</span>
            <span className="ob-step-sub">{en ? '8-Source Radar' : '八源并发推荐'}</span>
          </div>
        </div>
      </div>

      {/* ── Step 1: 你是谁 ── */}
      {step === 1 && (
        <Card
          title={
            <div className="row" style={{ gap: 8 }}>
              <span style={{ color: 'var(--brand)', display: 'flex' }}><Icon.user size={20} /></span>
              <span>{en ? 'Two things and one link' : '两件事，一个链接'}</span>
            </div>
          }
          sub={en ? 'Only what you say goes into the persona. Nothing is fabricated.' : '人设里只放你说的，一个字不编；没说的字段留空，之后可以用 AI 追问补'}
        >
          <div className="stack" style={{ gap: 20 }}>
            {/* 赛道 */}
            <div className="ob-field-group">
              <div className="ob-field-label">
                <span>{en ? 'Your Niche' : '你的赛道'}&nbsp;<b style={{ color: 'var(--brand)' }}>*</b></span>
                <span className="ob-field-label-desc">{en ? '2–20 characters' : '2–20 字 · 精确锁定全网爆款热榜'}</span>
              </div>
              <div className="ob-input-box">
                <span className="ob-input-icon"><Icon.radar size={17} /></span>
                <input
                  className="input"
                  value={niche}
                  onChange={(e) => setNiche(e.target.value)}
                  maxLength={20}
                  placeholder={en ? 'e.g. Career Growth / Home Cooking' : '例如：职场成长、家常菜、数码测评'}
                />
                <span className="ob-input-counter">{niche.length}/20</span>
              </div>
              <div className="ob-tag-cloud">
                <span className="small muted" style={{ display: 'flex', alignItems: 'center', gap: 4, marginRight: 2 }}>
                  <Icon.sparkles size={13} /> {en ? 'Quick presets:' : '热门预设:'}
                </span>
                {PRESET_NICHES.map((n) => (
                  <button
                    type="button"
                    key={n}
                    className={`ob-niche-tag ${niche === n ? 'selected' : ''}`}
                    onClick={() => setNiche(n)}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>

            {/* 主战平台 */}
            <div className="ob-field-group">
              <div className="ob-field-label">
                <span>{en ? 'Main Platforms' : '主战平台（可多选）'}&nbsp;<b style={{ color: 'var(--brand)' }}>*</b></span>
                <span className="ob-field-label-desc">
                  {en ? `Selected ${platforms.length}/5 (for cross-platform jumpstarts)` : `已选 ${platforms.length}/5 个 · 用于监测各平台抢跑窗口`}
                </span>
              </div>
              <div className="ob-platform-grid">
                {PLATFORM_LIST.filter((p) => MAIN_PLATFORMS.includes(p.key)).map((p) => {
                  const isSel = platforms.includes(p.key);
                  const color = platformColor(p.key);
                  return (
                    <div
                      key={p.key}
                      className={`ob-platform-chip ${isSel ? 'selected' : ''}`}
                      onClick={() => togglePlatform(p.key)}
                      style={{
                        borderColor: isSel ? color : undefined,
                        background: isSel ? `color-mix(in srgb, ${color} 10%, var(--surface))` : undefined,
                      }}
                    >
                      <div className="ob-platform-chip-main">
                        <span className="ob-platform-dot" style={{ background: color }} />
                        <span className="ob-platform-chip-name">{platformName(p.key, lang)}</span>
                      </div>
                      <div className="ob-platform-check" style={{ background: isSel ? color : undefined }}>
                        <Icon.check size={11} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 一句话介绍 */}
            <div className="ob-field-group">
              <div className="ob-field-label">
                <span>{en ? 'One-sentence identity' : '一句话介绍你的账号'}</span>
                <span className="ob-field-label-desc">{en ? 'Optional · Sets your writing tone' : '可选 · 决定生成草稿的叙事口吻'}</span>
              </div>
              <div className="ob-input-box">
                <span className="ob-input-icon"><Icon.pen size={17} /></span>
                <input
                  className="input"
                  value={sentence}
                  onChange={(e) => setSentence(e.target.value)}
                  maxLength={200}
                  placeholder={en ? 'e.g. I explain workplace methods in plain words' : '例如：把复杂的职场方法讲成人话，不做爹味说教'}
                />
                <span className="ob-input-counter">{sentence.length}/200</span>
              </div>
            </div>

            {/* 主页链接 */}
            <div className="ob-field-group">
              <div className="ob-field-label">
                <span>{en ? 'Your profile link' : '你的主页链接'}</span>
                <span className="ob-field-label-desc">{en ? 'Optional · Auto-fills account handle' : '可选 · 自动识别主页与历史指标'}</span>
              </div>
              <div className="ob-input-box">
                <span className="ob-input-icon"><Icon.link size={17} /></span>
                <input
                  className="input"
                  value={profileUrl}
                  onChange={(e) => setProfileUrl(e.target.value)}
                  placeholder="https://www.douyin.com/user/… 或 https://www.xiaohongshu.com/user/profile/…"
                />
              </div>

              {parsedProfile && (
                <div className="ob-recognized-badge">
                  <span className="ob-platform-dot" style={{ background: platformColor(parsedProfile.platform) }} />
                  <span>
                    {en
                      ? `Detected: ${platformName(parsedProfile.platform, lang)} profile (${parsedProfile.handle})`
                      : `已智能识别：${platformName(parsedProfile.platform, lang)} 主页（ID: ${parsedProfile.handle}）`}
                  </span>
                </div>
              )}

              <div className="ob-tip-card">
                <span className="ob-tip-icon"><Icon.info size={16} /></span>
                <div>
                  {en
                    ? 'X / TikTok profiles can be backfilled automatically; Douyin, Xiaohongshu and Bilibili will store your handle, and sync engagement numbers via Desktop Agent or browser extension.'
                    : 'X / TikTok 的主页能自动回填数据；抖音 / 小红书 / B 站会记下账号，互动数字要靠桌面客户端或浏览器插件采回。'}
                </div>
              </div>
            </div>

            {err && <div className="small" style={{ color: 'var(--red)', fontWeight: 600 }}>{err}</div>}

            {/* 操作栏 */}
            <div className="row-between wrap" style={{ marginTop: 8, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
              <div className="row" style={{ gap: 12 }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ minWidth: 160, height: 42, fontSize: 14 }}
                  disabled={pending}
                  onClick={submitProfile}
                >
                  {pending ? (
                    <span className="row" style={{ gap: 6 }}>
                      <Icon.refresh size={15} /> {en ? 'Saving…' : '正在写入底色…'}
                    </span>
                  ) : (
                    <span className="row" style={{ gap: 6 }}>
                      {en ? 'Next: Add Peers →' : '下一步：对标同行 →'}
                    </span>
                  )}
                </button>
              </div>
              <Link href="/persona" className="btn btn-ghost" style={{ fontSize: 13, color: 'var(--text-2)' }}>
                <Icon.sparkles size={15} /> {en ? 'Prefer the full AI persona interview' : '想走完整的 AI 追问建人设'}
              </Link>
            </div>
          </div>
        </Card>
      )}

      {/* ── Step 2: 同行 ── */}
      {step === 2 && (
        <Card
          title={
            <div className="row" style={{ gap: 8 }}>
              <span style={{ color: 'var(--brand)', display: 'flex' }}><Icon.users size={20} /></span>
              <span>{en ? 'Peers you learn from' : '你平时看的同行'}</span>
            </div>
          }
          sub={en ? 'Paste 1–3 profile links, or pick accounts already in the library.' : '贴 1–3 个主页链接；库里已有你赛道的账号就直接勾，快速对标爆款节奏'}
        >
          <div className="stack" style={{ gap: 20 }}>
            {profileNote && (
              <div className="ob-tip-card" style={{ borderColor: profileNote.ok ? 'rgba(22,163,74,0.3)' : 'rgba(202,138,4,0.3)' }}>
                <span className="ob-tip-icon" style={{ color: profileNote.ok ? 'var(--green)' : 'var(--amber)' }}>
                  {profileNote.ok ? <Icon.check size={16} /> : <Icon.info size={16} />}
                </span>
                <div>{profileNote.note}</div>
              </div>
            )}

            {/* 库内推荐同行 */}
            {suggests.length > 0 ? (
              <div className="ob-field-group">
                <div className="ob-field-label">
                  <span>{en ? `Library accounts matching “${niche}”` : `库里作品标题出现过「${niche}」的优质同行`}</span>
                  <span className="ob-field-label-desc">{en ? 'Click card to select / unselect' : '点击整张卡片即可勾选'}</span>
                </div>
                <div className="grid grid-2" style={{ gap: 8 }}>
                  {suggests.map((c) => {
                    const isPicked = picked.includes(c.id);
                    const color = platformColor(c.platform);
                    return (
                      <div
                        key={c.id}
                        className={`ob-peer-card ${isPicked ? 'selected' : ''}`}
                        onClick={() => setPicked((cur) => (cur.includes(c.id) ? cur.filter((x) => x !== c.id) : [...cur, c.id]))}
                      >
                        <div className="row" style={{ gap: 10 }}>
                          <div className="ob-peer-avatar" style={{ background: `linear-gradient(135deg, ${color}, #ff9a42)` }}>
                            {c.name.slice(0, 1)}
                          </div>
                          <div>
                            <b className="small" style={{ display: 'block', lineHeight: 1.3 }}>{c.name}</b>
                            <span className="small muted" style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
                              <span className="badge" style={{ padding: '1px 6px', fontSize: 10, background: 'var(--surface-2)', color }}>
                                {platformName(c.platform, lang)}
                              </span>
                              <span>{en ? `${c.posts} posts` : `${c.posts} 条作品`}</span>
                            </span>
                          </div>
                        </div>
                        <div className="ob-platform-check" style={{ background: isPicked ? 'var(--brand)' : undefined, color: isPicked ? '#fff' : 'transparent' }}>
                          <Icon.check size={11} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="ob-tip-card">
                <span className="ob-tip-icon"><Icon.info size={16} /></span>
                <div>{en ? 'Nobody in your niche is in the library yet — paste the accounts you actually read.' : '库里暂时还没有这个赛道的同行作品——直接在下方贴 1–3 个你常看的创作者链接即可。'}</div>
              </div>
            )}

            {/* 粘贴主页链接 */}
            <div className="ob-field-group">
              <div className="ob-field-label">
                <span>{en ? 'Custom profile links (one per line)' : '手动添加主页链接（一行一个）'}</span>
                <span className="ob-field-label-desc">{en ? 'Supports Xiaohongshu, Douyin, Bilibili, X, etc.' : '支持小红书、抖音、B站、X、YouTube 等'}</span>
              </div>
              <div className="ob-input-box">
                <span className="ob-input-icon" style={{ top: 12 }}><Icon.link size={17} /></span>
                <textarea
                  className="input"
                  rows={3}
                  value={urls}
                  onChange={(e) => setUrls(e.target.value)}
                  placeholder="https://www.xiaohongshu.com/user/profile/…&#10;https://www.douyin.com/user/…"
                />
              </div>
            </div>

            {err && <div className="small" style={{ color: 'var(--red)', fontWeight: 600 }}>{err}</div>}

            {/* 动作按钮 */}
            <div className="row-between wrap" style={{ marginTop: 8, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setStep(1)}
                disabled={pending}
                style={{ fontSize: 13 }}
              >
                ← {en ? 'Back to profile' : '返回修改赛道与平台'}
              </button>

              <div className="row wrap" style={{ gap: 10 }}>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={pending}
                  onClick={() => {
                    setUrls('');
                    setPicked([]);
                    submitCompetitors();
                  }}
                  style={{ color: 'var(--text-3)' }}
                >
                  {en ? 'Skip peers, just generate' : '先不订同行，直接开跑'}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ minWidth: 160, height: 42, fontSize: 14 }}
                  disabled={pending}
                  onClick={submitCompetitors}
                >
                  {pending ? (
                    <span className="row" style={{ gap: 6 }}>
                      <Icon.refresh size={15} /> {en ? 'Subscribing & Generating…' : '正在订阅并生成…'}
                    </span>
                  ) : (
                    <span className="row" style={{ gap: 6 }}>
                      {en ? 'Subscribe & Generate →' : '订阅并开跑推荐 →'}
                    </span>
                  )}
                </button>
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* ── Step 3: 开跑 ── */}
      {step === 3 && (
        <Card
          title={
            <div className="row" style={{ gap: 8 }}>
              <span style={{ color: 'var(--green)', display: 'flex' }}><Icon.fire size={20} /></span>
              <span>{en ? 'Ignite & Launch' : '全擎开跑 · 八源就绪雷达'}</span>
            </div>
          }
          sub={genMsg || (en ? 'Generating first recommendations…' : '正在采热榜、采同行、精排第一批高分选题…')}
        >
          <div className="stack" style={{ gap: 18 }}>
            {compNotes.length > 0 && (
              <div className="stack" style={{ gap: 6, padding: '10px 14px', background: 'var(--surface-2)', borderRadius: 8 }}>
                <b className="small">{en ? 'Subscription Receipts:' : '同行订阅回执：'}</b>
                {compNotes.map((n) => (
                  <div key={n.url} className="small" style={{ color: n.ok ? 'var(--text-2)' : 'var(--amber)', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span>{n.ok ? '✓' : '⚠'}</span>
                    <span style={{ wordBreak: 'break-all' }}>{n.url} — {n.note}</span>
                  </div>
                ))}
              </div>
            )}

            {!readiness ? (
              <div className="stack" style={{ gap: 12, padding: '28px 0', alignItems: 'center', textAlign: 'center' }}>
                <span className="ob-pulse-dot" style={{ width: 14, height: 14 }} />
                <div style={{ fontWeight: 650, fontSize: 15 }}>
                  {en ? 'Engines running… fetching hotlists, peers, and ranking.' : '正在全网并发采集……（全网热榜、同行监控、爆款精排）'}
                </div>
                <div className="small muted">
                  {en ? 'This typically takes 20 to 40 seconds.' : '首次建立作战室通常需要 20 到 40 秒，请稍候。'}
                </div>
              </div>
            ) : (
              <>
                {/* 就绪度统计头 */}
                <div className="row-between wrap" style={{ padding: '14px 18px', background: 'var(--brand-soft)', borderRadius: 10, border: '1px solid var(--brand)' }}>
                  <div className="row" style={{ gap: 10 }}>
                    <span className="ob-pulse-dot" />
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)' }}>
                        {en
                          ? `${readiness.active} of ${readiness.total} Sources Active`
                          : `八大候选源里已点亮 ${readiness.active} / ${readiness.total}`}
                      </div>
                      <div className="small muted" style={{ marginTop: 2 }}>
                        {readiness.active >= 5
                          ? (en ? 'High readiness: strong cross-platform topic supply.' : '作战状态良好：已具备充裕的跨平台选题弹药库')
                          : (en ? 'Basic readiness: active sources are supplying daily picks.' : '基础就绪：已激活的数据源将持续推送今日爆款')}
                      </div>
                    </div>
                  </div>
                  <div className="badge badge-green" style={{ fontSize: 12, padding: '5px 10px' }}>
                    {Math.round((readiness.active / readiness.total) * 100)}% {en ? 'Ready' : '就绪'}
                  </div>
                </div>

                {/* 8 源网格 */}
                <div className="ob-source-grid">
                  {readiness.sources.map((src) => {
                    const isActive = src.state === 'active';
                    return (
                      <div key={src.key} className={`ob-source-card ${isActive ? 'active' : 'dormant'}`}>
                        <div className="row-between" style={{ marginBottom: 6 }}>
                          <b className="small" style={{ fontSize: 13, color: 'var(--text)' }}>{src.name}</b>
                          <span className={`badge ${isActive ? 'badge-green' : 'badge-gray'}`} style={{ fontSize: 10, padding: '2px 8px' }}>
                            {isActive ? (en ? 'Active' : '已点亮') : (en ? 'Silent' : '待解锁')}
                          </span>
                        </div>
                        <div className="small muted" style={{ lineHeight: 1.5, minHeight: 38 }}>
                          {src.reason}
                        </div>
                        {src.state === 'dormant' && src.action && (
                          <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px dashed var(--border)' }}>
                            <Link href={src.action.href} className="small" style={{ color: 'var(--brand)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                              {src.action.text} →
                            </Link>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* 启动主行动 */}
                <div className="row wrap" style={{ gap: 12, marginTop: 12, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
                  <Link href="/topics" className="btn btn-primary" style={{ flex: 1, minWidth: 200, height: 44, fontSize: 14 }}>
                    <Icon.fire size={17} /> {en ? 'Today’s Hot Topics: Start Drafting →' : '今天这条推荐，立即起稿 →'}
                  </Link>
                  <Link href="/" className="btn btn-ghost" style={{ height: 44, fontSize: 13 }}>
                    {en ? 'Go to Mission Control' : '回作战室首页'}
                  </Link>
                </div>
              </>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

