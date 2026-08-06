import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { parseJson } from '@/lib/json';
import { decryptKey, maskKey } from '@/lib/crypto';
import { LLM_FUNCTIONS, type LlmFunction } from '@/lib/constants';
import { sourceHealthBoard } from '@/lib/adapters/registry';
import { embedderInfo } from '@/lib/vector/embed';
import { PageHead, Card, Stat, Empty } from '@/components/ui';
import { Icon } from '@/components/icons';
import { ProviderForm } from './ProviderForm';
import { ProviderRow } from './ProviderRow';
import { IngestTokenCard } from './IngestTokenCard';
import { listIngestTokens } from '@/lib/ingest/token';

import { AutomationCard, type LastRun } from './AutomationCard';
import { readAutomationConfig, AUTOMATION_ITEMS } from '@/lib/jobs/automation';

export const dynamic = 'force-dynamic';


// F12 模型接入(BYOK) 与设置。research-11：国内已备案供应商全版本开放，海外锁企业版+出海。

const VENDOR_LABEL: Record<string, string> = {
  deepseek: 'DeepSeek',
  qwen: '通义千问',
  kimi: 'Kimi',
  glm: '智谱 GLM',
  hunyuan: '腾讯混元',
  doubao: '字节豆包',
  baichuan: '百川智能',
  minimax: 'MiniMax',
  yi: '零一万物',
  spark: '讯飞星火',
  stepfun: '阶跃星辰',
  sensenova: '商汤日日新',
  openai: 'OpenAI',
  claude: 'Claude',
  gemini: 'Gemini',
  groq: 'Groq',
  mistral: 'Mistral AI',
  perplexity: 'Perplexity',
  together: 'Together AI',
  deepinfra: 'DeepInfra',
  custom: '自定义',
};

const STATUS_META: Record<string, { dot: string; text: string }> = {
  ok: { dot: 'dot-green', text: '连通正常' },
  failed: { dot: 'dot-red', text: '连通失败' },
  untested: { dot: 'dot-amber', text: '未测试' },
};

// 功能路由：默认档位说明（analysis-8 §3.2 小模型打分、大模型生成）
const FN_META: Record<LlmFunction, { name: string; tier: string; desc: string; overridable: boolean }> = {
  scoring: { name: '选题打分', tier: '便宜小模型', desc: '高频调用，用便宜模型控成本；要求支持 JSON 输出', overridable: true },
  generation: { name: '内容生成', tier: '强模型', desc: '各平台变体生成，质量优先，用旗舰模型', overridable: true },
  advisor: { name: '智囊团会诊', tier: '强模型', desc: '12 人物多视角推理，低频高价值', overridable: true },
  compliance: { name: '合规复检', tier: '跟随生成', desc: '并入生成调用；出口过滤始终由平台侧执行', overridable: false },
  chat: { name: 'AI 助手对话', tier: '中档模型', desc: '交互式问答，平衡延迟与质量', overridable: true },
  diagnosis: { name: '算法教练诊断/优化', tier: '中档模型', desc: '创作工坊实时诊断的 LLM 优化与教练点评', overridable: true },
  video: { name: '视频理解', tier: '仅火山方舟', desc: '视频拆解只走你自己的豆包渠道（平台不垫付：一次视频抵几十次文本）', overridable: true },
  image: { name: '封面生图', tier: '火山方舟即梦', desc: '小红书 AI 封面走即梦 Seedream，默认复用你的豆包渠道；如需指定即梦模型可路由到此', overridable: true },
};

type SettingsQuery = { wx_bind?: string; wx_bind_error?: string };

