'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/components/icons';
import type { SkillSummary } from '@/lib/skills';

// 自定义技能只开放文本三态（image 仅内置，见 lib/skills/createCustomSkill）
type CustomOutputKind = 'markdown' | 'html' | 'text';
// client-safe：只引平台名映射，不引 lib/skills/index（那会把 prisma 拖进客户端包）
import { SKILL_PLATFORM_OPTIONS, skillPlatformName } from '@/lib/skills/platform';
import { actInstallSkill, actUninstallSkill, actCreateSkill, actImportSkillFromUrl, actExportSkill } from './actions';

// 技能中心交互层：安装/卸载 + 创建自定义技能的折叠表单。
// readOnly（viewer）时只展示，不出现任何操作按钮——server action 侧另有 RBAC 硬拦。

const OUTPUT_KIND_LABEL: Record<string, string> = {
  text: '纯文本（直接复制发布）',
  markdown: 'Markdown（适合长文平台）',
  html: 'HTML（粘贴进富文本编辑器）',
};

const CATEGORY_LABEL: Record<string, string> = { format: '排版成品', generate: '生成脚本', check: '检查', visual: '封面配图' };

const EMPTY_FORM = {
  name: '',
  description: '',
  platform: 'generic',
  promptTemplate: '',
  outputKind: 'text' as CustomOutputKind,
  emoji: '✨',
};

