'use client';

import { useState, useTransition } from 'react';
import { Icon } from '@/components/icons';
import { platformName } from '@/lib/constants';
import {
  actAddInspiration,
  actArchiveInspiration,
  actRestoreInspiration,
  actDeleteInspiration,
  actMineQuestions,
} from './actions';
import { useI18n } from '@/lib/i18n';

const SOURCE_BADGE: Record<string, { name: string; cls: string; title: string }> = {
  plugin: { name: '采集助手', cls: 'badge-brand', title: '在网页上一键收藏进来的' },
  manual: { name: '手动记', cls: 'badge-gray', title: '你自己在网页端记的' },
  comment: { name: '我的读者在问', cls: 'badge-green', title: '从你自己作品的评论区里挖出来的问题——这是你的读者想要什么' },
  'rival-comment': {
    name: '同行读者在问',
    cls: 'badge-amber',
    title: '从同行作品的评论区里挖出来的问题——这是赛道里没被满足的需求，但要先判断他们的读者是不是你的读者',
  },
  clip: {
    name: '文章剪藏',
    cls: 'badge-brand',
    title: '在群里发给机器人的链接/正文，已抓下全文并出了摘要与要点。他人作品仅供分析参考，别直接复用其文字',
  },
};

export type InspirationView = {
  id: string;
  title: string;
  note: string | null;
  url: string | null;
  platform: string | null;
  author: string | null;
  source: string;
  state: string;
  createdAt: string;
  scopedToAccount: boolean;
  // 文章剪藏（source='clip'）才有：摘要 / 要点 / 结合本账号的用处 / 正文字数
  summary: string | null;
  points: string[];
  analysis: string | null;
  contentChars: number;
  // 评论提问（source='comment'|'rival-comment'）
  askedCount: number;
  askedWorks: number;
  lastAskedAt: string | null;
};

const TABS = [
  { key: 'open', name: '待用', hint: '会参与每日选题推荐' },
  { key: 'comments', name: '读者提问', hint: '从评论区挖出的问题——回答自己读者的问题不需要蹭热点' },
  { key: 'used', name: '已转选题', hint: '被采纳成选题后自动出队' },
  { key: 'archived', name: '已归档', hint: '不再进候选池，但记录保留' },
] as const;

function relDays(iso: string): string {
  const n = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (n <= 0) return '今天';
  if (n < 7) return `${n} 天前`;
  if (n < 30) return `${Math.round(n / 7)} 周前`;
  return `${Math.round(n / 30)} 个月前`;
}

