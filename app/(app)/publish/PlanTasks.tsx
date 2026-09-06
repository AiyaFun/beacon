'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { platformName } from '@/lib/constants';
import { PUBLISH_CAPS, capOf, channelLabel, TASK_STATUS_LABEL, TASK_STATUS_LABEL_EN } from '@/lib/publish/capability';
import { AIGC_LABEL } from '@/lib/compliance/aigc';
import { actCreatePublishPlan, actReadPublishPlan, actRunApiPublish, actMarkPublishTask } from './actions';
import { useI18n } from '@/lib/i18n';

// 发布计划的两块界面：**选平台建计划** 与 **逐条任务往下走**。

export type TaskView = {
  id: string;
  platform: string;
  platformLabel: string;
  channel: string;
  status: string;
  title: string;
  content: string;
  extra: { usedBaseDraft?: boolean; submitToPublish?: boolean };
  error: string | null;
  publishedUrl: string | null;
  requires: string;
  why: string;
  calibrated: boolean;
};

export type PlanView = { id: string; draftId: string; status: string; tasks: TaskView[] };

export const ALL_PLATFORMS = Object.keys(PUBLISH_CAPS);

/** 三条通道各自意味着什么。两个入口都在用，改口径只改这一处。 */
export const CHANNEL_INTRO =
  '公众号与微博走官方接口：公众号写进草稿箱（可撤可改），微博是直接公开发出去；抖音/小红书/B站/视频号/知乎/头条号/百家号/快手由采集助手把内容填进你自己的创作后台，发布按钮默认由你来点（插件设置里可显式打开「代点发布」，风险自负）；X/YouTube/TikTok 只能复制内容手动发。';

export const CHANNEL_INTRO_EN =
  'WeChat Official Accounts and Weibo use official APIs: WeChat saves to draft box (editable/retractable), Weibo posts publicly directly; Douyin, Xiaohongshu, Bilibili, Channels, Zhihu, Toutiao, Baijiahao, and Kuaishou use the browser extension to populate your creator studio, leaving the publish button for you by default; X, YouTube, and TikTok require manual copying.';

/** 选平台 + 勾 AI 声明 + 建计划。建好后把计划交给调用方（它决定显示在抽屉里还是页面上）。 */
export function PlanCreator({
  draftId,
  onCreated,
  compact,
}: {
  draftId: string;
  onCreated: (plan: PlanView) => void;
  compact?: boolean;
}) {
  const router = useRouter();
  const { lang } = useI18n();
  const isEn = lang === 'en';
  const [pending, start] = useTransition();
  const [picked, setPicked] = useState<string[]>([]);
  const [aigc, setAigc] = useState(false);
  const [err, setErr] = useState('');

  function create() {
    setErr('');
    start(async () => {
      const r = await actCreatePublishPlan({ draftId, platforms: picked, aigcConfirmed: aigc });
      if (!r.ok || !r.planId) {
        setErr(r.error ?? (isEn ? 'Failed to create plan' : '创建失败'));
        return;
      }
      const read = await actReadPublishPlan(r.planId);
      if (read.ok) onCreated(read.plan as PlanView);
      router.refresh();
    });
  }

  return (
    <>
      <div className="row wrap" style={{ gap: 8, margin: compact ? '10px 0' : '14px 0' }}>
        {ALL_PLATFORMS.map((p) => {
          const on = picked.includes(p);
          const cap = capOf(p);
          return (
            <button
              key={p}
              className={`btn btn-sm ${on ? 'btn-primary' : ''}`}
              title={cap.why}
              onClick={() => setPicked(on ? picked.filter((x) => x !== p) : [...picked, p])}
            >
              {platformName(p, lang) || p}
              <span className="small" style={{ opacity: 0.75, marginLeft: 6 }}>
                {channelLabel(cap.channel, lang)}
              </span>
            </button>
          );
        })}
      </div>

      <label className="small" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
        <input type="checkbox" checked={aigc} onChange={(e) => setAigc(e.target.checked)} />
        <span>{AIGC_LABEL}</span>
      </label>

      <div className="row" style={{ gap: 8, marginTop: 14 }}>
        <button className="btn btn-primary" disabled={pending || !aigc || picked.length === 0} onClick={create}>
          {isEn ? 'Generate Publishing Plan' : '生成发布计划'}
        </button>
        {picked.length === 0 && <span className="small muted">{isEn ? 'Select at least one platform' : '先选至少一个平台'}</span>}
      </div>
      {err && (
        <div className="small" style={{ marginTop: 10, color: 'var(--red)' }}>
          {err}
        </div>
      )}
    </>
  );
}

