'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { PLATFORM_LIST } from '@/lib/constants';
import { isPersonaBlank, type PersonaCard } from '@/lib/persona';
import { actSavePersona } from './actions';
import { PersonaColdStart } from './PersonaColdStart';

// 人设卡编辑器：受控表单，保存时序列化为 JSON 交给 server action。
// 人设为空的新用户先看到 F3-1 冷启动（一句话 + AI 扩写）；老用户维持原样，不被打扰。
export function PersonaEditor({ initial }: { initial: PersonaCard }) {
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
    };
    start(async () => {
      const r = await actSavePersona(JSON.stringify(card));
      if (r.ok) {
        setMsg(`已保存 · 版本 v${r.version}`);
        setOpen(false);
        router.refresh();
        setTimeout(() => setMsg(''), 2500);
      } else {
        setMsg('保存失败');
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
        <button className="btn btn-sm" onClick={() => setOpen(true)}>编辑人设</button>
      </span>
    );
  }

  return (
    <div className="stack" style={{ gap: 12, marginTop: 4 }}>
      <div className="grid grid-2" style={{ gap: 12 }}>
        <Field label="身份（我是谁、做什么）">
          <input className="input" value={identity} onChange={(e) => setIdentity(e.target.value)} placeholder="如：教普通人低成本做内容创业的自媒体人" />
        </Field>
        <Field label="目标受众">
          <input className="input" value={audience} onChange={(e) => setAudience(e.target.value)} placeholder="如：想做副业的职场人与宝妈" />
        </Field>
        <Field label="价值主张">
          <input className="input" value={valueProp} onChange={(e) => setValueProp(e.target.value)} placeholder="你能给受众带来什么独特价值" />
        </Field>
        <Field label="赛道 / 行业">
          <input className="input" value={niche} onChange={(e) => setNiche(e.target.value)} placeholder="如：内容创业/自媒体成长" />
        </Field>
      </div>

      <Field label="语气风格">
        <input className="input" value={tone} onChange={(e) => setTone(e.target.value)} placeholder="如：真诚、接地气、像朋友聊天" />
      </Field>

      <div className="grid grid-2" style={{ gap: 12 }}>
        <Field label="能做（每行一条）">
          <textarea className="textarea" rows={4} value={canDo} onChange={(e) => setCanDo(e.target.value)} placeholder={'起号教程\n选题方法\n真实复盘'} />
        </Field>
        <Field label="不能做 / 内容红线（每行一条）">
          <textarea className="textarea" rows={4} value={cantDo} onChange={(e) => setCantDo(e.target.value)} placeholder={'虚假承诺收入\n医疗健康建议\n金融荐股'} />
        </Field>
      </div>

      <Field label="主战平台">
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
          {pending ? '保存中…' : '保存人设'}
        </button>
        <button className="btn btn-sm btn-ghost" onClick={() => setOpen(false)} disabled={pending}>取消</button>
        <span className="small muted">保存会生成新版本并写入人设记忆</span>
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
