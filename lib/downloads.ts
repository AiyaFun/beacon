// 「烽火台采集助手」浏览器插件的分发地址——单一事实来源。
//
// 分发策略（用户已定，2026-07-28 收窄；2026-07-30 上架后再次明确）：**只提交 Chrome 应用商店审核**，
// 且上架之后**两条通道长期并存**：
//   - 商店版：审核通过的那一版，自动更新、装起来一键。但审核有周期，
//     它**天然会落后于自托管的最新版**（新平台适配、真机修的选择器往往先进 zip）。
//   - 自托管 zip：`npm run pack:ext` 的产出，永远是最新版，走开发者模式加载。
//   两者不是「主/备」而是「稳 / 新」——页面必须把这个差别说清楚，让用户自己选，
//   不能因为上架了就把 zip 入口藏起来（那会让真机校准、急修的版本发不出去）。
//   - Edge / 360 / Brave 等其它 Chromium：**不提交它们各自的商店**（Edge Addons / 360 应用市场都要
//     单独注册开发者、单独走审核，成本不对等）。这些卡片一律走 zip 开发者模式加载，
//     **绝不能显示「商店审核中」**——那会让用户以为等几天就能一键装，其实永远等不到。
//   - 兜底：自托管 zip（public/downloads/，`npm run pack:ext` 产出）+「加载已解压」图文。
//     用于内测/商店审核期/企业内网，不依赖商店。
//   - Safari：本期不支持——它必须走 Apple 开发者签名 + App Store，无法用 crx/zip 直装，
//     页面如实标注「即将支持」。
//
// 链接为什么写死在代码里而不是只靠 env：2026-07-30 已上架，详情页 URL 是**公开且稳定**的常量，
// 写死才不会因为某台机器漏配 env 就退回「审核中」的假状态（那是上架前的历史遗留）。
// env `BEACON_EXT_STORE_CHROME` 仍可覆盖（换 item id / 临时下架时用）。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ── 商店正式链接 ──
// 只有 chrome 一个渠道：其余商店不提交，留着空字段只会让页面误显示「审核中」。
export type StoreChannel = 'chrome';

/** Chrome 应用商店详情页（2026-07-30 上架）。不带 authuser/hl 等会话参数——那是复制链接时带出来的私人参数。 */
export const CHROME_STORE_URL =
  'https://chromewebstore.google.com/detail/%E7%83%BD%E7%81%AB%E5%8F%B0%E9%87%87%E9%9B%86%E5%8A%A9%E6%89%8B/fadbnimlnjgicmhhemkgfalbgfopljid';

export function storeLinks(): Record<StoreChannel, string> {
  const raw = process.env.BEACON_EXT_STORE_CHROME?.trim();
  // 显式关掉商店入口（临时下架/审核被撤时用）：填 off/none。
  // 留空 ≠ 关闭——留空是「没配」，那时应该用代码里的正式链接，而不是退回「审核中」的旧状态。
  if (raw === 'off' || raw === 'none') return { chrome: '' };
  return { chrome: raw || CHROME_STORE_URL };
}

/**
 * 商店在架版本号（可选）。填了才敢在页面上把「商店版 vX」和「最新版 vY」并排写；
 * 没填就只说「以商店页面为准」——**绝不猜**：猜错会让用户以为自己装的是最新的。
 * 每次商店审核通过后由运维更新这一个 env（`BEACON_EXT_STORE_CHROME_VERSION="0.6.4"`）。
 */
export function storeVersion(): string | null {
  return process.env.BEACON_EXT_STORE_CHROME_VERSION?.trim() || null;
}

/** 商店版是否落后于自托管最新版。两边任一未知 → null（不下结论）。 */
export function storeIsBehind(latestVersion: string | null | undefined): boolean | null {
  const sv = storeVersion();
  if (!sv || !latestVersion) return null;
  return compareVersion(sv, latestVersion) < 0;
}

/** 语义化版本粗比较：只按数字段逐位比，非数字段忽略（够用于 0.6.4 / 0.7.0 这种）。 */
export function compareVersion(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

// ── 自托管 zip 清单（pack:ext 产出的 downloads.manifest.json）──
export type DownloadsManifest = {
  name: string;
  version: string;
  zip: string; // 版本化文件路径 /downloads/beacon-collector-<ver>.zip
  latest: string; // 稳定别名 /downloads/beacon-collector-latest.zip
  sizeKB: number;
  sha256: string;
};

// 读打包清单；还没打过包（文件不存在）时返回 null，页面据此隐藏自托管下载区、只留商店/开发者引导。
export function readDownloadsManifest(): DownloadsManifest | null {
  try {
    const raw = readFileSync(join(process.cwd(), 'public', 'downloads', 'downloads.manifest.json'), 'utf8');
    const m = JSON.parse(raw) as DownloadsManifest;
    if (!m.version || !m.latest) return null;
    return m;
  } catch {
    return null;
  }
}

// ── 浏览器卡片元数据（下载页 + 三处触点复用）──
export type BrowserInstall = 'store' | 'unpacked' | 'coming';
export type BrowserCard = {
  key: string;
  name: string;
  emoji: string;
  engine: string; // 内核，用于说明「同一个包」
  install: BrowserInstall; // store=走商店（只有 Chrome）/ unpacked=开发者模式加载 / coming=即将支持
  store?: StoreChannel; // 仅 install='store' 时有意义：我们真的提交了审核的那个商店
  /** 该浏览器能否直接安装 Chrome 应用商店里的同一款（作为次选入口展示） */
  chromeStoreOk?: boolean;
  note: string;
};

// Chrome/Edge/360/Brave 同为 Chromium 内核，同一个 MV3 包通用。
// **只有 Chrome 一张卡是 install='store'**——它是我们唯一提交审核的商店；其余一律 unpacked，
// 免得页面对着一个永远不会提交的商店显示「审核中」。Safari 是独立轨道。
export const BROWSER_CARDS: BrowserCard[] = [
  {
    key: 'chrome',
    name: 'Google Chrome',
    emoji: '🌐',
    engine: 'Chromium',
    install: 'store',
    store: 'chrome',
    note: '两种都行：商店版一键装、自动更新（版本随审核，略滞后）；zip 版永远是最新版，走开发者模式加载。',
  },
  {
    key: 'edge',
    name: 'Microsoft Edge',
    emoji: '🧭',
    engine: 'Chromium',
    install: 'unpacked',
    chromeStoreOk: true,
    note: '不单独上架 Edge Addons。可在 Edge 里打开 Chrome 应用商店、允许「来自其他应用商店的扩展」后装同一款；或用 zip 开发者模式加载（最新版）。',
  },
  {
    key: 'threesixty',
    name: '360 浏览器',
    emoji: '🛡️',
    engine: 'Chromium',
    install: 'unpacked',
    note: '不单独上架 360 应用市场。360 极速版/安全浏览器同为 Chromium，用下方 zip 走扩展中心的开发者模式加载即可。',
  },
  {
    key: 'brave',
    name: 'Brave / 其它 Chromium',
    emoji: '🦁',
    engine: 'Chromium',
    install: 'unpacked',
    chromeStoreOk: true,
    note: 'Brave、Vivaldi、QQ 浏览器等 Chromium 系：装 Chrome 应用商店版，或用下方 zip 加载已解压。',
  },
  {
    key: 'safari',
    name: 'Safari',
    emoji: '🧊',
    engine: 'WebKit',
    install: 'coming',
    note: '即将支持：Safari 扩展需经 Apple 开发者签名并上架 App Store，正在制作独立版本，暂无法直装。',
  },
];