/** 一份计划里的任务清单。每条任务自己走自己的通道，互不牵连。 */
export function PlanTasks({ plan, onChanged }: { plan: PlanView; onChanged: (plan: PlanView) => void }) {
  const router = useRouter();
  const { lang } = useI18n();
  const isEn = lang === 'en';
  const [pending, start] = useTransition();
  const [submitWx, setSubmitWx] = useState(false);
  const [urlDraft, setUrlDraft] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  function refresh() {
    start(async () => {
      const r = await actReadPublishPlan(plan.id);
      if (r.ok) onChanged(r.plan as PlanView);
    });
  }

  function runApi(task: TaskView) {
    setErr('');
    setMsg('');
    start(async () => {
      const r = await actRunApiPublish(task.id, { submitToPublish: submitWx });
      if (!r.ok) setErr(r.error ?? (isEn ? 'Publish failed' : '发布失败'));
      else setMsg(r.note ?? (isEn ? 'Submitted' : '已提交'));
      const read = await actReadPublishPlan(plan.id);
      if (read.ok) onChanged(read.plan as PlanView);
    });
  }

  function mark(task: TaskView, status: 'published' | 'skipped') {
    setErr('');
    setMsg('');
    start(async () => {
      const r = await actMarkPublishTask(task.id, status, urlDraft[task.id]);
      if (!r.ok) setErr(r.error ?? (isEn ? 'Action failed' : '操作失败'));
      else setMsg(r.warning ? (isEn ? `Recorded, but: ${r.warning}` : `已记录，但${r.warning}`) : (isEn ? 'Recorded' : '已记录'));
      const read = await actReadPublishPlan(plan.id);
      if (read.ok) onChanged(read.plan as PlanView);
      router.refresh();
    });
  }

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {plan.tasks.map((t) => (
        <div key={t.id} className="card" style={{ padding: 14 }}>
          <div className="row-between" style={{ flexWrap: 'wrap', gap: 8 }}>
            <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <strong>{platformName(t.platform, lang) || t.platformLabel}</strong>
              <span className="badge badge-gray">{channelLabel(t.channel, lang)}</span>
              <span
                className={`badge ${
                  t.status === 'published' ? 'badge-green' : t.status === 'failed' ? 'badge-red' : 'badge-amber'
                }`}
              >
                {isEn ? (TASK_STATUS_LABEL_EN[t.status] ?? t.status) : (TASK_STATUS_LABEL[t.status] ?? t.status)}
              </span>
              {t.extra.usedBaseDraft && <span className="badge badge-gray">{isEn ? 'Base Draft Used' : '用的是原稿（没派生该平台版本）'}</span>}
              {t.channel === 'extension' && !t.calibrated && (
                <span
                  className="badge badge-amber"
                  title={isEn ? 'Selector not calibrated on real devices, copy manually if autofill fails' : '选择器尚未在真机上校准，可能填不进去；填不进去时请手动复制'}
                >
                  {isEn ? 'Script Uncalibrated' : '填充脚本未真机校准'}
                </span>
              )}
            </span>
            <span className="row" style={{ gap: 6 }}>
              <button
                className="btn btn-sm"
                onClick={() => navigator.clipboard?.writeText(`${t.title}\n\n${t.content}`)}
                title={isEn ? 'Copy title and body' : '复制标题与正文'}
              >
                {isEn ? 'Copy' : '复制内容'}
              </button>
              {t.channel === 'api' && t.status !== 'published' && (
                <button className="btn btn-sm btn-primary" disabled={pending} onClick={() => runApi(t)}>
                  {t.platform === 'weibo' ? (isEn ? 'Publish to Weibo' : '直接发到微博') : (isEn ? 'Save to WeChat Drafts' : '写进公众号草稿箱')}
                </button>
              )}
              <button className="btn btn-sm btn-ghost" disabled={pending} onClick={() => mark(t, 'skipped')}>
                {isEn ? 'Skip' : '跳过'}
              </button>
            </span>
          </div>

          {t.channel === 'api' && t.platform === 'wechat' && t.status !== 'published' && (
            <label className="small" style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 8 }}>
              <input type="checkbox" checked={submitWx} onChange={(e) => setSubmitWx(e.target.checked)} />
              {isEn ? 'Also submit for broadcast (irreversible, only 1/day for subscriptions)' : '同时提交群发（不可撤销，订阅号每天仅一次机会）'}
            </label>
          )}
          {t.channel === 'api' && t.platform === 'weibo' && t.status !== 'published' && (
            <div className="small" style={{ marginTop: 8, color: 'var(--amber, #b45309)' }}>
              {isEn ? (
                <>
                  ⚠️ Weibo posts are <b>published directly to public</b> with no draft stage. Text is formatted per Weibo rules: ≤140 chars, single image, with required backlink.
                </>
              ) : (
                <>
                  ⚠️ 微博这条是<b>直接公开发布</b>，没有草稿箱这一档。正文会按微博的规则整形：≤140 字、单张配图、
                  末尾带上你在「接入与密钥」里填的回链（回链是微博强制要求的，不是我们加的）。
                </>
              )}
            </div>
          )}

          <div className="small muted" style={{ marginTop: 6 }}>
            {t.why}
          </div>
          {t.requires && <div className="small muted">{isEn ? `Required: ${t.requires}` : `需要：${t.requires}`}</div>}
          {t.error && (
            <div className="small" style={{ color: 'var(--red)', marginTop: 6 }}>
              {t.error}
            </div>
          )}

          {t.status !== 'published' && (
            <div className="row" style={{ gap: 6, marginTop: 8 }}>
              <input
                className="input"
                placeholder={isEn ? 'Paste post URL here after publishing to sync performance analytics' : '发布后把作品链接贴这里，数据才能自动回流'}
                value={urlDraft[t.id] ?? ''}
                onChange={(e) => setUrlDraft({ ...urlDraft, [t.id]: e.target.value })}
                style={{ flex: 1, fontSize: 12.5 }}
              />
              <button className="btn btn-sm" disabled={pending} onClick={() => mark(t, 'published')}>
                {isEn ? 'Mark Published' : '标记已发布'}
              </button>
            </div>
          )}
          {t.publishedUrl && (
            <div className="small" style={{ marginTop: 6 }}>
              <a href={t.publishedUrl} target="_blank" rel="noreferrer">
                {t.publishedUrl}
              </a>
            </div>
          )}
        </div>
      ))}

      <div className="row" style={{ gap: 8 }}>
        <button className="btn btn-sm" disabled={pending} onClick={refresh}>
          {isEn ? 'Refresh Status' : '刷新状态'}
        </button>
        {(msg || err) && (
          <span className="small" style={{ color: err ? 'var(--red)' : 'var(--green)' }}>
            {err || msg}
          </span>
        )}
      </div>
    </div>
  );
}