export function InspirationBoard({ items }: { items: InspirationView[] }) {
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('open');
  const [showForm, setShowForm] = useState(false);
  const [showMine, setShowMine] = useState(false);
  const [pending, start] = useTransition();

  const isComment = (i: InspirationView) => i.source === 'comment' || i.source === 'rival-comment';
  const shown = tab === 'comments'
    ? items.filter(isComment).sort((a, b) => b.askedCount - a.askedCount)
    : items.filter((i) => i.state === tab);
  const active = TABS.find((t) => t.key === tab)!;

  function run(fn: () => Promise<unknown>) {
    start(async () => {
      await fn();
    });
  }

  const { lang } = useI18n();

  const tabLabels: Record<string, string> = {
    open: lang === 'en' ? 'Inbox' : '待用',
    comments: lang === 'en' ? 'Audience Questions' : '读者提问',
    used: lang === 'en' ? 'Converted' : '已转选题',
    archived: lang === 'en' ? 'Archived' : '已归档',
  };

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row wrap" style={{ gap: 10, alignItems: 'center' }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`btn btn-sm ${tab === t.key ? 'btn-primary' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {tabLabels[t.key] ?? t.name} ({t.key === 'comments' ? items.filter(isComment).length : items.filter((i) => i.state === t.key).length})
          </button>
        ))}
        <span className="small muted hide-mobile">{active.hint}</span>
        <div style={{ flex: 1 }} />
        <button className="btn btn-sm" onClick={() => { setShowMine((v) => !v); setShowForm(false); }}>
          <Icon.chat size={13} /> {lang === 'en' ? 'Mine from Comments' : '从评论里挖问题'}
        </button>
        <button className="btn btn-sm btn-primary" onClick={() => { setShowForm((v) => !v); setShowMine(false); }}>
          <Icon.plus size={13} /> {lang === 'en' ? 'Add Inspiration' : '手动记一条'}
        </button>
      </div>

      {showForm && <AddForm onDone={() => setShowForm(false)} />}
      {showMine && <MineForm onDone={() => setShowMine(false)} />}

      {shown.length === 0 ? (
        <p className="small muted" style={{ textAlign: 'center', padding: 28, margin: 0 }}>
          {tab === 'open'
            ? (lang === 'en' ? 'Inspiration inbox is empty. Save posts from the web extension or add manually above.' : '收集箱是空的。装上采集助手后，刷到任何值得记一笔的内容都能一键存进来；也可以点右上角手动记。')
            : tab === 'comments'
              ? (lang === 'en' ? 'No audience questions yet. Enable comment mining in extension or paste comments above.' : '还没有读者提问。在插件设置中开启「评论提问采集」，然后在作品详情页点「读评论提问」，或在上方点「从评论里挖问题」粘贴评论文本。')
              : (lang === 'en' ? `No items in "${tabLabels[active.key] ?? active.name}"` : `「${active.name}」暂无内容`)}
        </p>
      ) : (
        <div className="stack" style={{ gap: 10 }}>
          {shown.map((it) => (
            <div
              key={it.id}
              style={{ padding: 12, borderRadius: 10, border: '1px solid var(--border)' }}
            >
              <div className="row-between" style={{ gap: 12, alignItems: 'flex-start' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row wrap" style={{ gap: 8, alignItems: 'center', marginBottom: 4 }}>
                    <b>{it.title}</b>
                    {it.platform && <span className="badge badge-gray">{platformName(it.platform)}</span>}
                    {SOURCE_BADGE[it.source] && (
                      <span className={`badge ${SOURCE_BADGE[it.source].cls}`} title={SOURCE_BADGE[it.source].title}>
                        {SOURCE_BADGE[it.source].name}
                      </span>
                    )}
                    {it.scopedToAccount && (
                      <span className="badge badge-gray" title="只在当前账号的推荐里出现">
                        本账号
                      </span>
                    )}
                  </div>
                  {it.note && <p className="small" style={{ margin: '4px 0' }}>{it.note}</p>}
                  {it.summary && (
                    <p className="small" style={{ margin: '4px 0', lineHeight: 1.6 }}>{it.summary}</p>
                  )}
                  {it.points.length > 0 && (
                    <ul className="small muted" style={{ margin: '4px 0 4px 16px', padding: 0, lineHeight: 1.6 }}>
                      {it.points.map((pt, i) => (
                        <li key={i}>{pt}</li>
                      ))}
                    </ul>
                  )}
                  {it.analysis && (
                    <p className="small" style={{ margin: '4px 0', lineHeight: 1.6 }}>
                      <b>对你的用处：</b>
                      {it.analysis}
                    </p>
                  )}
                  {isComment(it) && it.askedCount > 0 && (
                    <div className="small row wrap" style={{ gap: 8, marginTop: 2 }}>
                      <span style={{ color: 'var(--green)' }}>
                        被问 {it.askedCount} 次
                      </span>
                      {it.askedWorks > 1 && (
                        <span className="muted">分布在 {it.askedWorks} 条作品下</span>
                      )}
                      {it.lastAskedAt && (
                        <span className="muted">{relDays(it.lastAskedAt)}最近一次</span>
                      )}
                      <span className={`badge ${it.state === 'open' ? 'badge-green' : 'badge-gray'}`} style={{ fontSize: 10 }}>
                        {it.state === 'open' ? (lang === 'en' ? 'Open' : '待用') : it.state === 'used' ? (lang === 'en' ? 'Converted' : '已转选题') : (lang === 'en' ? 'Archived' : '已归档')}
                      </span>
                    </div>
                  )}
                  <div className="small muted row wrap" style={{ gap: 8 }}>
                    <span>{relDays(it.createdAt)}{lang === 'en' ? ' saved' : '收藏'}</span>
                    {it.author && <span>· {it.author}</span>}
                    {it.url && (
                      <a href={it.url} target="_blank" rel="noreferrer noopener">
                        {lang === 'en' ? 'View Original' : '看原内容'}
                      </a>
                    )}
                    {it.contentChars > 0 && (
                      <span title={lang === 'en' ? 'Saved for reference only' : '他人作品，仅供你分析参考，别直接复用其文字'}>
                        · {lang === 'en' ? `${it.contentChars} chars saved` : `正文已存 ${it.contentChars} 字`}
                      </span>
                    )}
                  </div>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  {it.state === 'open' ? (
                    <button className="btn btn-sm" disabled={pending} onClick={() => run(() => actArchiveInspiration(it.id))}>
                      {lang === 'en' ? 'Archive' : '归档'}
                    </button>
                  ) : (
                    <button className="btn btn-sm" disabled={pending} onClick={() => run(() => actRestoreInspiration(it.id))}>
                      {lang === 'en' ? 'Restore' : '放回待用'}
                    </button>
                  )}
                  <button
                    className="btn btn-sm"
                    disabled={pending}
                    onClick={() => {
                      const confirmMsg = lang === 'en' ? `Delete "${it.title}"? Cannot be undone.` : `删除「${it.title}」？删除后不可恢复。`;
                      if (window.confirm(confirmMsg)) run(() => actDeleteInspiration(it.id));
                    }}
                  >
                    <Icon.x size={12} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MineForm({ onDone }: { onDone: () => void }) {
  const [text, setText] = useState('');
  const [scope, setScope] = useState<'own' | 'rival'>('own');
  const [msg, setMsg] = useState('');
  const [failed, setFailed] = useState(false);
  const [pending, start] = useTransition();

  return (
    <div style={{ padding: 12, borderRadius: 10, background: 'var(--surface-2)' }}>
      <div className="row wrap" style={{ gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <span className="small muted">这段评论来自：</span>
        <button
          className={`btn btn-sm${scope === 'own' ? ' btn-primary' : ''}`}
          onClick={() => setScope('own')}
          title="你的读者想要什么"
        >
          我自己的作品
        </button>
        <button
          className={`btn btn-sm${scope === 'rival' ? ' btn-primary' : ''}`}
          onClick={() => setScope('rival')}
          title="赛道里没被满足的需求，但要先判断他们的读者是不是你的读者"
        >
          同行的作品
        </button>
      </div>
      <p className="small" style={{ margin: '0 0 8px', lineHeight: 1.7 }}>
        {scope === 'own'
          ? '把你自己作品评论区的文字整段复制粘贴到下面。'
          : '把同行作品评论区的文字整段复制粘贴到下面——挖出的是「这个赛道里还没人回答的问题」。'}
        系统只挑出<b>提问句</b>存进来，<b>不保存作者、昵称，也不保存其它评论正文</b>。
        判定刻意从严——宁可漏掉几条，也不把陈述句当成问题灌进选题池。
      </p>
      {scope === 'rival' && (
        <p className="small muted" style={{ margin: '0 0 8px', lineHeight: 1.7 }}>
          这里是<b>你自己复制、一次一页</b>的手动操作，系统不做任何自动抓取；
          存下来的只有去掉身份信息的问题短句。
        </p>
      )}
      <textarea
        className="input"
        rows={7}
        placeholder={'每行一条评论，直接从创作者后台全选复制即可。例如：\n这个工具收费吗？\n新手应该先学哪个\n讲得真好'}
        value={text}
        onChange={(e) => setText(e.target.value)}
        style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'inherit' }}
      />
      {msg && (
        <p className="small" style={{ margin: '8px 0 0', color: failed ? 'var(--red)' : 'var(--green)' }}>
          {msg}
        </p>
      )}
      <div className="row" style={{ gap: 8, marginTop: 8 }}>
        <button
          className="btn btn-sm btn-primary"
          disabled={pending || text.trim().length < 10}
          onClick={() =>
            start(async () => {
              setMsg('');
              const r = await actMineQuestions(text, scope);
              if (r.ok) {
                setFailed(false);
                setMsg(
                  `挖到 ${r.found} 个问题，新存入 ${r.created} 条` +
                    (r.found! > r.created! ? `（其余是已经在收集箱里的）` : ''),
                );
                setText('');
              } else {
                setFailed(true);
                setMsg(r.error ?? '没成功，请重试');
              }
            })
          }
        >
          {pending ? '挖掘中…' : '挖出提问'}
        </button>
        <button className="btn btn-sm" onClick={onDone} disabled={pending}>
          收起
        </button>
      </div>
    </div>
  );
}

function AddForm({ onDone }: { onDone: () => void }) {
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [url, setUrl] = useState('');
  const [author, setAuthor] = useState('');
  const [err, setErr] = useState('');
  const [pending, start] = useTransition();

  return (
    <div style={{ padding: 12, borderRadius: 10, background: 'var(--surface-2)' }}>
      <div className="stack" style={{ gap: 8 }}>
        <input
          className="input"
          placeholder="刷到了什么？（标题或一句话概括）"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
        />
        <input
          className="input"
          placeholder="为什么想记它？（选填，但这句最有用——推荐时会优先用它当选题）"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={300}
        />
        <div className="row" style={{ gap: 8 }}>
          <input
            className="input"
            style={{ flex: 2 }}
            placeholder="原文链接（选填）"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <input
            className="input"
            style={{ flex: 1 }}
            placeholder="作者（选填）"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
          />
        </div>
        {err && <p className="small" style={{ color: 'var(--red)', margin: 0 }}>{err}</p>}
        <div className="row" style={{ gap: 8 }}>
          <button
            className="btn btn-sm btn-primary"
            disabled={pending || title.trim().length === 0}
            onClick={() =>
              start(async () => {
                setErr('');
                const r = await actAddInspiration({ title, note, url, author });
                if (r.ok) onDone();
                else setErr(r.error ?? '没成功，请重试');
              })
            }
          >
            {pending ? '保存中…' : '存进收集箱'}
          </button>
          <button className="btn btn-sm" onClick={onDone} disabled={pending}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
