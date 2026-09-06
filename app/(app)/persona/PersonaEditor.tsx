'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { PLATFORM_LIST } from '@/lib/constants';
import { isPersonaBlank, type PersonaCard } from '@/lib/persona';
import { COVER_STYLE_OPTIONS, COVER_FONTS } from '@/lib/cover/styles';
import { actSavePersona } from './actions';
import { PersonaColdStart } from './PersonaColdStart';
import { useI18n } from '@/lib/i18n';

// 人设卡编辑器：受控表单，保存时序列化为 JSON 交给 server action。
// 人设为空的新用户先看到 F3-1 冷启动（一句话 + AI 扩写）；老用户维持原样，不被打扰。
export function PersonaEditor({ initial }: { initial: PersonaCard }) {
  const { lang } = useI18n();
  const [open, setOpen] = useState(false);
  // 手填逃生舱：冷启动里点「我自己手填」后，本次会话不再顶冷启动
  const [manual, setManual] = useState(false);
  const [identity, setIdentity] = useState(initial.identity ?? '');
  const [audience, setAudience] = useState(initial.audience ?? '');
  const [valueProp, setValueProp] = useState(initial.valueProp ?? '');
  const [tone, setTone] = useState(initial.tone ?? '');
  const [niche, setNiche] = useState(initial.niche ?? '');
  // 数组字段用换行文本编辑，保存时按行拆分
  const [canDo, setCanDo] = useState((initial.canDo ?? []).join('\n'));
  const [cantDo, setCantDo] = useState((initial.cantDo ?? []).join('\n'));
  const [platforms, setPlatforms] = useState<string[]>(initial.platforms ?? []);
  const [coverStyle, setCoverStyle] = useState(initial.coverStyle ?? '');
  const [coverFont, setCoverFont] = useState(initial.coverFont ?? '');
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState('');
  const router = useRouter();

  function togglePlatform(key: string) {
    setPlatforms((prev) => (prev.includes(key) ? prev.filter((p) => p !== key) : [...prev, key]));
  }

  function save() {
    const card: PersonaCard = {
      identity,
      audience,
      valueProp,
      tone,
      niche,
      canDo: canDo.split('\n').map((x) => x.trim()).filter(Boolean),
      cantDo: cantDo.split('\n').map((x) => x.trim()).filter(Boolean),
      platforms,
      coverStyle,
      coverFont,
    };
    start(async () => {
      const r = await actSavePersona(JSON.stringify(card));
      if (r.ok) {
        setMsg(lang === 'en' ? `Saved · Version v${r.version}` : `已保存 · 版本 v${r.version}`);
        setOpen(false);
        router.refresh();
        setTimeout(() => setMsg(''), 2500);
      } else {
        setMsg(lang === 'en' ? 'Save failed' : '保存失败');
      }
    });
  }

  // 冷启动：人设空白且用户没选手填 → 顶 F3-1 引导（新用户的第一屏）
  if (!open && isPersonaBlank(initial) && !manual) {
    return (
      <PersonaColdStart
        onManual={() => {
          setManual(true);
          setOpen(true);
        }}
      />
    );
  }

  if (!open) {
    return (
      <span className="row" style={{ gap: 8 }}>
        {msg && <span className="small" style={{ color: 'var(--green)' }}>{msg}</span>}
        <button className="btn btn-sm" onClick={() => setOpen(true)}>
          {lang === 'en' ? 'Edit Persona' : '编辑人设'}
        </button>
      </span>
    );
  }

  return (
    <div className="stack" style={{ gap: 12, marginTop: 4 }}>
      <div className="grid grid-2" style={{ gap: 12 }}>
        <Field label={lang === 'en' ? 'Identity (Who you are & what you do)' : '身份（我是谁、做什么）'}>
          <input
            className="input"
            value={identity}
            onChange={(e) => setIdentity(e.target.value)}
            placeholder={lang === 'en' ? 'e.g., A creator teaching everyday people low-cost content entrepreneurship' : '如：教普通人低成本做内容创业的自媒体人'}
          />
        </Field>
        <Field label={lang === 'en' ? 'Target Audience' : '目标受众'}>
          <input
            className="input"
            value={audience}
            onChange={(e) => setAudience(e.target.value)}
            placeholder={lang === 'en' ? 'e.g., Working professionals and stay-at-home parents seeking side gigs' : '如：想做副业的职场人与宝妈'}
          />
        </Field>
        <Field label={lang === 'en' ? 'Value Proposition' : '价值主张'}>
          <input
            className="input"
            value={valueProp}
            onChange={(e) => setValueProp(e.target.value)}
            placeholder={lang === 'en' ? 'What unique value do you provide to your audience' : '你能给受众带来什么独特价值'}
          />
        </Field>
        <Field label={lang === 'en' ? 'Niche / Industry' : '赛道 / 行业'}>
          <input
            className="input"
            value={niche}
            onChange={(e) => setNiche(e.target.value)}
            placeholder={lang === 'en' ? 'e.g., Content Entrepreneurship / Creator Growth' : '如：内容创业/自媒体成长'}
          />
        </Field>
      </div>

      <Field label={lang === 'en' ? 'Tone & Style' : '语气风格'}>
        <input
          className="input"
          value={tone}
          onChange={(e) => setTone(e.target.value)}
          placeholder={lang === 'en' ? 'e.g., Sincere, relatable, conversational like a friend' : '如：真诚、接地气、像朋友聊天'}
        />
      </Field>

      <div className="grid grid-2" style={{ gap: 12 }}>
        <Field label={lang === 'en' ? 'Can Do (One per line)' : '能做（每行一条）'}>
          <textarea
            className="textarea"
            rows={4}
            value={canDo}
            onChange={(e) => setCanDo(e.target.value)}
            placeholder={lang === 'en' ? 'Starter tutorials\nTopic ideation\nHonest retrospectives' : '起号教程\n选题方法\n真实复盘'}
          />
        </Field>
        <Field label={lang === 'en' ? "Can't Do / Guardrails (One per line)" : '不能做 / 内容红线（每行一条）'}>
          <textarea
            className="textarea"
            rows={4}
            value={cantDo}
            onChange={(e) => setCantDo(e.target.value)}
            placeholder={lang === 'en' ? 'False income promises\nMedical advice\nStock picking' : '虚假承诺收入\n医疗健康建议\n金融荐股'}
          />
        </Field>
      </div>

      {/* 品牌视觉：封面工位的默认值。空 = 按赛道自动推荐，不强迫用户先来这里设一遍 */}
      <div className="grid grid-2" style={{ gap: 12 }}>
        <Field label={lang === 'en' ? 'Default Cover Style (for AI covers)' : '默认封面风格（AI 封面用）'}>
          <select className="select" value={coverStyle} onChange={(e) => setCoverStyle(e.target.value)}>
            <option value="">{lang === 'en' ? 'Auto-recommend by niche' : '按赛道自动推荐'}</option>
            {COVER_STYLE_OPTIONS.map((o) => (
              <option key={o.key} value={o.key} title={o.hint}>{o.name}</option>
            ))}
          </select>
        </Field>
        <Field label={lang === 'en' ? 'Default Font Preference' : '默认字体倾向'}>
          <select className="select" value={coverFont} onChange={(e) => setCoverFont(e.target.value)}>
            <option value="">{lang === 'en' ? 'Match style' : '随风格'}</option>
            {COVER_FONTS.filter((f) => f.key !== 'auto').map((f) => (
              <option key={f.key} value={f.key}>{f.name}</option>
            ))}
          </select>
        </Field>
      </div>

      <Field label={lang === 'en' ? 'Core Platforms' : '主战平台'}>
        <div className="wrap" style={{ gap: 8 }}>
          {PLATFORM_LIST.map((p) => {
            const on = platforms.includes(p.key);
            return (
              <button
                key={p.key}
                type="button"
                onClick={() => togglePlatform(p.key)}
                className={`badge ${on ? 'badge-brand' : 'badge-gray'}`}
                style={{ cursor: 'pointer', border: 'none' }}
              >
                {on ? '✓ ' : ''}{p.name}
              </button>
            );
          })}
        </div>
      </Field>

      <div className="row" style={{ gap: 8 }}>
        <button className="btn btn-sm btn-primary" onClick={save} disabled={pending}>
          {pending ? (lang === 'en' ? 'Saving…' : '保存中…') : (lang === 'en' ? 'Save Persona' : '保存人设')}
        </button>
        <button className="btn btn-sm btn-ghost" onClick={() => setOpen(false)} disabled={pending}>
          {lang === 'en' ? 'Cancel' : '取消'}
        </button>
        <span className="small muted">
          {lang === 'en' ? 'Saving generates a new version and persists to persona memory' : '保存会生成新版本并写入人设记忆'}
        </span>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <label className="field-label">{label}</label>
      {children}
    </div>
  );
}
