'use client';

import { useState, useRef, useEffect } from 'react';
import { Icon } from '@/components/icons';
import type { SelectableModel } from '@/lib/llm/selectable';
import { useI18n } from '@/lib/i18n';

// 输入框上的「用哪个模型」下拉（2026-08-26，照用户给的豆包工作那个位置放）。
//
// 【为什么记在 localStorage 而不是库里】这是**这台设备上这个人**的临时偏好，
// 不是工作区配置——工作区级的「哪个功能用哪个渠道」在「接入与密钥」里，那份才是真相源。
// 存库会让同事的选择互相覆盖；而它读不到时静默回落「自动」，不影响发消息。
const LS_KEY = 'beacon_model_pick';

export function ModelPicker({
  models,
  value,
  onChange,
}: {
  models: SelectableModel[];
  value: string;
  onChange: (id: string) => void;
}) {
  const { lang } = useI18n();
  const isEn = lang === 'en';
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // 点外面关掉。不加这个的话下拉会一直挂着，挡住输入框
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const current = models.find((m) => m.id === value) ?? models[0];
  if (!current) return null;

  const getModelLabel = (m: SelectableModel) => {
    if (isEn) {
      if (m.id === 'auto' || m.kind === 'auto' || m.label === '自动') return 'Auto';
      if (m.id === 'platform' || m.kind === 'platform' || m.label === '平台默认模型') return 'Platform Default Model';
    }
    return m.label;
  };

  const getModelNote = (m: SelectableModel) => {
    if (isEn) {
      if (m.id === 'auto' || m.kind === 'auto') return 'Routes automatically by function; uses default provider if unconfigured';
      if (m.id === 'platform' || m.kind === 'platform') return 'Platform covered · billed by plan tier, no key needed';
      if (m.kind === 'byok') return m.note.includes('默认') ? 'Your default channel · Uses your quota' : 'Custom connected · Uses your quota';
    }
    return m.note;
  };

  const groups: { title: string; items: SelectableModel[] }[] = [
    { title: '', items: models.filter((m) => m.kind === 'auto') },
    { title: isEn ? 'Custom (Your Key)' : '自接入（你自己的 Key）', items: models.filter((m) => m.kind === 'byok') },
    { title: isEn ? 'Platform (Covered)' : '外接入（平台垫付）', items: models.filter((m) => m.kind === 'platform') },
  ].filter((g) => g.items.length > 0);

  return (
    <div className="model-picker" ref={boxRef}>
      <button
        type="button"
        className="btn btn-sm btn-ghost model-picker-trigger"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={getModelNote(current)}
      >
        <Icon.cpu size={13} />
        <span>{getModelLabel(current)}</span>
        <Icon.chevron size={12} />
      </button>
      {open && (
        <div className="model-picker-menu">
          {groups.map((g) => (
            <div key={g.title || 'auto'}>
              {g.title && <div className="model-picker-group">{g.title}</div>}
              {g.items.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`model-picker-item${m.id === value ? ' active' : ''}`}
                  onClick={() => {
                    onChange(m.id);
                    try { localStorage.setItem(LS_KEY, m.id); } catch { /* 隐私模式下写不进，不影响选择生效 */ }
                    setOpen(false);
                  }}
                >
                  <span className="row" style={{ gap: 6, alignItems: 'center' }}>
                    <b className="small">{getModelLabel(m)}</b>
                    {m.model && <span className="mono small muted">{m.model}</span>}
                    {m.overseas && <span className="badge badge-amber">{isEn ? 'Overseas' : '境外'}</span>}
                    {m.id === value && <Icon.check size={12} />}
                  </span>
                  <span className="small muted">{getModelNote(m)}</span>
                </button>
              ))}
            </div>
          ))}
          {/* 没有自接入渠道时给一条去配的路——否则用户只看到「自动/平台」两项，
              不知道原来可以填自己的 Key */}
          {!models.some((m) => m.kind === 'byok') && (
            <a href="/settings/keys" className="model-picker-item">
              <b className="small">{isEn ? '+ Connect My Own Model' : '+ 接入我自己的模型'}</b>
              <span className="small muted">
                {isEn ? 'Configure key in "Keys & Credentials" to select here' : '在「接入与密钥」填 Key 后这里就能选'}
              </span>
            </a>
          )}
        </div>
      )}
    </div>
  );
}

/** 上次选的那个（读不到就自动档）。只在客户端调。 */
export function readPickedModel(models: SelectableModel[]): string {
  try {
    const v = localStorage.getItem(LS_KEY);
    // 存过的渠道可能已被删除/停用——校验一遍再用，否则会一直指着一个不存在的 id
    if (v && models.some((m) => m.id === v)) return v;
  } catch { /* 隐私模式 */ }
  return models[0]?.id ?? 'auto';
}
