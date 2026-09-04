'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Overlay } from '@/components/Overlay';
import { PLATFORM_LIST } from '@/lib/constants';
import { Icon } from '@/components/icons';
import { actCreateDraft, type CreateDraftMode } from './actions';
import { useI18n } from '@/lib/i18n';

// 自由起稿入口：选题之外的另外两条路。
//
// 【为什么它值一个显眼的入口】此前建草稿只有一条路——先去选题中心采纳一个选题。
// 而创作者最高频的两件事是「我今天就想写这个」和「我已经写了一版，帮我打磨」，
// 这两件事以前只能在改写框里做完再复制走人：不留版本、不学偏好、不进发布登记、数据回不来。
//
// 顺带一提，「粘一段我写的」这条路还是**风格样本**最自然的来源：
// 用户粘进来的第一版被记成 human，之后所有生成都能照着他自己的语感写（见 loadExemplars）。

export function NewDraftDialog({ defaultPlatform }: { defaultPlatform?: string }) {
  const { lang } = useI18n();
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

  const modes = [
    {
      key: 'paste' as CreateDraftMode,
      name: lang === 'en' ? 'Paste Draft' : '粘一段我写的',
      hint: lang === 'en' ? 'Save as human draft. AI will emulate this voice in future generation.' : '存成你的人工原稿，之后 AI 都会照着你这个语感写',
      placeholder: lang === 'en' ? 'Paste your written content here…' : '把你已经写好的正文粘进来…',
    },
    {
      key: 'idea' as CreateDraftMode,
      name: lang === 'en' ? 'One-line Idea' : '一句话想法',
      hint: lang === 'en' ? 'Expand into a draft using your persona and style (consumes AI quota).' : '按你的人设、素材和文风展开成一版初稿（会消耗一次 AI 额度）',
      placeholder: lang === 'en' ? 'e.g. Discuss why cutting 80% of legacy clients increased our profits' : '比如：想聊聊为什么我把三年的老客户全砍了，只留五个',
    },
    {
      key: 'blank' as CreateDraftMode,
      name: lang === 'en' ? 'Blank Draft' : '空白稿',
      hint: lang === 'en' ? 'Start with a blank canvas and write freely.' : '先建个壳，自己往里写',
      placeholder: '',
    },
  ];

  const cur = modes.find((m) => m.key === mode)!;

  function submit() {
    setErr('');
    setNote('');
    start(async () => {
      const r = await actCreateDraft({ mode, title, platform, text, deep: mode === 'idea' ? deep : undefined });
      if (!r.ok) {
        setErr(r.error ?? (lang === 'en' ? 'Failed to create' : '创建失败'));
        return;
      }
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
      <button className="btn btn-sm" onClick={() => setOpen(true)} title={lang === 'en' ? 'Write freely without selecting a topic' : '不从选题开始，直接写'}>
        <Icon.plus size={14} /> {lang === 'en' ? 'New Draft' : '新建草稿'}
      </button>
    );
  }

  return (
    <Overlay label={lang === 'en' ? 'New Draft' : '新建草稿'} onClose={() => setOpen(false)} closable={!pending}>
      <div
        className="card"
        style={{ padding: 20, background: 'var(--surface)', width: 460, maxWidth: '92vw', maxHeight: '88vh', overflowY: 'auto' }}
      >
        <div className="row-between" style={{ marginBottom: 10 }}>
          <b className="small">{lang === 'en' ? 'New Draft' : '新建草稿'}</b>
          <button className="btn btn-sm btn-ghost" onClick={() => setOpen(false)}>{lang === 'en' ? 'Close' : '关闭'}</button>
        </div>

        <div className="row wrap" style={{ gap: 6, marginBottom: 8 }}>
          {modes.map((m) => (
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
            placeholder={lang === 'en' ? 'Title (optional, auto-extracts from first line)' : '标题（可留空，会自动取正文首行）'}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={60}
          />
          <select className="select" value={platform} onChange={(e) => setPlatform(e.target.value)}>
            {PLATFORM_LIST.map((p) => (
              <option key={p.key} value={p.key}>{lang === 'en' ? `Platform · ${p.name}` : `目标平台 · ${p.name}`}</option>
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
            >
              <input type="checkbox" checked={deep} onChange={(e) => setDeep(e.target.checked)} disabled={pending} />
              {lang === 'en'
                ? 'Deep mode: outline first, then flesh out draft with your authentic voice'
                : '深度模式：先列要点大纲，再按你的语感写成稿（更像你写的，消耗 2 次 AI 额度）'}
            </label>
          )}
          {err && <div className="small" style={{ color: 'var(--red)' }}>{err}</div>}
          {note && <div className="small muted">ℹ️ {note}</div>}
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-sm btn-primary" onClick={submit} disabled={pending}>
              {pending
                ? (mode === 'idea' ? (lang === 'en' ? 'Generating…' : '生成中…') : (lang === 'en' ? 'Creating…' : '创建中…'))
                : (lang === 'en' ? 'Create' : '创建')}
            </button>
            <button className="btn btn-sm btn-ghost" onClick={() => setOpen(false)} disabled={pending}>
              {lang === 'en' ? 'Cancel' : '取消'}
            </button>
          </div>
        </div>
      </div>
    </Overlay>
  );
}