export function SkillCenter({ skills, readOnly }: { skills: SkillSummary[]; readOnly: boolean }) {
  const [pending, start] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [importUrl, setImportUrl] = useState('');
  const [importMsg, setImportMsg] = useState<{ ok: boolean; text: string } | null>(null);
  /** 导出结果就地展示：把 JSON 甩到别处等于让用户自己去找 */
  const [exported, setExported] = useState<{ name: string; json: string } | null>(null);
  const router = useRouter();

  function done(r: { ok: boolean; error?: string }) {
    setBusyId(null);
    if (!r.ok) {
      setErr(r.error ?? '操作失败，请重试');
      return;
    }
    setErr('');
    setCreating(false);
    setForm(EMPTY_FORM);
    router.refresh();
  }

  function toggleInstall(skl: SkillSummary) {
    setBusyId(skl.id);
    start(async () => done(skl.installed ? await actUninstallSkill(skl.id) : await actInstallSkill(skl.id)));
  }

  function submitCreate() {
    start(async () => done(await actCreateSkill(form)));
  }

  function submitImport() {
    const url = importUrl.trim();
    if (!url) return;
    setImportMsg(null);
    start(async () => {
      const r = await actImportSkillFromUrl(url);
      if (r.ok) {
        setImportUrl('');
        setImportMsg({ ok: true, text: `已导入并安装「${r.skillName}」（${r.via === 'generated' ? 'AI 解析内容生成' : '技能定义导入'}）` });
        router.refresh();
      } else {
        setImportMsg({ ok: false, text: r.error ?? '导入失败' });
      }
    });
  }

  return (
    <div className="stack" style={{ gap: 16 }}>
      {err && <div className="small" style={{ color: 'var(--red)' }}>{err}</div>}

      <div className="grid grid-3" style={{ gap: 12 }}>
        {skills.map((skl) => (
          <div key={skl.id} className="card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
              <span style={{ fontSize: 26, lineHeight: 1 }}>{skl.emoji}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row wrap" style={{ gap: 6, alignItems: 'center' }}>
                  <b className="small">{skl.name}</b>
                  {skl.installed && (
                    <span className="badge badge-green"><Icon.check size={11} /> 已安装</span>
                  )}
                </div>
                <div className="row wrap" style={{ gap: 6, marginTop: 4 }}>
                  <span className="badge badge-brand">{skillPlatformName(skl.platform)}</span>
                  <span className="badge badge-gray">{CATEGORY_LABEL[skl.category] ?? skl.category}</span>
                  {!skl.isBuiltin && <span className="badge badge-accent">自定义</span>}
                </div>
              </div>
            </div>
            <div className="small muted" style={{ flex: 1 }}>{skl.description}</div>
            {/* 导出结果就地显示。**不做自动下载**：Artifact/沙箱里 <a download> 是无效的，
          而「点了没反应」比多一步复制更糟。给一个可全选的文本框最稳。 */}
      {exported && (
        <div className="card" style={{ padding: 12, marginTop: 12 }}>
          <div className="row-between" style={{ marginBottom: 6 }}>
            <b className="small">「{exported.name}」的技能包（beaconPack）</b>
            <button className="btn btn-sm btn-ghost" onClick={() => setExported(null)}>关掉</button>
          </div>
          <textarea
            className="input mono"
            readOnly
            rows={8}
            style={{ width: '100%', fontSize: 12 }}
            value={exported.json}
            onFocus={(e) => e.currentTarget.select()}
          />
          <p className="small muted" style={{ margin: '6px 0 0', lineHeight: 1.8 }}>
            全选复制发给别人，对方在「从链接导入」旁边粘贴即可装上。
          </p>
        </div>
      )}

      {!readOnly && (
              <div>
                {/* 只暗被点的这一张：disabled={pending} 会让全部卡片的按钮一起灰掉，
                    看上去像整页坏了。装/卸各自独立，别的卡没理由陪着不可点。 */}
                <button
                  className={`btn btn-sm${skl.installed ? ' btn-ghost' : ' btn-primary'}`}
                  disabled={busyId === skl.id && pending}
                  onClick={() => toggleInstall(skl)}
                >
                  {busyId === skl.id && pending ? '处理中…' : skl.installed ? '卸载' : '安装'}
                </button>
                {/* 【导出】此前技能包是「能装不能导」：市场里能装别人的，自己做的分享不出去，
                    而 exportSkillPack 早就写好了、只是没有任何入口（2026-08-29 扫出来的）。
                    只给自定义技能：内置的导出去没有意义，对方装上还是同一份。 */}
                {!skl.isBuiltin && (
                  <button
                    className="btn btn-sm btn-ghost"
                    style={{ marginLeft: 6 }}
                    disabled={busyId === skl.id && pending}
                    onClick={() => {
                      setBusyId(skl.id);
                      setExported(null);
                      start(async () => {
                        const r = await actExportSkill(skl.id);
                        setBusyId(null);
                        if (r.ok && r.json) setExported({ name: skl.name, json: r.json });
                        else setErr(r.error ?? '导出失败');
                      });
                    }}
                  >
                    导出
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {!readOnly && (
        <div className="card" style={{ padding: 16 }}>
          <div className="row-between wrap" style={{ marginBottom: 8, gap: 8 }}>
            <b className="small">从网址一键导入技能</b>
            <span className="small muted">支持 GitHub 技能定义链接 · 或任意内容作品链接（AI 解析生成）</span>
          </div>
          <div className="row wrap" style={{ gap: 8 }}>
            <input
              className="input"
              style={{ flex: 1, minWidth: 220 }}
              value={importUrl}
              onChange={(e) => setImportUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitImport(); }}
              placeholder="粘贴网址，如 https://raw.githubusercontent.com/.../skill.json 或一篇公众号/小红书文章链接"
            />
            <button className="btn btn-primary" disabled={pending || !importUrl.trim()} onClick={submitImport}>
              {pending ? '导入中…' : '解析并导入'}
            </button>
          </div>
          {importMsg && (
            <div className="small" style={{ marginTop: 8, color: importMsg.ok ? 'var(--green)' : 'var(--red)' }}>
              {importMsg.text}
            </div>
          )}
          <div className="small muted" style={{ marginTop: 6, lineHeight: 1.6 }}>
            自动识别链接类型：是<b>技能定义</b>（JSON / 带 frontmatter 的 SKILL.md）就直接解析导入；
            是<b>内容作品</b>就抓取正文、用 AI 提炼它的风格与排版生成一个可复用技能。导入后自动安装到创作工坊。
          </div>
        </div>
      )}

      {!readOnly && (
        creating ? (
          <div className="card" style={{ padding: 16 }}>
            <div className="row-between" style={{ marginBottom: 10 }}>
              <b className="small">创建自定义技能</b>
              <span className="small muted">技能就是一段「教 AI 怎么干活」的话，写清楚要求就行</span>
            </div>
            <div className="stack" style={{ gap: 10 }}>
              <div className="row wrap" style={{ gap: 8 }}>
                <div className="field" style={{ width: 80 }}>
                  <label className="field-label">图标</label>
                  <input className="input" value={form.emoji} onChange={(e) => setForm({ ...form, emoji: e.target.value })} placeholder="✨" />
                </div>
                <div className="field" style={{ flex: 1, minWidth: 180 }}>
                  <label className="field-label">技能名称</label>
                  <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="如：我的置顶评论生成器" />
                </div>
                <div className="field" style={{ minWidth: 150 }}>
                  <label className="field-label">目标平台</label>
                  <select className="select" value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })}>
                    {SKILL_PLATFORM_OPTIONS.map((p) => (
                      <option key={p.key} value={p.key}>{p.name}</option>
                    ))}
                  </select>
                </div>
                <div className="field" style={{ minWidth: 220 }}>
                  <label className="field-label">出来的是什么</label>
                  <select
                    className="select"
                    value={form.outputKind}
                    onChange={(e) => setForm({ ...form, outputKind: e.target.value as CustomOutputKind })}
                  >
                    {(['text', 'markdown', 'html'] as const).map((k) => (
                      <option key={k} value={k}>{OUTPUT_KIND_LABEL[k]}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="field">
                <label className="field-label">一句话描述</label>
                <input className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="这个技能是干什么的，给谁用" />
              </div>
              <div className="field">
                <label className="field-label">提示词模板</label>
                <textarea
                  className="textarea"
                  rows={7}
                  value={form.promptTemplate}
                  onChange={(e) => setForm({ ...form, promptTemplate: e.target.value })}
                  placeholder={'写清楚你想让 AI 怎么加工内容。可用占位符：\n{{content}} = 你的正文（必须包含）\n{{title}} = 标题\n{{persona}} = 账号人设摘要\n{{context}} = 账号完整上下文（你的文风样本 / 口头禅 / 素材 / 长期记忆）——想让产出像你自己写的就加上它\n{{brief}} = 本次运行的参数（篇幅 / 语气 / 指定素材）\n\n例：把 {{content}} 改写成 3 条适合发在评论区的置顶回复，每条不超过 50 字。'}
                />
                <div className="small muted" style={{ marginTop: 4 }}>
                  运行时 {'{{content}}'} 会被替换成你的正文，{'{{title}}'} 是标题，{'{{persona}}'} 是账号人设摘要，{'{{context}}'} 是你的文风样本/口头禅/素材/记忆，{'{{brief}}'} 是本次的篇幅语气要求。
                </div>
              </div>
              <div className="row" style={{ gap: 8 }}>
                <button
                  className="btn btn-primary"
                  disabled={pending || !form.name.trim() || !form.promptTemplate.trim()}
                  onClick={submitCreate}
                >
                  {pending ? '创建中…' : '创建并安装'}
                </button>
                <button className="btn btn-ghost" disabled={pending} onClick={() => { setCreating(false); setErr(''); }}>取消</button>
              </div>
            </div>
          </div>
        ) : (
          <div>
            <button className="btn btn-primary" onClick={() => setCreating(true)}>
              <Icon.plus size={14} /> 创建自定义技能
            </button>
          </div>
        )
      )}
    </div>
  );
}
