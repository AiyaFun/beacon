'use client';

import { useState, useTransition } from 'react';
import { PLATFORM_LIST, platformName } from '@/lib/constants';
import { actSubmitDataRemoval } from './actions';
import { useI18n } from '@/lib/i18n';

type Kind = 'account' | 'comment' | 'site';

export function DataRequestForm() {
  const { lang } = useI18n();
  const isEn = lang === 'en';
  const [kind, setKind] = useState<Kind>('account');
  const [platform, setPlatform] = useState('');
  const [handle, setHandle] = useState('');
  const [commentText, setCommentText] = useState('');
  const [contact, setContact] = useState('');
  const [reason, setReason] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  const isComment = kind === 'comment';
  // 站点类的主体是一个域名，不是平台上的账号——所以它不选平台
  const isSite = kind === 'site';

  function submit() {
    setError('');
    start(async () => {
      const r = await actSubmitDataRemoval({ platform, handle, contact, reason, kind, commentText });
      if (r.ok) setDone(true);
      else setError(r.error ?? (isEn ? 'Submission failed, please try again later' : '提交失败，请稍后再试'));
    });
  }

  if (done) {
    return (
      <div className="card" style={{ padding: 20, background: 'var(--surface-2)', boxShadow: 'none', textAlign: 'center' }}>
        <div style={{ fontSize: 32, marginBottom: 8 }}>✅</div>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>{isEn ? 'Request Received' : '申请已收到'}</div>
        <div className="small muted" style={{ lineHeight: 1.7 }}>
          {isEn ? (
            <>
              We will verify and process your request within 15 business days. Results will be communicated to your provided contact.
              {isComment
                ? ' Upon verification, we will delete the specific comment text you indicated; this request does not affect other processing for the creator.'
                : isSite
                  ? ' Upon verification, we will stop crawling this domain and delete data extracted from it.'
                  : ' During verification, new data collection for this account will be suspended.'}
            </>
          ) : (
            <>
              我们将在 15 个工作日内核实并处理，处理结果会通过你留下的联系方式回复。
              {isComment
                ? '核实后我们会删除你指明的那条评论正文；这条申请不影响对该作品作者的其他处理。'
                : '核实期间会暂停对该账号的新增采集。'}
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="card" style={{ padding: 20, background: 'var(--surface-2)', boxShadow: 'none' }}>
      <div className="stack" style={{ gap: 14 }}>
        <div className="field">
          <label className="field-label">
            {isEn ? 'Requesting as' : '你是以什么身份提出'} <span style={{ color: 'var(--red)' }}>*</span>
          </label>
          <select
            className="input"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as Kind);
              setError('');
            }}
          >
            <option value="account">
              {isEn
                ? 'I am the owner of a monitored account (stop collecting and delete all account data)'
                : '我是被监控账号的权利人（停止采集并删除该账号的全部数据）'}
            </option>
            <option value="comment">
              {isEn
                ? 'I commented on someone else’s post and want my comment removed'
                : '我在别人的作品下留过言，要求删除我自己的那条评论'}
            </option>
            <option value="site">
              {isEn
                ? 'I am a website owner requesting you stop crawling my site'
                : '我是某个网站的权利人，要求不要再抓取我的站'}
            </option>
          </select>
          <div className="small muted" style={{ marginTop: 6, lineHeight: 1.7 }}>
            {isEn ? (
              isComment
                ? 'Deletes only the specific comment text you indicate. Will not affect the post author or stop monitoring that creator.'
                : isSite
                  ? 'Upon verification, stops crawling this domain (including subdomains) and deletes data collected from it. User recipes targeting this domain will be deactivated.'
                  : 'Upon verification, stops monitoring this account across all platforms and deletes collected profiles, posts, subscription relations, and cached comments.'
            ) : (
              isComment
                ? '只删你指明的那一条评论正文。不会影响作品作者，也不会停止对该作者的采集——那是另一个人的事，不能由你的申请决定。'
                : isSite
                  ? '核实后会停止抓取这个域名（含它的子域），并删除已经从它页面上取到的数据。'
                    + '用户为它建的采集配方会被停用而不是删除——那是用户自己写的东西，停掉就已经不再采你了。'
                  : '核实后会停止全平台对该账号的采集，并删除已收集的档案、作品数据、订阅关系与其作品评论区留存的内容。'
            )}
          </div>
        </div>
        {/* 站点类不选平台：它的主体是域名。硬要选一个的话，那个值会进库、进去重键、
            进执行分叉，是纯粹的噪音 */}
        {!isSite && (
        <div className="field">
          <label className="field-label">{isEn ? 'Platform' : '所在平台'} <span style={{ color: 'var(--red)' }}>*</span></label>
          <select className="input" value={platform} onChange={(e) => setPlatform(e.target.value)}>
            <option value="">{isEn ? 'Please select…' : '请选择…'}</option>
            {PLATFORM_LIST.map((p) => (
              <option key={p.key} value={p.key}>{platformName(p.key, lang)}</option>
            ))}
          </select>
        </div>
        )}
        <div className="field">
          <label className="field-label">
            {isEn
              ? (isComment ? 'Link to Post Containing Comment' : isSite ? 'Your Website Domain' : 'Monitored Account Link / Handle')
              : (isComment ? '评论所在的作品链接' : isSite ? '你的网站域名' : '被监控账号主页链接 / 标识')}{' '}
            <span style={{ color: 'var(--red)' }}>*</span>
          </label>
          <input
            className="input"
            placeholder={isEn
              ? (isComment ? 'URL of the video, note, or article where you commented'
                : isSite ? 'e.g. example.com (main domain, subdomains will be included)'
                  : 'e.g. Profile URL or username to help us locate it')
              : (isComment ? '你留言的那条视频 / 笔记 / 文章的链接'
                : isSite ? '如 example.com（写主域名即可，子域一并停止）'
                  : '如账号主页 URL 或用户名，便于我们定位')}
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            maxLength={200}
          />
        </div>
        {isComment && (
          <div className="field">
            <label className="field-label">{isEn ? 'Original Comment Text' : '你那条评论的原文'} <span style={{ color: 'var(--red)' }}>*</span></label>
            <textarea
              className="textarea"
              rows={3}
              placeholder={isEn ? 'Quote the exact words you wrote to help us pinpoint it (max 300 chars)' : '照抄你写的那句话，我们靠它精确定位要删的那一条（最多 300 字）'}
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              maxLength={300}
            />
            <div className="small muted" style={{ marginTop: 6 }}>
              {isEn
                ? 'We do not store commenter nicknames, avatars, or user IDs, so we cannot search by user—we match by exact text. Please match the original as closely as possible.'
                : '我们不保存评论者的昵称、头像、用户 ID 等任何身份信息，因此无法按「谁写的」检索——只能按这句话的原文来找。请尽量与原文一致。'}
            </div>
          </div>
        )}
        <div className="field">
          <label className="field-label">{isEn ? 'Your Contact Info' : '你的联系方式'} <span style={{ color: 'var(--red)' }}>*</span></label>
          <input
            className="input"
            placeholder={isEn ? 'Email or phone number for response' : '邮箱或手机号，用于回复处理结果'}
            value={contact}
            onChange={(e) => setContact(e.target.value)}
            maxLength={100}
          />
        </div>
        <div className="field">
          <label className="field-label">{isEn ? 'Additional Explanation (Optional)' : '补充说明（选填）'}</label>
          <textarea
            className="textarea"
            rows={3}
            placeholder={isEn ? 'e.g. Your relationship to the account or specific removal requests' : '如你与该账号的关系、移除诉求等'}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={1000}
          />
        </div>
        <div className="row" style={{ gap: 12, alignItems: 'center' }}>
          <button
            className="btn btn-primary"
            onClick={submit}
            disabled={
              pending ||
              (!isSite && !platform) ||
              !handle.trim() ||
              !contact.trim() ||
              (isComment && commentText.trim().length < 5)
            }
          >
            {pending
              ? (isEn ? 'Submitting…' : '提交中…')
              : isComment
                ? (isEn ? 'Submit Comment Deletion Request' : '提交评论删除申请')
                : (isEn ? 'Submit Removal Request' : '提交移除申请')}
          </button>
          {error && <span className="small" style={{ color: 'var(--red)' }}>{error}</span>}
        </div>
      </div>
    </div>
  );
}

