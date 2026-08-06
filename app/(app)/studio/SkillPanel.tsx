'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Empty, TierBadge } from '@/components/ui';
import { CopyText } from '@/components/CopyText';
import { copyRichText, htmlToPlain } from '@/lib/clipboard/rich';
import type { SkillSummary } from '@/lib/skills';
import { skillPlatformName } from '@/lib/skills/platform';
import { COVER_STYLE_OPTIONS, DEFAULT_COVER_STYLE } from '@/lib/cover/styles';
import { actRunSkill, actSkillSaveVersion, actDownloadCover, type RunSkillActionResult } from './actions';

// 参考图上限：与服务端 runCoverSkill 的 MAX_REFERENCE_IMAGES 对齐（两处同步靠这条注释钉住）。
const MAX_REF_IMAGES = 3;
const MAX_REF_BYTES = 8 * 1024 * 1024; // 单张 8MB：再大 base64 进请求体就太重了

// 技能中心（/skills）安装的技能在这里一键运行：正文 → 平台成品（微信排版/小红书图文…）。
// 列表由服务端（page.tsx → listInstalledSkills）算好传入，本组件只管触发与展示。
// type-only import：lib/skills 引了 prisma，值导入会进不了客户端包，类型导入编译期即擦除。
export type SkillMeta = SkillSummary;

type SkillOutput = Extract<RunSkillActionResult, { ok: true }>;

// ── 技能 HTML 出口白名单消毒（防技能 HTML 预览/复制的存储型 XSS）──
//
// 技能产出的 HTML 经 LLM 生成、不可信，却要进 dangerouslySetInnerHTML 预览、又要写进剪贴板富文本。
// 正则「拔 <script>/on*/js:」易被 HTML 实体、畸形标签、嵌套绕过；这里改用浏览器原生 DOMParser 把
// HTML 解析成节点树，再按**白名单**重建：只放行排版标签 + 安全属性，其余标签删壳留文本、其余属性一律删。

// 排版白名单标签（公众号 / 小红书排版常用；不含任何可执行或可嵌资源的标签）。
const SKILL_ALLOWED_TAGS = new Set([
  'p', 'div', 'span', 'section', 'article', 'header', 'footer',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'em', 'b', 'i', 'u', 's', 'strike', 'del', 'ins', 'mark', 'small', 'sub', 'sup',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'blockquote', 'br', 'hr', 'pre', 'code',
  'a', 'img',
  'figure', 'figcaption',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col',
]);

// 非白名单但**连内容一起删**的标签：脚本 / 样式 / 可嵌资源 / 表单等。unwrap 它们会把 JS/CSS 正文
// 当可见文本吐出来（既难看又危险），故整棵子树丢弃；其余未知标签才走「删壳留文本」。
const SKILL_DROP_SUBTREE = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template',
  'form', 'input', 'textarea', 'select', 'button', 'option',
  'link', 'meta', 'base', 'title', 'head',
  'svg', 'math', 'canvas', 'audio', 'video', 'source', 'track', 'applet', 'frame', 'frameset',
]);

// 各标签放行的非 style 属性白名单（style 全局放行、a.href / img.src 单独校验协议）。
// 这些属性都是惰性的（不触发脚本 / 不加载跨源资源）。
const SKILL_TAG_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'title']),
  img: new Set(['alt', 'title', 'width', 'height']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan']),
  col: new Set(['span']),
  colgroup: new Set(['span']),
};

// a 的 href 仅放行 http/https/mailto；img 的 src 仅放行 http/https/data:image。
// 正向白名单：normalize（去首尾空白 + 去控制字符）后不匹配即丢弃，天然免疫 "java\tscript:" 之类混淆。
function skillAllowedHref(value: string): boolean {
  return /^(https?:|mailto:)/i.test(value.trim().replace(/[\u0000-\u001f]/g, ''));
}
function skillAllowedImgSrc(value: string): boolean {
  return /^(https?:|data:image\/)/i.test(value.trim().replace(/[\u0000-\u001f]/g, ''));
}

