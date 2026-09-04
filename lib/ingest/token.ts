import crypto from 'node:crypto';
import { prisma } from '../db';
import { parseJson } from '../json';
import { BROWSER_TASK_KINDS } from '../browser-task/kinds';
import { log } from '../logger';

// 插件采集令牌：签发 / 列举 / 吊销 / 鉴权解析。
//
// 【这一层存在的理由】此前令牌是 `Workspace.ingestToken` 上的**一个字段**——整个工作区共用一串。
// 于是「吊销」只有全有或全无两档：成员离职、某台电脑丢了、只想收回自己那一台，全都做不到，
// 唯一的手段是把整个工作区的采集一起掐掉（连还在正常用的同事一起）。
// 2026-07-30 用户注销账号后插件仍在采，暴露的就是这个形状的问题。
//
// 现在每台设备一枚（IngestToken 一行），可以逐枚吊销；签发人记在 memberId 上，
// **成员被删除时数据库外键级联带走他名下的全部令牌**——这一条刻意不放在应用层，
// 因为「记得去删」这种约定迟早会漏，而漏掉的后果是「人已经离开，他那台电脑还在往里写」。
//
// 旧的 Workspace.ingestToken 仍然认（见 resolveIngestToken 的兜底分支）：存量用户的插件里
// 装的就是那一串，改成只认新表 = 所有已装插件在部署那一刻集体失效。

