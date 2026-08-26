'use client';

import { useState, useTransition } from 'react';
import { PLATFORM_LIST } from '@/lib/constants';
import { actSubmitDataRemoval } from './actions';

type Kind = 'account' | 'comment';

export function DataRequestForm() {
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

  function submit() {
    setError('');
    start(async () => {
      const r = await actSubmitDataRemoval({ platform, handle, contact, reason, kind, commentText });
      if (r.ok) setDone(true);
      else setError(r.error ?? '提交失败，请稍后再试');
    });
  }

  if (done) {
    return (
      <div className="card" style={{ padding: 20, background: 'var(--surface-2)', boxShadow: 'none', textAlign: 'center' }}>
        <div style={{ fontSize: 32, marginBottom: 8 }}>✅</div>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>申请已收到</div>
        <div className="small muted" style={{ lineHeight: 1.7 }}>
          我们将在 15 个工作日内核实并处理，处理结果会通过你留下的联系方式回复。
          {isComment
            ? '核实后我们会删除你指明的那条评论正文；这条申请不影响对该作品作者的其他处理。'
            : '核实期间会暂停对该账号的新增采集。'}
        </div>
      </div>
    );
  }

  return (
    <div className="card" style={{ padding: 20, background: 'var(--surface-2)', boxShadow: 'none' }}>
      <div className="stack" style={{ gap: 14 }}>
        <div className="field">
          <label className="field-label">你是以什么身份提出 <span style={{ color: 'var(--red)' }}>*</span></label>
          <select
            className="input"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as Kind);
              setError('');
            }}
          >
            <option value="account">我是被监控账号的权利人（停止采集并删除该账号的全部数据）</option>
            <option value="comment">我在别人的作品下留过言，要求删除我自己的那条评论</option>
          </select>
          <div className="small muted" style={{ marginTop: 6, lineHeight: 1.7 }}>
            {isComment
              ? '只删你指明的那一条评论正文。不会影响作品作者，也不会停止对该作者的采集——那是另一个人的事，不能由你的申请决定。'
              : '核实后会停止全平台对该账号的采集，并删除已收集的档案、作品数据、订阅关系与其作品评论区留存的内容。'}
          </div>
        </div>
        <div className="field">
          <label className="field-label">所在平台 <span style={{ color: 'var(--red)' }}>*</span></label>
          <select className="input" value={platform} onChange={(e) => setPlatform(e.target.value)}>
            <option value="">请选择…</option>
            {PLATFORM_LIST.map((p) => (
              <option key={p.key} value={p.key}>{p.name}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field-label">
            {isComment ? '评论所在的作品链接' : '被监控账号主页链接 / 标识'}{' '}
            <span style={{ color: 'var(--red)' }}>*</span>
          </label>
          <input
            className="input"
            placeholder={isComment ? '你留言的那条视频 / 笔记 / 文章的链接' : '如账号主页 URL 或用户名，便于我们定位'}
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            maxLength={200}
          />
        </div>
        {isComment && (
          <div className="field">
            <label className="field-label">你那条评论的原文 <span style={{ color: 'var(--red)' }}>*</span></label>
            <textarea
              className="textarea"
              rows={3}
              placeholder="照抄你写的那句话，我们靠它精确定位要删的那一条（最多 300 字）"
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              maxLength={300}
            />
            <div className="small muted" style={{ marginTop: 6 }}>
              我们不保存评论者的昵称、头像、用户 ID 等任何身份信息，因此无法按「谁写的」检索——
              只能按这句话的原文来找。请尽量与原文一致。
            </div>
          </div>
        )}
        <div className="field">
          <label className="field-label">你的联系方式 <span style={{ color: 'var(--red)' }}>*</span></label>
          <input
            className="input"
            placeholder="邮箱或手机号，用于回复处理结果"
            value={contact}
            onChange={(e) => setContact(e.target.value)}
            maxLength={100}
          />
        </div>
        <div className="field">
          <label className="field-label">补充说明（选填）</label>
          <textarea
            className="textarea"
            rows={3}
            placeholder="如你与该账号的关系、移除诉求等"
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
              !platform ||
              !handle.trim() ||
              !contact.trim() ||
              (isComment && commentText.trim().length < 5)
            }
          >
            {pending ? '提交中…' : isComment ? '提交评论删除申请' : '提交移除申请'}
          </button>
          {error && <span className="small" style={{ color: 'var(--red)' }}>{error}</span>}
        </div>
      </div>
    </div>
  );
}
