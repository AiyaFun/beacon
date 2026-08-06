'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { PLATFORM_LIST, platformName } from '@/lib/constants';
import { AIGC_LABEL } from '@/lib/compliance/aigc';
import { parsePublishUrl } from '@/lib/publish/parse-url';
import { actBackfill } from './actions';

export function Backfill() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [platform, setPlatform] = useState<string>(PLATFORM_LIST[0].key);
  const [url, setUrl] = useState('');
  const [views, setViews] = useState('');
  const [likes, setLikes] = useState('');
  const [fromRecommend, setFromRecommend] = useState(false);
  const [aigcConfirmed, setAigcConfirmed] = useState(false);
  const [msg, setMsg] = useState('');
  const [warn, setWarn] = useState('');

  // parse-url 是零依赖纯函数，客户端直接跑，边贴边给反馈（服务端仍会再解析一次，前端提示不作数）
  const parsed = useMemo(() => (url.trim() ? parsePublishUrl(url) : null), [url]);

  function submit() {
    const v = Number(views);
    if (!v || v <= 0) {
      setMsg('请填写有效播放量');
      return;
    }
    if (!aigcConfirmed) {
      setMsg('请先勾选「AI 使用声明」');
      return;
    }
    start(async () => {
      try {
        const r = await actBackfill(platform, v, Number(likes) || 0, fromRecommend, {
          url: url.trim() || undefined,
          aigcConfirmed,
        });
        if (!r.ok) {
          setMsg('出错：' + (r.error ?? '登记失败'));
          return;
        }
        setMsg(r.platformItemId ? '已登记，作品 ID 已绑定，将自动回流数据' : '已登记一条发布回流');
        setWarn(r.warning ?? '');
        setUrl('');
        setViews('');
        setLikes('');
        setFromRecommend(false);
        setAigcConfirmed(false);
        router.refresh();
        setTimeout(() => setMsg(''), 2500);
      } catch (e) {
        setMsg('出错：' + (e as Error).message.slice(0, 40));
      }
    });
  }

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="grid grid-2" style={{ gap: 12 }}>
        <div className="field">
          <label className="field-label">发布平台</label>
          <select className="select" value={platform} onChange={(e) => setPlatform(e.target.value)}>
            {PLATFORM_LIST.map((p) => (
              <option key={p.key} value={p.key}>{p.name}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field-label">归因来源</label>
          <label className="row" style={{ gap: 8, height: 38, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={fromRecommend}
              onChange={(e) => setFromRecommend(e.target.checked)}
            />
            <span className="small">这条来自产品的 AI 推荐选题</span>
          </label>
        </div>
      </div>

      <div className="field">
        <label className="field-label">发布链接（选填，填了才能自动回流数据）</label>
        <input
          className="input"
          type="url"
          placeholder="如 https://www.douyin.com/video/7123456789012345678"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            // 链接是比下拉框更强的证据：认出平台就顺手对齐，省掉「平台选错→ID 被丢弃」
            const r = parsePublishUrl(e.target.value);
            if (r.ok) setPlatform(r.platform);
          }}
        />
        {parsed && (
          <span className="small" style={{ color: parsed.ok ? 'var(--green)' : 'var(--amber)' }}>
            {parsed.ok
              ? `已识别：${platformName(parsed.platform)} · 作品 ID ${parsed.platformItemId}`
              : parsed.message}
          </span>
        )}
        {parsed && !parsed.ok && (
          <span className="small" style={{ color: 'var(--text-3)' }}>
            仍可直接登记，但这条记录的数据自动回流将不可用，需要手动回填。
          </span>
        )}
      </div>

      <div className="grid grid-2" style={{ gap: 12 }}>
        <div className="field">
          <label className="field-label">播放 / 曝光量</label>
          <input
            className="input"
            type="number"
            inputMode="numeric"
            min={0}
            placeholder="如 45000"
            value={views}
            onKeyDown={(e) => { if (['e', 'E', '+', '-'].includes(e.key)) e.preventDefault(); }}
            onChange={(e) => setViews(e.target.value)}
          />
        </div>
        <div className="field">
          <label className="field-label">点赞量</label>
          <input
            className="input"
            type="number"
            inputMode="numeric"
            min={0}
            placeholder="如 3200"
            value={likes}
            onKeyDown={(e) => { if (['e', 'E', '+', '-'].includes(e.key)) e.preventDefault(); }}
            onChange={(e) => setLikes(e.target.value)}
          />
        </div>
      </div>

      {/* AI 声明确认（PRD §6 F7-1 AC③ 必选）。这是《人工智能生成合成内容标识办法》告知义务
          链条的最后一环：lib/compliance/aigc.ts 负责在导出/复制出口把显式标识写进内容，
          这里负责让登记者确认「已在平台侧声明」——平台的 AI 声明开关我们够不着，只能确认。 */}
      <div className="field">
        <label className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
          <input
            type="checkbox"
            checked={aigcConfirmed}
            onChange={(e) => setAigcConfirmed(e.target.checked)}
            style={{ marginTop: 3 }}
          />
          <span className="small">
            <b>AI 使用声明（必选）</b>：我确认本次发布的内容如包含 AI 生成/合成成分，已按《人工智能生成合成内容标识办法》
            在内容中保留显式标识（如「{AIGC_LABEL}」），并已在平台侧勾选其 AI 内容声明选项。
          </span>
        </label>
      </div>

      <div className="row" style={{ gap: 10 }}>
        <button className="btn btn-primary btn-sm" onClick={submit} disabled={pending || !aigcConfirmed}>
          {pending ? '登记中…' : '登记发布回流'}
        </button>
        {msg && <span className="small" style={{ color: msg.startsWith('出错') ? 'var(--red)' : 'var(--green)' }}>{msg}</span>}
      </div>
      {warn && <span className="small" style={{ color: 'var(--text-3)' }}>{warn}</span>}
    </div>
  );
}