export function generateIngestToken(): string {
  return `bcn_${crypto.randomBytes(24).toString('hex')}`;
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// lastUsedAt 的写入节流。它只用来在界面上回答「这台设备还在用吗」，精确到分钟毫无意义；
// 而不节流就是给**每一条采集回传**平白加一次写库。
const TOUCH_INTERVAL_MS = 10 * 60 * 1000;

// 单个工作区的有效令牌上限。够用即可，主要作用是给「反复点一键配置」封顶——
// 超出时吊销最老的那枚，而不是拒绝签发（拒绝会让用户以为插件坏了）。
const MAX_ACTIVE = 20;

/** 按 User-Agent 生成设备标签。认不出来不猜，返回通用名——猜错的标签比没有标签更误导。 */
/**
 * 桌面客户端登记为执行器时的标签前缀（2026-09-04）。
 *
 * 【为什么用标签前缀而不是加一列】区分「插件」还是「桌面客户端」只影响**措辞**：
 * 派活回执说「已排给插件」还是「已排给你的桌面客户端」。真机原话：「但是我没安装插件」——
 * 他登记的是客户端，系统却把所有执行器都叫插件。能力仍由执行器领活时自报（kinds），
 * 这个前缀只由服务端在签发时写，客户端只能说「我是桌面壳」，说谎的代价是回执用词不对，没别的。
 */
export const DESKTOP_LABEL_PREFIX = '桌面客户端 · ';
export function isDesktopExecutorLabel(label: string | null | undefined): boolean {
  return String(label ?? '').startsWith(DESKTOP_LABEL_PREFIX);
}

export function deviceLabelFromUA(ua: string | null | undefined): string {
  const s = String(ua || '');
  if (!s) return '浏览器插件';
  const browser =
    /Edg\//.test(s) ? 'Edge'
    : /OPR\//.test(s) ? 'Opera'
    : /Firefox\//.test(s) ? 'Firefox'
    : /QIHU|360SE|360EE/.test(s) ? '360 浏览器'
    // Chrome 要放在 Safari 之后判断的反面：Chrome 的 UA 里也有 Safari 字样，所以先判 Chrome
    : /Chrome\//.test(s) ? 'Chrome'
    : /Safari\//.test(s) ? 'Safari'
    : '';
  const os =
    /Windows/.test(s) ? 'Windows'
    : /Mac OS X|Macintosh/.test(s) ? 'macOS'
    : /Android/.test(s) ? 'Android'
    : /iPhone|iPad|iOS/.test(s) ? 'iOS'
    : /Linux/.test(s) ? 'Linux'
    : '';
  if (browser && os) return `${browser} · ${os}`;
  return browser || os || '浏览器插件';
}

export type IngestTokenRow = {
  id: string;
  token: string;
  label: string;
  memberName: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  revokedNote: string | null;
};

/**
 * 签发一枚。
 *
 * 默认**复用**同一个人在同一种设备上已有的那一枚：现实里「一键配置」会被点很多次
 * （换个页面又点一下），每次都发新的只会攒出一屏分不清谁是谁的令牌。
 * 真要另发一枚（同一台机器上的两个浏览器配置）传 force。
 */
export async function issueIngestToken(opts: {
  workspaceId: string;
  memberId: string | null;
  label: string;
  force?: boolean;
}): Promise<{ id: string; token: string; label: string; reused: boolean }> {
  const label = opts.label.trim().slice(0, 60) || '浏览器插件';

  if (!opts.force) {
    const existing = await prisma.ingestToken.findFirst({
      where: { workspaceId: opts.workspaceId, memberId: opts.memberId, label, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) return { id: existing.id, token: existing.token, label: existing.label, reused: true };
  }

  const plainToken = generateIngestToken();
  const created = await prisma.ingestToken.create({
    data: {
      workspaceId: opts.workspaceId,
      memberId: opts.memberId,
      label,
      token: plainToken,
      tokenHash: hashToken(plainToken),
    },
  });

  // 封顶：超出的从最老的开始吊销。拒绝签发会让用户以为插件坏了，静默无上限则会攒到看不懂。
  const active = await prisma.ingestToken.findMany({
    where: { workspaceId: opts.workspaceId, revokedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  if (active.length > MAX_ACTIVE) {
    const stale = active.slice(MAX_ACTIVE).map((t) => t.id);
    await prisma.ingestToken.updateMany({
      where: { id: { in: stale } },
      data: { revokedAt: new Date(), revokedNote: `超出 ${MAX_ACTIVE} 枚上限，自动吊销最早的` },
    });
    log.info('采集令牌超出上限，自动吊销最早的几枚', { workspaceId: opts.workspaceId, count: stale.length });
  }

  return { id: created.id, token: created.token, label: created.label, reused: false };
}

/** 列出本工作区的令牌：有效的全给，已吊销的只给最近几条（够回答「什么时候收回的」即可）。 */
export async function listIngestTokens(workspaceId: string): Promise<{
  active: IngestTokenRow[];
  revoked: IngestTokenRow[];
}> {
  const rows = await prisma.ingestToken.findMany({
    where: { workspaceId },
    orderBy: [{ revokedAt: 'asc' }, { createdAt: 'desc' }],
    include: { member: { select: { name: true } } },
  });
  const map = (r: (typeof rows)[number]): IngestTokenRow => ({
    id: r.id,
    token: r.token,
    label: r.label,
    memberName: r.member?.name ?? null,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
    revokedAt: r.revokedAt,
    revokedNote: r.revokedNote,
  });
  return {
    active: rows.filter((r) => !r.revokedAt).map(map),
    revoked: rows.filter((r) => r.revokedAt).slice(0, 5).map(map),
  };
}

/** 吊销一枚。**必须带 workspaceId 一起 where**——只按 id 删就是一个 IDOR。 */
export async function revokeIngestToken(workspaceId: string, id: string, note?: string) {
  const r = await prisma.ingestToken.updateMany({
    where: { id, workspaceId, revokedAt: null },
    data: { revokedAt: new Date(), revokedNote: note ?? null },
  });
  return { ok: r.count > 0 };
}

/** 全部吊销 + 清掉旧的工作区级令牌。「停用采集」这个动作要真的一枚不剩。 */
export async function revokeAllIngestTokens(workspaceId: string, note?: string) {
  const r = await prisma.ingestToken.updateMany({
    where: { workspaceId, revokedAt: null },
    data: { revokedAt: new Date(), revokedNote: note ?? null },
  });
  // 旧字段也要清：只清新表的话，装着旧令牌的插件照采不误——那才是最难查的那种「停用了但没停」
  await prisma.workspace.updateMany({ where: { id: workspaceId, NOT: { ingestToken: null } }, data: { ingestToken: null } });
  return { revoked: r.count };
}

/**
 * 鉴权解析：令牌串 → 工作区。所有 /api/ingest/* 都经这里。
 *
 * 两条路，顺序不能反：
 *   ① 新表 —— 命中即判定，**已吊销的直接拒**（不许再往下走兜底，否则吊销形同虚设）；
 *   ② 旧的 Workspace.ingestToken —— 存量用户插件里装的就是这一串。删掉这条兜底 =
 *      部署那一刻所有已装插件集体失效。等界面上的「旧版令牌」都迁完再摘。
 */
/** 执行器自报的能力头：逗号分隔的 kind 列表。只认白名单里的 kind，别的一律丢。 */
export const INGEST_KINDS_HEADER = 'x-beacon-ingest-kinds';
export function parseKindsHeader(raw: string | null | undefined): string[] | null {
  if (raw == null) return null;
  const ks = String(raw).split(',').map((s) => s.trim()).filter((k) => (BROWSER_TASK_KINDS as readonly string[]).includes(k));
  return Array.from(new Set(ks)).sort();
}

export async function resolveIngestToken(raw: string | null | undefined, opts: { kinds?: string | null } = {}) {
  const t = raw?.trim();
  if (!t) return null;

  // 优先按哈希查（新签发的令牌走这条路），数据库泄露时攻击者拿不到明文
  const h = hashToken(t);
  let row = await prisma.ingestToken.findUnique({
    where: { tokenHash: h },
    include: { workspace: true },
  });
  // 兜底：存量令牌没有 tokenHash，仍按明文匹配（迁移完成后可删此分支）
  if (!row) {
    row = await prisma.ingestToken.findUnique({
      where: { token: t },
      include: { workspace: true },
    });
  }
  if (row) {
    if (row.revokedAt) return null;
    await touch(row, opts.kinds);
    return { workspace: row.workspace, tokenId: row.id, legacy: false, kinds: parseJson<string[]>(row.kinds ?? 'null', null as unknown as string[]) ?? null };
  }

  const ws = await prisma.workspace.findUnique({ where: { ingestToken: t } });
  return ws ? { workspace: ws, tokenId: null, legacy: true } : null;
}

async function touch(row: { id: string; lastUsedAt: Date | null; kinds: string | null }, kindsHeader?: string | null) {
  // 能力变了（插件更新了、或第一次自报）必须立刻写，不受节流管：派活那道闸读的就是这一列
  const ks = parseKindsHeader(kindsHeader);
  const kindsJson = ks ? JSON.stringify(ks) : null;
  const kindsChanged = kindsJson != null && kindsJson !== row.kinds;
  if (!kindsChanged && row.lastUsedAt && Date.now() - row.lastUsedAt.getTime() < TOUCH_INTERVAL_MS) return;
  // 失败不影响鉴权本身：lastUsedAt 只是界面上的一个说明字段
  await prisma.ingestToken.update({
    where: { id: row.id },
    data: { lastUsedAt: new Date(), ...(kindsChanged ? { kinds: kindsJson } : {}) },
  }).catch(() => {});
}
