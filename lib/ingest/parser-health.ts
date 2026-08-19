import { sendOpsAlert } from '../ops/alert';

// ── 解析健康度：让「插件悄悄降级」和「粉丝数悄悄采错」变成看得见的事 ──────────────
//
// 【为什么需要这一层】2026-08-07 抖音：`data-e2e="user-fans"` 被平台改成了 `user-info-fans`。
// 插件**自修复成功了**（退到文本锚点，数字一个不差），但没有任何人知道它降级了——
// 而同一次降级如果落在别的页面结构上，取出来的就会是旁边那个「关注数」：
// 一个看着完全正常、实际差三个数量级的数字。
//
// 所以这套设计的两句话是：
//   ① **自修复必须配自曝光**：能修回来是好事，但「修没修、修对没修对」必须留痕；
//   ② **量级突变一律不覆盖**：粉丝数不会一夜之间差一百倍，会差一百倍的只有解析错误。
//
// 两件事都挂在已有的 lib/ops/alert.ts 上（同指纹 10 分钟冷却 + 每小时封顶 12 条），
// 不新加表、不新加 cron —— 冷却机制本身就替代了「先聚合再判断」那一整套东西。

/** 粉丝数是**怎么**读到的。插件解析器随回传上行（extension/content/*.js）。 */
export const FOLLOWERS_VIA = ['json', 'href', 'e2e', 'text', 'none'] as const;
export type FollowersVia = (typeof FOLLOWERS_VIA)[number];

// 越大越可信：
//   json = 读页面自带的数据状态（TikTok），精确整数，完全不受 DOM 改版影响；
//   href = 链接地址语义（X 的 /followers），是产品路径不是样式，几乎不变；
//   e2e  = 平台埋点，改版会失效但结构明确；
//   text = 文本锚点兜底（「粉丝」二字 + 就近数字），永远能用，但要靠闸挡串台；
//   none = 没读到。
const VIA_RANK: Record<FollowersVia, number> = { json: 4, href: 3, e2e: 2, text: 1, none: 0 };

// 每个平台「正常情况下应该走到的最好来源」。**比它差才叫降级**。
//
// ⚠️ 绝不能写成「via=text 就告警」：B站 / 小红书 / YouTube 本来就没有稳定埋点，
// 它们的正常值就是 text，那样每采一次响一次——告警一吵就会被关掉，
// 然后真出事的那次也没人看见（告警系统最常见的死法）。
const EXPECTED_VIA: Record<string, FollowersVia> = {
  douyin: 'e2e',
  tiktok: 'json',
  x: 'href',
  bilibili: 'text',
  xiaohongshu: 'text',
  youtube: 'text',
};

/**
 * 量级闸：新旧粉丝数差到这个倍数就不认。
 *
 * 100 倍是按**真实事故**定的：抖音那次「关注 178 / 粉丝 328.3万」取错是 1.8 万倍，
 * B站/小红书的 replace 坑同一量级。而真实增长——哪怕一条爆款带来的——不会到两位数倍率。
 */
const FOLLOWERS_JUMP_LIMIT = 100;

/**
 * 小号不设闸：50 粉涨到 6000 粉（120 倍）对一个刚起步的号是可能的，
 * 而它恰好落在闸的量程里。大号（≥1000）涨 100 倍则一定是解析错了。
 * 暴**跌** 100 倍不分大小号一律拦——那是「把关注数当粉丝数」的典型形状，没有真实对应物。
 */
const FOLLOWERS_GUARD_FLOOR = 1000;

export type FollowersCheck = {
  /** 这个新值能不能写进库 */
  accept: boolean;
  /** 落进 CollectionRun.note 的一句话（正常时 null）。台账是给人看的，要写成人话。 */
  note: string | null;
};

/** 量级闸判定。prev 为 null（第一次采）时一律放行——没有可比的基准，拦了就永远建不了档。 */
export function followersJumpRejected(prev: number | null | undefined, next: number): boolean {
  if (prev == null || prev <= 0 || next <= 0) return false;
  if (next < prev && prev / next >= FOLLOWERS_JUMP_LIMIT) return true; // 暴跌：一律拦
  if (next > prev && prev >= FOLLOWERS_GUARD_FLOOR && next / prev >= FOLLOWERS_JUMP_LIMIT) return true;
  return false;
}

const fmt = (n: number) => (n >= 10000 ? `${(n / 10000).toFixed(1)}万` : String(n));

/**
 * 检查一次粉丝数回传，并在需要时告警。
 *
 * **绝不抛错**：这是旁路。健康度检查自己出问题不能连累正在入库的真实数据
 *（同 lib/ops/alert.ts 的第三条硬规矩）。
 */
export async function checkFollowers(params: {
  platform: string;
  scope: 'rival' | 'self';
  targetName: string;
  via?: FollowersVia | null;
  prev?: number | null;
  next?: number | null;
}): Promise<FollowersCheck> {
  try {
    const { platform, scope, targetName, next } = params;
    const via = (params.via ?? null) as FollowersVia | null;
    const prev = params.prev ?? null;
    const notes: string[] = [];

    // ① 降级留痕：这个数是不是靠兜底读出来的
    const expected = EXPECTED_VIA[platform];
    if (via && expected && VIA_RANK[via] < VIA_RANK[expected]) {
      const degraded = `${platform} 粉丝数走的是「${via}」而不是预期的「${expected}」`;
      notes.push(via === 'none' ? '没读到粉丝数（页面结构可能已变）' : '粉丝数靠兜底锚点读出（埋点可能已失效）');
      // 指纹按 平台+来源 分：抖音掉到 text 与掉到 none 是两件事，别互相把对方的冷却吃掉
      await sendOpsAlert({
        level: via === 'none' ? 'warn' : 'info',
        title: '插件解析降级',
        lines: [
          degraded,
          `账号：${targetName}（${scope === 'rival' ? '竞对' : '自有'}）`,
          via === 'none'
            ? '→ 该平台解析器已经读不到粉丝数，多半是页面结构改了，需要真机核对'
            : '→ 数字仍然读得到（文本锚点兜住了），但埋点该更新了：extension/content/ 对应解析器',
        ],
        fingerprint: `parser-degraded:${platform}:${via}`,
      });
    }

    // ② 量级闸
    if (next != null && followersJumpRejected(prev, next)) {
      notes.push(`粉丝数从 ${fmt(prev!)} 跳到 ${fmt(next)}，量级不合理，本次不覆盖`);
      await sendOpsAlert({
        level: 'error',
        title: '粉丝数量级突变，已拒绝写入',
        lines: [
          `${platform} · ${targetName}（${scope === 'rival' ? '竞对' : '自有'}）`,
          `库里 ${fmt(prev!)} → 本次回传 ${fmt(next)}`,
          `读取来源：${via ?? '未知'}`,
          '→ 十有八九是解析取错了旁边那个数字（关注数/获赞数）。库里的值保持不变，请真机核对解析器。',
        ],
        fingerprint: `followers-jump:${platform}:${targetName}`,
      });
      return { accept: false, note: notes.join('；') };
    }

    return { accept: true, note: notes.length ? notes.join('；') : null };
  } catch {
    // 旁路失败一律放行：宁可少一条告警，也不能因为告警链路把入库拦下来
    return { accept: true, note: null };
  }
}
