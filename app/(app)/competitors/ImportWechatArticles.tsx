'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/components/icons';
import { parseWechatExport, type WechatExportParseResult } from '@/lib/ingest/wechat-export';
import { actImportWechatArticles } from './actions';

// 公众号文章导入 · 读 wechat-article-exporter 的导出文件（JSON）。
//
// 公众号是唯一插件采不到的平台（没有公开网页主页），这张卡是它的入口：
// 用户在本地跑完导出 → 选一个已订阅的公众号 → 导入标题/链接/发布时间。
//
// 解析全在浏览器本地做（parseWechatExport 是纯函数），提交给服务端的只有映射后的精简条目——
// 几百篇的原始导出动辄几 MB（含正文/封面），整包丢给 server action 会撞 body 上限。
// 每批 50 篇与 HTTP 入口的 ingestPayloadSchema 上限对齐。
const BATCH = 50;

type Account = { id: string; name: string; handle: string };

export function ImportWechatArticles({ accounts }: { accounts: Account[] }) {
  const [target, setTarget] = useState(accounts[0]?.id ?? '');
  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState<WechatExportParseResult | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    setMsg(null);
    setParsed(null);
    setFileName(f?.name ?? '');
    if (!f) return;
    let r: WechatExportParseResult;
    try {
      r = parseWechatExport(await f.text());
    } catch {
      setMsg({ ok: false, text: '文件读不出来——请选 exporter 导出的 JSON 文件' });
      return;
    }
    if (r.posts.length === 0) {
      setMsg({
        ok: false,
        text: r.total > 0
          ? `文件里 ${r.total} 条都缺标题或定位不到文章 ID，没有可导入的内容`
          : '没解析出文章——本导入只认 JSON 格式（exporter 导出时选 json，不是 html/excel）',
      });
      return;
    }
    setParsed(r);
  }

  function reset() {
    setParsed(null);
    setFileName('');
    if (fileRef.current) fileRef.current.value = '';
  }

  async function run() {
    if (!parsed || !target) return;
    setMsg(null);
    const all = parsed.posts;
    setProgress({ done: 0, total: all.length });
    let imported = 0;
    for (let i = 0; i < all.length; i += BATCH) {
      // action 抛错（权限不足/演示只读/网络断）也要落到提示上：不接住的话进度条会永远停在
      // 「导入中 0/N」且按钮禁用——用户既不知道失败了，也没法重试。同 ActionButton 的 catch 约定。
      let r: Awaited<ReturnType<typeof actImportWechatArticles>>;
      try {
        r = await actImportWechatArticles(target, all.slice(i, i + BATCH));
      } catch (e) {
        r = { ok: false, error: (e as Error).message || '导入失败，请稍后重试' };
      }
      if (!r.ok) {
        setProgress(null);
        setMsg({ ok: false, text: `${r.error}${imported > 0 ? `（已导入 ${imported} 篇）` : ''}` });
        return;
      }
      imported += r.imported ?? 0;
      setProgress({ done: Math.min(i + BATCH, all.length), total: all.length });
    }
    setProgress(null);
    setMsg({ ok: true, text: `已导入 ${imported} 篇到「${accounts.find((a) => a.id === target)?.name}」，可在右侧作品榜查看` });
    reset();
    router.refresh();
  }

  const range = parsed
    ? [parsed.posts[parsed.posts.length - 1]?.publishedAt, parsed.posts[0]?.publishedAt]
        .map((d) => (d ? d.slice(0, 10) : ''))
        .filter(Boolean)
    : [];
  const targetName = accounts.find((a) => a.id === target)?.name ?? '';
  // 归属核对：文件里的公众号名和选中的账号对不上，多半是选错了下拉框——导错号＝数据页看不见还污染基线
  const mismatch = Boolean(parsed?.accountName && targetName && !targetName.includes(parsed.accountName) && !parsed.accountName.includes(targetName));

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
        <select className="select" style={{ maxWidth: 180 }} value={target} onChange={(e) => setTarget(e.target.value)}>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
        <input
          ref={fileRef}
          type="file"
          accept=".json,.txt,application/json"
          className="input"
          style={{ flex: 1, minWidth: 200, padding: 6 }}
          onChange={onFile}
          disabled={Boolean(progress)}
        />
        <button className="btn btn-sm btn-primary" onClick={run} disabled={!parsed || !target || Boolean(progress)}>
          <Icon.upload size={14} /> {progress ? `导入中 ${progress.done}/${progress.total}` : '导入文章'}
        </button>
      </div>

      {parsed && (
        <div className="small" style={{ color: 'var(--green)' }}>
          <Icon.check size={13} /> {fileName}：解析到 {parsed.posts.length} 篇
          {range.length === 2 ? ` · ${range[0]} ~ ${range[1]}` : ''}
          {parsed.accountName ? ` · 文件来自「${parsed.accountName}」` : ''}
          {parsed.skipped > 0 ? ` · 跳过 ${parsed.skipped} 条（缺标题或定位不到文章 ID）` : ''}
        </div>
      )}
      {mismatch && (
        <div className="small" style={{ color: 'var(--red)' }}>
          ⚠️ 文件来自「{parsed?.accountName}」，但要导入到「{targetName}」——导错账号的文章不会显示在该账号名下，请先核对下拉框。
        </div>
      )}
      {parsed && parsed.droppedMetrics > 0 && (
        <div className="small muted">
          文件里 {parsed.droppedMetrics} 条带阅读/在看数，<b>不会导入</b>：那些数要抓包截取微信客户端凭证才拿得到，属灰色通道。自有号的阅读/完读率走微信官方接口。
        </div>
      )}
      <div className="small muted">
        用开源工具 <a href="https://github.com/wechat-article/wechat-article-exporter" target="_blank" rel="noreferrer noopener" style={{ color: 'var(--brand)' }}>wechat-article-exporter</a>（建议本地/私有部署，别把自己公众号登录态交给在线站点）导出目标公众号的文章，选 JSON 格式，在此导入。
        只导标题/链接/发布时间进选题库，<b>不含互动指标</b>。
      </div>
      {msg && <span className="small" style={{ color: msg.ok ? 'var(--green)' : 'var(--red)' }}>{msg.text}</span>}
    </div>
  );
}