export default async function SettingsPage(props: { searchParams: Promise<SettingsQuery> }) {
  const s = await getSession();
  const searchParams = await props.searchParams;
  const [providers, board, workspace, jobRuns, ingestTokens] = await Promise.all([
    prisma.modelProvider.findMany({ where: { tenantId: s.tenantId }, orderBy: { createdAt: 'asc' } }),
    sourceHealthBoard(),
    prisma.workspace.findUnique({ where: { id: s.workspaceId }, select: { ingestToken: true, automationConfig: true } }),
    prisma.jobRun.findMany({
      where: { name: { in: AUTOMATION_ITEMS.map((i) => i.job).filter((j): j is NonNullable<typeof j> => j !== null) } },
      orderBy: { id: 'desc' },
      take: 40,
      select: { name: true, status: true, detail: true, finishedAt: true, startedAt: true },
    }),
    listIngestTokens(s.workspaceId),
  ]);

  const embed = embedderInfo(); // 语义向量实况（真模型 / 哈希近似），用于「降级说破」

  // 每个任务的最近一次运行（按 id 降序取首个命中）
  const lastRuns: Record<string, LastRun> = {};
  for (const r of jobRuns) {
    if (lastRuns[r.name]) continue;
    lastRuns[r.name] = { status: r.status, detail: r.detail, at: (r.finishedAt ?? r.startedAt).toISOString() };
  }
  const automationConfig = readAutomationConfig(workspace?.automationConfig);

  const okCount = providers.filter((p) => p.status === 'ok').length;
  const overseasCount = providers.filter((p) => p.region === 'overseas').length;

  // 功能路由现状：找到 routing[fn]===p.id 的渠道
  const routeOf = (fn: LlmFunction): string => {
    for (const p of providers) {
      const routing = parseJson<Record<string, string>>(p.routing, {});
      if (routing[fn] === p.id) return p.label;
    }
    const def = providers.find((p) => p.isDefault);
    return def ? `${def.label}（默认）` : '平台托管默认';
  };

  return (
    <>
      <PageHead
        title="模型接入与设置"
        desc="自备模型 Key（BYOK）——用你自己的 AI 账号，平台只收工具钱 · 国内已备案模型全版本可用，海外模型仅限企业版出海场景"
      />

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="已配置渠道" value={providers.length} foot="租户自带 Key" />
        <Stat label="连通正常" value={okCount} foot="通过连通性测试" />
        <Stat label="海外渠道" value={overseasCount} foot="限企业版·出海" />
        <Stat label="计费模式" value="0 加价" foot="模型花费走你自己的账号" />
      </div>

      <Card
        title="模型配置中心（BYOK）"
        sub="加密存储 · 只写不读 · 保存即测试"
        style={{ marginBottom: 16 }}
        action={<span className="badge badge-brand"><Icon.cpu size={13} /> OpenAI 兼容协议</span>}
      >
        {providers.length === 0 ? (
          <Empty icon="🔌" text="还没有配置模型渠道，用下方表单添加你的第一把 Key" />
        ) : (
          <div className="stack" style={{ gap: 12, marginBottom: 18 }}>
            {providers.map((p) => {
              const st = STATUS_META[p.status] ?? STATUS_META.untested;
              const masked = maskKey(decryptKey(p.apiKeyEnc));
              return (
                <div key={p.id} className="card" style={{ padding: 14, boxShadow: 'none', background: 'var(--surface-2)' }}>
                  <div className="row-between wrap" style={{ gap: 10 }}>
                    <div className="row wrap" style={{ gap: 10, alignItems: 'center' }}>
                      <b>{p.label}</b>
                      <span className="badge badge-gray">{VENDOR_LABEL[p.vendor] ?? p.vendor}</span>
                      {p.region === 'overseas'
                        ? <span className="badge badge-amber">海外·限企业版</span>
                        : <span className="badge badge-green">国内已备案</span>}
                      {p.isDefault && <span className="badge badge-brand">默认</span>}
                      <span className="row" style={{ gap: 5, alignItems: 'center' }}>
                        <span className={`dot ${st.dot}`} />
                        <span className="small muted">{st.text}</span>
                      </span>
                    </div>
                  </div>
                  <div className="wrap small muted mono" style={{ gap: 14, margin: '8px 0 10px' }}>
                    <span>模型 {p.model}</span>
                    <span>Key {masked}</span>
                    <span>{p.baseUrl}</span>
                  </div>
                  <ProviderRow id={p.id} isDefault={p.isDefault} />
                </div>
              );
            })}
          </div>
        )}

        <div className="divider" />
        <div className="card-title" style={{ margin: '4px 0 12px' }}>添加渠道 <span className="card-sub">从白名单供应商选择</span></div>
        <ProviderForm />
      </Card>

      <div className="grid grid-2" style={{ marginBottom: 16 }}>
        <Card title="按功能路由" sub="打分用便宜的，写稿用好的">
          <p className="small muted" style={{ marginBottom: 12 }}>
            可为 {LLM_FUNCTIONS.length} 类功能分别指定模型：高频打分走便宜小模型控成本，内容生成走强模型保质量。未指定的功能走默认渠道或平台托管。
          </p>
          <div className="stack" style={{ gap: 8 }}>
            {LLM_FUNCTIONS.map((fn) => {
              const m = FN_META[fn];
              return (
                <div key={fn} className="row-between wrap" style={{ gap: 8, padding: '8px 0', borderTop: '1px solid var(--surface-2)' }}>
                  <div style={{ flex: 1, minWidth: 180 }}>
                    <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                      <b className="small">{m.name}</b>
                      <span className="badge badge-gray">{m.tier}</span>
                      {!m.overridable && <span className="badge badge-amber">不可覆盖</span>}
                    </div>
                    <div className="small muted" style={{ marginTop: 3 }}>{m.desc}</div>
                  </div>
                  <span className="small mono">{routeOf(fn)}</span>
                </div>
              );
            })}
          </div>
        </Card>

        <Card title="合规边界" sub="用自己的 Key，不等于平台不管合规">
          <div className="stack" style={{ gap: 10 }}>
            <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
              <Icon.shield size={16} className="" />
              <span className="small">
                <b>国内公开发布的内容，默认用已备案模型。</b>面向境内公众提供 AI 生成服务的责任方始终是烽火台，不因 Key 是谁的而改变。
              </span>
            </div>
            <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
              <Icon.x size={16} className="" />
              <span className="small">
                <b>海外模型只开放给企业版的出海内容场景。</b>数据出境前需先完成合规审查与脱敏；Key 是否有效、供应商条款怎么约定，由你自己负责。
              </span>
            </div>
            <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
              <Icon.check size={16} className="" />
              <span className="small">
                <b>内容离开平台前，永远先过合规检测。</b>红线词库 + AI 二次复核 + AIGC 标识 + 日志留存都在平台侧执行；自备 Key 只改变谁付模型的钱，不改变谁对发出去的内容负责。
              </span>
            </div>
            <div className="alert-gradient-amber" style={{ padding: '10px 14px', marginTop: 4 }}>
              <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                <span className="row" style={{ color: 'var(--amber)', flexShrink: 0 }}>
                  <Icon.shield size={16} />
                </span>
                <span className="small" style={{ opacity: 0.9 }}>
                  不支持自由填写任意中转地址接境外模型——那属于无资质 API 中转，产品层面不开放。
                </span>
              </div>
            </div>
          </div>
        </Card>
      </div>

      <Card
        title="🤖 自动化任务"
        sub="每日推荐 / 数据同步 / 自动复盘等定时任务的开关 · 可关可调可见"
        style={{ marginBottom: 16 }}
      >
        <AutomationCard config={automationConfig} lastRuns={lastRuns} />
      </Card>

      <Card title="数据源" sub="开源自建为主，商业 API 兜底，双源冗余">
        <div className="grid grid-2" style={{ gap: 16 }}>
          <div>
            <div className="card-title" style={{ marginBottom: 10 }}>热榜通道</div>
            <div className="stack" style={{ gap: 6 }}>
              {board.hot.map((h, i) => (
                <div key={i} className="row-between" style={{ padding: '6px 0' }}>
                  <span className="row" style={{ gap: 8, alignItems: 'center' }}>
                    <span className={`dot ${h.ok ? 'dot-green' : 'dot-red'}`} />
                    <span className="small">{h.name}</span>
                    <span className="badge badge-gray">{h.kind === 'mock' ? '兜底' : h.kind === 'opensource' ? '开源自建' : h.kind}</span>
                  </span>
                  <span className="small muted">{h.ok ? '健康' : '异常'}</span>
                </div>
              ))}
            </div>
            <p className="small muted" style={{ marginTop: 8 }}>主通道 DailyHotApi（开源自建），挂了会自动切到备用源，热榜不开天窗。</p>
          </div>
          <div>
            <div className="card-title" style={{ marginBottom: 10 }}>竞对采集通道</div>
            <div className="stack" style={{ gap: 6 }}>
              {board.competitor.map((c, i) => (
                <div key={i} className="row-between" style={{ padding: '6px 0' }}>
                  <span className="row" style={{ gap: 8, alignItems: 'center' }}>
                    <span className={`dot ${c.kind === 'mock' ? 'dot-amber' : 'dot-green'}`} />
                    <span className="small">{c.name}</span>
                    <span className="badge badge-gray">{c.platform}</span>
                  </span>
                  <span className="small muted">{c.kind === 'mock' ? 'Mock 待接入' : c.kind}</span>
                </div>
              ))}
            </div>
            <p className="small muted" style={{ marginTop: 8 }}>正式环境按平台接入商业数据源（TikHub/新榜/官方 API）或你的授权；还没配 Key 时先用示例数据把流程跑通，页面上会明确标注。</p>
          </div>
        </div>
        <div className="divider" style={{ margin: '14px 0' }} />
        {/* 语义向量的实况：降级必须说破。跑在哈希近似上时，
            语义召回/话题聚类/选题粗排都还能跑，但「相近」的判据是字面重合而非语义。 */}
        <div className="row-between" style={{ padding: '2px 0 8px' }}>
          <span className="row" style={{ gap: 8, alignItems: 'center' }}>
            <span className={`dot ${embed.mocked ? 'dot-amber' : 'dot-green'}`} />
            <span className="small">语义向量（记忆召回 / 话题聚类 / 选题粗排）</span>
            <span className="badge badge-gray">{embed.mocked ? '哈希近似' : embed.model}</span>
          </span>
          <span className="small muted">
            {embed.mocked ? '未配嵌入模型，按字面相似度近似' : '真实嵌入模型'}
          </span>
        </div>
        <div className="divider" style={{ margin: '14px 0' }} />
        <div className="card-title" style={{ marginBottom: 6 }}>
          插件采集令牌 <span className="card-sub">浏览器插件 · 你浏览竞对公开主页时顺手回传</span>
        </div>
        <p className="small muted" style={{ marginBottom: 10, lineHeight: 1.7 }}>
          <a href="/extension" style={{ color: 'var(--brand)', fontWeight: 600 }}>下载并安装「烽火台采集助手」浏览器插件 →</a>
          （支持 Chrome / Edge / 360 / Brave），把下方令牌填入插件设置。你打开<b>已订阅竞对</b>的公开主页时，
          插件可把页面上你亲眼可见的公开数据（作品列表/粉丝数）一键回传补充到竞对档案——抖音/小红书在未接商业数据源时，这是唯一合规的指标来源。
        </p>
        <IngestTokenCard active={ingestTokens.active} revoked={ingestTokens.revoked} legacyToken={workspace?.ingestToken ?? null} />
        <div className="divider" style={{ margin: '14px 0' }} />
        <p className="small muted" style={{ lineHeight: 1.7 }}>
          <b>数据来源透明披露：</b>竞对监控仅采集各平台已公开发布的账号与作品信息，不获取任何非公开数据、不托管平台凭证。
          若你是被监控账号主体，可
          <a href="/legal/data-request" target="_blank" style={{ color: 'var(--brand)', fontWeight: 600 }}>申请移除监控 →</a>
        </p>
      </Card>
    </>
  );
}