// style 值：命中 expression( / javascript: / url() 指向非 http 的，整条 style 剥掉（返回 null）。
function skillSafeStyle(value: string): string | null {
  const v = value.toLowerCase();
  if (v.includes('expression(') || v.includes('javascript:')) return null;
  for (const m of v.match(/url\(([^)]*)\)/g) ?? []) {
    const inner = m.slice(4, -1).replace(/['"]/g, '').trim();
    if (!/^https?:/.test(inner)) return null;
  }
  return value;
}

// 递归把 src 子树按白名单重建到 dest（dest 属于同一个惰性文档，不会触发资源加载/脚本执行）。
function skillCleanInto(src: Node, dest: Node, doc: Document): void {
  src.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      dest.appendChild(doc.createTextNode(child.nodeValue ?? ''));
      return;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) return; // 注释等一律丢
    const el = child as Element;
    const tag = el.tagName.toLowerCase();
    if (SKILL_DROP_SUBTREE.has(tag)) return; // 脚本/样式/资源标签：连内容删
    if (!SKILL_ALLOWED_TAGS.has(tag)) {
      skillCleanInto(el, dest, doc); // 未知标签：删壳留文本子节点
      return;
    }
    const clean = doc.createElement(tag);
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const val = attr.value;
      if (name === 'style') {
        const safe = skillSafeStyle(val);
        if (safe !== null) clean.setAttribute('style', safe);
        continue;
      }
      if (tag === 'a' && name === 'href') {
        if (skillAllowedHref(val)) clean.setAttribute('href', val);
        continue;
      }
      if (tag === 'img' && name === 'src') {
        if (skillAllowedImgSrc(val)) clean.setAttribute('src', val);
        continue;
      }
      if (SKILL_TAG_ATTRS[tag]?.has(name)) clean.setAttribute(name, val);
      // 其余属性（含所有 on* 事件处理器、非白名单属性）一律丢弃
    }
    skillCleanInto(el, clean, doc);
    dest.appendChild(clean);
  });
}

