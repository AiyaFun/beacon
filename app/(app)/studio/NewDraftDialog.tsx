'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Overlay } from '@/components/Overlay';
import { PLATFORM_LIST } from '@/lib/constants';
import { Icon } from '@/components/icons';
import { actCreateDraft, type CreateDraftMode } from './actions';

// 自由起稿入口：选题之外的另外两条路。
//
// 【为什么它值一个显眼的入口】此前建草稿只有一条路——先去选题中心采纳一个选题。
// 而创作者最高频的两件事是「我今天就想写这个」和「我已经写了一版，帮我打磨」，
// 这两件事以前只能在改写框里做完再复制走人：不留版本、不学偏好、不进发布登记、数据回不来。
//
// 顺带一提，「粘一段我写的」这条路还是**风格样本**最自然的来源：
// 用户粘进来的第一版被记成 human，之后所有生成都能照着他自己的语感写（见 loadExemplars）。

const MODES: { key: CreateDraftMode; name: string; hint: string; placeholder: string }[] = [
  {
    key: 'paste',
    name: '粘一段我写的',
    hint: '存成你的人工原稿，之后 AI 都会照着你这个语感写',
    placeholder: '把你已经写好的正文粘进来…',
  },
  {
    key: 'idea',
    name: '一句话想法',
    hint: '按你的人设、素材和文风展开成一版初稿（会消耗一次 AI 额度）',
    placeholder: '比如：想聊聊为什么我把三年的老客户全砍了，只留五个',
  },
  { key: 'blank', name: '空白稿', hint: '先建个壳，自己往里写', placeholder: '' },
];

export function NewDraftDialog({ defaultPlatform }: { defaultPlatform?: string }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<CreateDraftMode>('paste');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [platform, setPlatform] = useState(
    defaultPlatform && PLATFORM_LIST.some((p) => p.key === defaultPlatform) ? defaultPlatform : (PLATFORM_LIST[0].key as string),
  );
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [deep, setDeep] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();

  const cur = MODES.find((m) => m.key === mode)!;

  function submit() {
    setErr('');
    setNote('');
    start(async () => {
      const r = await actCreateDraft({ mode, title, platform, text, deep: mode === 'idea' ? deep : undefined });
      if (!r.ok) {
        setErr(r.error ?? '创建失败');
        return;
      }
      // 生成初稿失败但壳建成了：如实提示，不假装成功也不把草稿吞掉
      if (r.error) setNote(r.error);
      else if (r.warning) setNote(r.warning);
      setOpen(false);
      setText('');
      setTitle('');
      router.push(`/studio?draft=${r.draftId}`);
      router.refresh();
    });
  }

  if (!open) {
    return (
      <button className="btn btn-sm" onClick={() => setOpen(true)} title="不从选题开始，直接写">
        <Icon.plus size={14} /> 新建草稿
      </button>
    );
  }

  // 弹层而不是就地展开：这个入口挂在页头动作栏里，就地展开会在标题旁边长出一块
  // 320~460px 宽的表单，把整行按钮挤到下一行、页头高度翻倍。表单归表单，按钮归按钮。
  return (
    <Overlay label="新建草稿" onClose={() => setOpen(false)} closable={!pending}>
      <div
        className="card"
        style={{ padding: 20, background: 'var(--surface)', width: 460, maxWidth: '92vw', maxHeight: '88vh', overflowY: 'auto' }}
      >
      <div className="row-between" style={{ marginBottom: 10 }}>
        <b className="small">新建草稿</b>
        <button className="btn btn-sm btn-ghost" onClick={() => setOpen(false)}>关闭</button>
      </div>

      <div className="row wrap" style={{ gap: 6, marginBottom: 8 }}>
        {MODES.map((m) => (
          <button
            key={m.key}
            className={`btn btn-sm ${mode === m.key ? 'btn-accent' : 'btn-ghost'}`}
            onClick={() => setMode(m.key)}
          >
            {m.name}
          </button>
        ))}
      </div>
      <div className="small muted" style={{ marginBottom: 10, lineHeight: 1.6 }}>{cur.hint}</div>

      <div className="stack" style={{ gap: 8 }}>
        <input
          className="input"
          placeholder="标题（可留空，会自动取正文首行）"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={60}
        />
        <select className="select" value={platform} onChange={(e) => setPlatform(e.target.value)}>
          {PLATFORM_LIST.map((p) => (
            <option key={p.key} value={p.key}>目标平台 · {p.name}</option>
          ))}
        </select>
        {mode !== 'blank' && (
          <textarea
            className="textarea"
            rows={mode === 'idea' ? 3 : 8}
            placeholder={cur.placeholder}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        )}
        {mode === 'idea' && (
          <label
            className="row small muted"
            style={{ gap: 6, alignItems: 'center', cursor: 'pointer' }}
            title="两段式生成：先只想清楚说什么，再照着你自己的原句样本写成稿。去 AI 味效果最好，代价是两次调用。"
          >
            <input type="checkbox" checked={deep} onChange={(e) => setDeep(e.target.checked)} disabled={pending} />
            深度模式：先列要点大纲，再按你的语感写成稿（更像你写的，消耗 2 次 AI 额度）
          </label>
        )}
        {err && <div className="small" style={{ color: 'var(--red)' }}>{err}</div>}
        {note && <div className="small muted">ℹ️ {note}</div>}
        <div className="row" style={{ gap: 8 }}>
          <button className="btn btn-sm btn-primary" onClick={submit} disabled={pending}>
            {pending ? (mode === 'idea' ? '生成中…' : '创建中…') : '创建'}
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => setOpen(false)} disabled={pending}>取消</button>
        </div>
      </div>
      </div>
    </Overlay>
  );
}