// 纯函数：白名单消毒技能 HTML，供预览与复制富文本共用。
// SSR 首帧无 DOMParser 时退化为转义纯文本（安全但无富文本），客户端 hydration 后自然升级为富文本
// ——技能预览本就是点按后才出现的交互态，首帧不富文本可接受。
function sanitizeSkillHtml(html: string): string {
  if (typeof window === 'undefined' || typeof DOMParser === 'undefined') {
    return html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out = doc.createElement('div');
  skillCleanInto(doc.body, out, doc);
  return out.innerHTML;
}

const RISK_LABEL: Record<string, { text: string; cls: string }> = {
  pass: { text: '合规通过', cls: 'badge-green' },
  warn: { text: '存在提示项', cls: 'badge-amber' },
  block: { text: '命中红线', cls: 'badge-red' },
};

export type SkillMaterial = { id: string; type: string; content: string };

export function SkillPanel({
  draftId,
  skills,
  draftPlatform,
  materials = [],
}: {
  draftId?: string;
  skills: SkillMeta[];
  /** 当前草稿的目标平台：用来把技能分组，并在跨平台运行时提醒 */
  draftPlatform?: string;
  /** 本账号素材库（参数卡里勾选「这篇要用哪几条」） */
  materials?: SkillMaterial[];
}) {
  const [pending, start] = useTransition();
  const [runningId, setRunningId] = useState('');
  const [result, setResult] = useState<SkillOutput | null>(null);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState('');
  const router = useRouter();

  // ── 参数卡：这一次想要什么（与账号长期设定分开，见 lib/skills/render.ts）──
  const [showParams, setShowParams] = useState(false);
  const [length, setLength] = useState<'short' | 'keep' | 'long'>('keep');
  const [tone, setTone] = useState<'calm' | 'keep' | 'punchy'>('keep');
  const [picked, setPicked] = useState<string[]>([]);
  const [extra, setExtra] = useState('');
  // ⚠️ 所有 hook 必须在下面那个「没装技能就早返回」之前声明——放到 return 之后是条件调用，React 会崩
  const [showOthers, setShowOthers] = useState(false);

  // ── 封面选项（仅 image 技能用）──
  const [coverStyle, setCoverStyle] = useState<string>(DEFAULT_COVER_STYLE);
  const [coverTextless, setCoverTextless] = useState(false);
  const [refImages, setRefImages] = useState<string[]>([]); // 参考图 data:URI（主体保真）
  const [refErr, setRefErr] = useState('');
  const [lastSkill, setLastSkill] = useState<SkillMeta | null>(null); // 「换一张」要重跑同一个技能
  const [downloading, setDownloading] = useState(false);
  const [coverNote, setCoverNote] = useState('');

  if (skills.length === 0) {
    return (
      <Empty
        icon="🧩"
        text="还没有安装技能——去技能中心装上「微信一键排版」「小红书排版」等，就能把正文一键变成平台成品"
        action={<Link className="btn btn-sm btn-primary" href="/skills">去技能中心安装</Link>}
      />
    );
  }

  function run(skill: SkillMeta) {
    if (!draftId) return;
    // 跨平台运行要确认：把抖音口播丢给「知乎长文排版」是能跑的，跑完才发现不对代价太大
    // （一次真实 LLM 调用 + 一次配额）。技能标 generic 的不拦。
    if (draftPlatform && skill.platform !== 'generic' && skill.platform !== draftPlatform) {
      const ok = window.confirm(
        `「${skill.name}」是为${skillPlatformName(skill.platform)}做的，当前草稿是${skillPlatformName(draftPlatform)}。\n` +
        '继续会把这篇改成另一个平台的形态（会消耗一次 AI 额度）。确定继续吗？',
      );
      if (!ok) return;
    }
    setErr('');
    setSaved('');
    setCopied(false);
    setCoverNote('');
    setLastSkill(skill);
    setRunningId(skill.id);
    // 封面技能：把风格 / 参考图 / 留白版一并带上；其余技能 cover=undefined，走原文本路径
    const cover = skill.outputKind === 'image'
      ? { style: coverStyle, referenceImages: refImages, textless: coverTextless }
      : undefined;
    start(async () => {
      const r = await actRunSkill(
        draftId,
        skill.id,
        {
          platform: skill.platform !== 'generic' ? skill.platform : draftPlatform,
          length,
          tone,
          materialIds: picked,
          extra,
        },
        cover,
      );
      setRunningId('');
      if (r.ok) {
        setResult(r);
      } else {
        setErr(r.error);
        setResult(null);
      }
    });
  }

  // 参考图上传：读成 data:URI（不外链，见 lib/llm/image.ts），限张数与单张大小
  function onPickRefImages(files: FileList | null) {
    setRefErr('');
    if (!files || files.length === 0) return;
    const room = MAX_REF_IMAGES - refImages.length;
    if (room <= 0) {
      setRefErr(`最多 ${MAX_REF_IMAGES} 张参考图`);
      return;
    }
    Array.from(files).slice(0, room).forEach((file) => {
      if (!file.type.startsWith('image/')) {
        setRefErr('只支持图片文件');
        return;
      }
      if (file.size > MAX_REF_BYTES) {
        setRefErr(`「${file.name}」超过 8MB，换张小点的`);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const uri = typeof reader.result === 'string' ? reader.result : '';
        if (uri) setRefImages((prev) => (prev.length >= MAX_REF_IMAGES ? prev : [...prev, uri]));
      };
      reader.readAsDataURL(file);
    });
  }

  // 下载封面：走服务端代理（跨源直链前端 <a download> 下不了，且借这跳注入 PNG 隐式 AIGC 标识）
  function downloadCover(url: string) {
    setCoverNote('');
    setDownloading(true);
    start(async () => {
      const r = await actDownloadCover(url);
      setDownloading(false);
      if (!r.ok) {
        setErr(r.error);
        return;
      }
      const bin = atob(r.dataBase64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const blob = new Blob([arr], { type: r.mime });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = r.filename;
      a.click();
      URL.revokeObjectURL(a.href);
      if (r.warning) setCoverNote(r.warning);
    });
  }

  // 复制富文本（HTML 产出专用）。**消毒是这里的责任，标识与剪贴板交给 lib/clipboard/rich**：
  // 技能产出是 LLM 生成的不可信 HTML，必须先过白名单；而 AIGC 标识那套（显式文案 + 隐式元数据
  // + 双 flavor 写入）每个复制出口都一样，抄第二遍就会漏。
  async function copyRich(r: SkillOutput) {
    const html = sanitizeSkillHtml(r.output);
    await copyRichText(html, htmlToPlain(html));
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  function saveVersion(r: SkillOutput) {
    if (!draftId) return;
    start(async () => {
      const res = await actSkillSaveVersion(draftId, r.output, r.skillName);
      if (res.ok) {
        setSaved(`已存为第${res.seq}版`);
        router.refresh();
      } else {
        setErr(res.error ?? '保存失败');
      }
    });
  }

  const risk = result ? RISK_LABEL[result.riskLevel] : null;

  // 按平台分组：当前草稿平台（含通用技能）排前面，其余折叠。
  // 全部平铺时用户很容易在抖音稿上点到「知乎长文排版」——列表没有立场，用户就得自己记。
  const matched = draftPlatform
    ? skills.filter((s) => s.platform === draftPlatform || s.platform === 'generic')
    : skills;
  const others = draftPlatform ? skills.filter((s) => !matched.includes(s)) : [];
  // 装了封面（image）技能才显示封面选项面板，避免对纯文本用户徒增干扰
  const hasImageSkill = matched.some((s) => s.outputKind === 'image');

  const renderSkillButton = (sk: SkillMeta) => (
    <button
      key={sk.id}
      className="btn btn-sm"
      onClick={() => run(sk)}
      disabled={pending || !draftId}
      title={draftId ? sk.description : '先在左侧选中一份草稿'}
    >
      {sk.emoji} {runningId === sk.id && pending ? '生成中…' : sk.name}
    </button>
  );

  const briefTouched = length !== 'keep' || tone !== 'keep' || picked.length > 0 || extra.trim().length > 0;

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row wrap" style={{ gap: 8 }}>
        {matched.map(renderSkillButton)}
        {matched.length === 0 && (
          <span className="small muted">
            没有适配{draftPlatform ? skillPlatformName(draftPlatform) : '该平台'}的已装技能——展开下面「其他平台」，或去技能中心装一个。
          </span>
        )}
      </div>

      {/* 封面选项：风格 / 参考图（主体保真）/ 留白版。点「🎨 小红书封面」前先设好，出图就用这些设置 */}
      {hasImageSkill && (
        <div className="card" style={{ padding: 12, boxShadow: 'none', background: 'var(--surface-2)' }}>
          <div className="small muted" style={{ marginBottom: 8 }}>封面选项（点「🎨 小红书封面」时生效）</div>
          <div className="row wrap" style={{ gap: 10, alignItems: 'center' }}>
            <label className="small muted">风格</label>
            <select className="select" style={{ maxWidth: 160 }} value={coverStyle} onChange={(e) => setCoverStyle(e.target.value)}>
              {COVER_STYLE_OPTIONS.map((o) => (
                <option key={o.key} value={o.key} title={o.hint}>{o.name}</option>
              ))}
            </select>
            <label className="small muted" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input type="checkbox" checked={coverTextless} onChange={(e) => setCoverTextless(e.target.checked)} />
              文字留白版（不上字，自己叠）
            </label>
          </div>

          <div className="small muted" style={{ margin: '10px 0 6px' }}>
            参考图（可选，上传人像/产品照，封面会「主体保真」保留你）
          </div>
          <div className="row wrap" style={{ gap: 6, alignItems: 'center' }}>
            {refImages.map((uri, i) => (
              <span key={i} style={{ position: 'relative', display: 'inline-block' }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={uri} alt="参考图" style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--border)' }} />
                <button
                  className="btn btn-xs"
                  style={{ position: 'absolute', top: -6, right: -6, padding: '0 5px', lineHeight: 1.4 }}
                  title="移除"
                  onClick={() => setRefImages((prev) => prev.filter((_, j) => j !== i))}
                >×</button>
              </span>
            ))}
            {refImages.length < MAX_REF_IMAGES && (
              <label className="btn btn-sm btn-ghost" style={{ cursor: 'pointer' }}>
                + 添加参考图
                <input type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={(e) => { onPickRefImages(e.target.files); e.target.value = ''; }} />
              </label>
            )}
          </div>
          {refErr && <div className="small" style={{ color: 'var(--red)', marginTop: 6 }}>{refErr}</div>}
        </div>
      )}

      {others.length > 0 && (
        <div className="stack" style={{ gap: 8 }}>
          <button className="btn btn-sm btn-ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setShowOthers((v) => !v)}>
            {showOthers ? '收起' : `其他平台的技能（${others.length}）`}
          </button>
          {showOthers && (
            <div className="row wrap" style={{ gap: 8 }}>
              {others.map(renderSkillButton)}
            </div>
          )}
        </div>
      )}

      {/* 参数卡：运行前 3 秒能填完的「这一次想要什么」 */}
      <div className="stack" style={{ gap: 8 }}>
        <button className="btn btn-sm btn-ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setShowParams((v) => !v)}>
          {showParams ? '收起本次要求' : briefTouched ? '本次要求（已设置）' : '本次要求（篇幅 / 语气 / 指定素材）'}
        </button>
        {showParams && (
          <div className="card" style={{ padding: 12, boxShadow: 'none', background: 'var(--surface-2)' }}>
            <div className="row wrap" style={{ gap: 10, alignItems: 'center' }}>
              <label className="small muted">篇幅</label>
              <select className="select" style={{ maxWidth: 150 }} value={length} onChange={(e) => setLength(e.target.value as typeof length)}>
                <option value="keep">不限</option>
                <option value="short">更短</option>
                <option value="long">更充分</option>
              </select>
              <label className="small muted">语气</label>
              <select className="select" style={{ maxWidth: 150 }} value={tone} onChange={(e) => setTone(e.target.value as typeof tone)}>
                <option value="keep">保持人设</option>
                <option value="calm">更克制</option>
                <option value="punchy">更冲</option>
              </select>
            </div>

            {materials.length > 0 && (
              <>
                <div className="small muted" style={{ margin: '10px 0 6px' }}>
                  这篇要重点用上哪几条素材（不选就按账号整体素材来）
                </div>
                <div className="row wrap" style={{ gap: 6 }}>
                  {materials.map((m) => {
                    const on = picked.includes(m.id);
                    return (
                      <button
                        key={m.id}
                        className={`btn btn-sm ${on ? 'btn-accent' : 'btn-ghost'}`}
                        onClick={() => setPicked((prev) => (on ? prev.filter((x) => x !== m.id) : [...prev, m.id]))}
                        title={m.content}
                      >
                        {m.content.slice(0, 16)}{m.content.length > 16 ? '…' : ''}
                      </button>
                    );
                  })}
                </div>
              </>
            )}

            <div className="field" style={{ marginTop: 10 }}>
              <label className="field-label small muted">还有什么要求（可选）</label>
              <input
                className="input"
                placeholder="比如：结尾别引导关注 / 多举一个具体例子"
                value={extra}
                onChange={(e) => setExtra(e.target.value)}
                maxLength={200}
              />
            </div>
          </div>
        )}
      </div>

      {!draftId && <div className="small muted">选中左侧一份草稿后，点技能即可把正文一键变成成品。</div>}
      {err && <div className="small" style={{ color: 'var(--red)' }}>{err}</div>}

      {result && (
        <div className="card" style={{ padding: 14, boxShadow: 'none', background: 'var(--surface-2)' }}>
          <div className="row-between" style={{ marginBottom: 8 }}>
            <b className="small">{result.skillName}</b>
            <div className="row wrap" style={{ gap: 6 }}>
              {/* 用的是第几版必须显示：取错版本是不会报错的那种错，用户只会觉得「怎么改的东西没进去」 */}
              <span className="badge badge-gray" title="技能永远基于最新一版正文运行">
                基于第 {result.sourceSeq} 版
              </span>
              {result.mocked && (
                <span className="badge badge-amber" title="尚未接入真实模型，这是内置的演示产出，仅用于预览流程">
                  演示结果（未接入真实 AI）
                </span>
              )}
              {risk && <span className={`badge ${risk.cls}`}>{risk.text}</span>}
            </div>
          </div>

          {result.outputKind === 'image' && result.images ? (
            <div className="stack" style={{ gap: 8 }}>
              {result.coverMeta?.mainTitle && (
                <div className="small muted">
                  封面文案：<b>{result.coverMeta.mainTitle}</b>
                  {result.coverMeta.subTitle ? ` · ${result.coverMeta.subTitle}` : ''}
                </div>
              )}
              <div className="row wrap" style={{ gap: 10 }}>
                {result.images.map((img, i) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={i}
                    src={img.url}
                    alt="小红书封面"
                    style={{ width: 240, aspectRatio: '3 / 4', objectFit: 'cover', borderRadius: 10, border: '1px solid var(--border)' }}
                  />
                ))}
              </div>
              <div className="small muted">图上「AI生成」水印为合规标识；直链约 24 小时有效，请及时下载。</div>
            </div>
          ) : result.outputKind === 'html' ? (
            <div
              className="small"
              style={{ lineHeight: 1.7, background: 'var(--surface)', borderRadius: 8, padding: 12, overflowX: 'auto' }}
              // 已过 sanitizeSkillHtml（DOMParser 白名单消毒）后才进 innerHTML
              dangerouslySetInnerHTML={{ __html: sanitizeSkillHtml(result.output) }}
            />
          ) : (
            <div className="small" style={{ whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>{result.output}</div>
          )}

          {result.hits.length > 0 && (
            <>
              <div className="divider" />
              <div className="small muted" style={{ marginBottom: 6 }}>以下用词发布前建议再斟酌：</div>
              <div className="stack" style={{ gap: 6 }}>
                {result.hits.map((h, i) => (
                  <div key={i} className="row wrap" style={{ gap: 6, alignItems: 'center' }}>
                    <TierBadge tier={h.tier} />
                    <span className="mono small">「{h.word}」</span>
                    {h.suggestion && <span className="small muted">→ {h.suggestion}</span>}
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="divider" />
          <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
            {result.outputKind === 'image' && result.images ? (
              <>
                {result.images.map((img, i) => (
                  <button key={i} className="btn btn-sm" onClick={() => downloadCover(img.url)} disabled={pending || downloading}>
                    {downloading ? '下载中…' : result.images!.length > 1 ? `下载第 ${i + 1} 张` : '下载封面'}
                  </button>
                ))}
                {lastSkill && (
                  <button className="btn btn-sm btn-ghost" onClick={() => run(lastSkill)} disabled={pending} title="用当前封面选项重新生成一张">
                    换一张
                  </button>
                )}
                {coverNote && <span className="small muted">{coverNote}</span>}
              </>
            ) : (
              <>
                {result.outputKind === 'html' ? (
                  <button className="btn btn-sm" onClick={() => copyRich(result)} disabled={pending} title="以富文本复制，可直接粘进公众号等编辑器（自动附带 AI 生成标识）">
                    {copied ? '已复制 ✓' : '复制富文本'}
                  </button>
                ) : (
                  <CopyText text={result.output} label="复制成品" />
                )}
                {draftId && (
                  <button className="btn btn-sm btn-ghost" onClick={() => saveVersion(result)} disabled={pending}>
                    存为新版本
                  </button>
                )}
                {saved && <span className="small" style={{ color: 'var(--green)' }}>{saved}</span>}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
