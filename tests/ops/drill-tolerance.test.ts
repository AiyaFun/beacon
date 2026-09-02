import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { between, orderedBefore } from '../helpers/anchor';

// 恢复演练的行数对账：严一处、松一处。
//
// 【为什么要松】基准是在 pg_dump **之后**记的（backup.sh 的次序），而热榜、话题簇这些
// 全局表在那几十秒里一直被 cron 写入和清理。于是每周都会冒出一两张表差几行——
// 2026-08-23 就是 HotItem 1907→1913 让整场演练判红。
// **一个每周都喊狼来了的守卫，最后只会被无视**，那时它就真的不设防了。
//
// 【为什么不能全松】这场演练存在的唯一理由是发现「RLS 静默过滤 → 备份是空壳」。
// 那种失败长这样：本来有数据的表还原后是 0，或少掉一大截。这两种一步都不能让。

const ROOT = path.resolve(__dirname, '../..');
const SRC = fs.readFileSync(path.join(ROOT, 'scripts/restore-drill.sh'), 'utf8');

/**
 * 把对账那一段抽出来单独跑：喂一份基准和一份「还原后」的行数，看它判红还是判绿。
 * 直接跑整个脚本要连库、要 docker，这里只验判据本身。
 */
function reconcile(
  baseline: Record<string, number>,
  restored: Record<string, number | null>,
  pre?: Record<string, number>,
): { ok: boolean; out: string } {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'drill-'));
  const countsFile = path.join(dir, 'b.counts');
  // `#pre 表=行数` = dump 之前的行数；不传就是老备份的样子（退回百分比容差）。
  const preLines = pre ? Object.entries(pre).map(([k, v]) => `#pre ${k}=${v}`) : [];
  fs.writeFileSync(
    countsFile,
    [...preLines, ...Object.entries(baseline).map(([k, v]) => `${k}=${v}`)].join('\n') + '\n',
  );
  const restoredLines = Object.entries(restored)
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${k}=${v}`).join('\n');

  // 从真脚本里原样抠出对账那一段——**不许在测试里手抄一份判据**，
  // 手抄的那份会跟脚本各走各的，而守卫看起来一直是绿的。
  //
  // 抠的范围：外层 `if [ -f "$COUNTS_FILE" ]` 开头 → 「全表一致」那行日志为止，
  // 后面补两个 fi 把内外两层都闭上（脚本里那两层之后是 else 分支，与判据无关）。
  const start = SRC.indexOf('if [ -f "$COUNTS_FILE" ]; then');
  expect(start, '对账段没抠到，脚本结构变了').toBeGreaterThan(-1);
  const tailMark = 'log "✅ 行数对账全表一致';
  const tail = SRC.indexOf(tailMark, start);
  expect(tail, '对账段的结尾没找到，脚本结构变了').toBeGreaterThan(start);
  const segment = SRC.slice(start, SRC.indexOf('\n', tail)) + '\n  fi\nfi\n';

  // 【防「抠了个空气还一直绿」】判据的三块必须都在抠出来的这一段里，
  // 否则下面所有用例都在跑一段残缺脚本，红绿都没有意义
  for (const must of ['TOL_PCT', '空壳', 'MISMATCH', 'PRE_COUNTS', '观测区间']) {
    expect(segment, `抠出来的片段里没有「${must}」，判据没抠全`).toContain(must);
  }

  // 【多行变量必须走 heredoc】写成 RESTORED_COUNTS="a\nb" 的话，bash 不解释 \n，
  // 变量里是字面的反斜杠 n，后面 sed 取出来的「行数」就变成 `52\nHotItem=1907`，
  // 算术判断当场语法错——而那会让每一条用例都红，看起来像判据坏了。
  const script = [
    'set -u',
    'die() { printf "DIE:%s\\n" "$*"; exit 9; }',
    'log() { printf "%s\\n" "$*"; }',
    `COUNTS_FILE=${JSON.stringify(countsFile)}`,
    "RESTORED_COUNTS=$(cat <<'__RC__'",
    restoredLines,
    '__RC__',
    ')',
    segment,
  ].join('\n');
  const runner = path.join(dir, 'run.sh');
  fs.writeFileSync(runner, script);
  try {
    const out = execFileSync('bash', [runner], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, out: (err.stdout ?? '') + (err.stderr ?? '') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('恢复演练的行数对账', () => {
  it('全表一致 → 通过', () => {
    const r = reconcile({ Tenant: 52, HotItem: 1907 }, { Tenant: 52, HotItem: 1907 });
    expect(r.ok).toBe(true);
  });

  it('cron 在备份期间写了几行 → 容差内放行，但要说破', () => {
    // 这就是 2026-08-23 那次：HotItem 1907 → 1913
    const r = reconcile({ Tenant: 52, HotItem: 1907 }, { Tenant: 52, HotItem: 1913 });
    expect(r.ok, '又把 cron 的正常写入判成了备份不可信').toBe(true);
    expect(r.out, '放行了却不说，下次没人知道漂移过').toMatch(/容差内|漂移/);
  });

  it('🔒 本来有数据、还原后一条不剩 → 判死（这就是 RLS 空壳的样子）', () => {
    const r = reconcile({ Tenant: 52, HotItem: 1907 }, { Tenant: 52, HotItem: 0 });
    expect(r.ok, '备份是空壳却判绿 —— 这场演练就白做了').toBe(false);
    expect(r.out).toMatch(/空壳/);
  });

  it('🔒 少掉一大截 → 判死', () => {
    const r = reconcile({ Tenant: 52, HotItem: 1907 }, { Tenant: 52, HotItem: 900 });
    expect(r.ok, '丢了一半数据还判绿').toBe(false);
  });

  it('🔒 整张表没了 → 判死', () => {
    const r = reconcile({ Tenant: 52, HotItem: 1907 }, { Tenant: 52, HotItem: null });
    expect(r.ok, '还原后缺表却判绿').toBe(false);
    expect(r.out).toMatch(/缺这张表/);
  });

  it('🔒 小表按绝对条数放行，不按百分比（不然 3→4 就是 33%）', () => {
    const r = reconcile({ Invite: 3 }, { Invite: 4 });
    expect(r.ok, '小表差一行就判红 —— 那还是每周喊狼来了').toBe(true);
  });

  // ── dump 前后两次计数（2026-09-01 加）────────────────────────────
  //
  // 【为什么加这一档】旧口径拿「dump 之后的行数」去对「dump 之刻的内容」，参照点就是错的。
  // 2026-08 五次演练四次判红，容差从全等放宽到 1% 也没收敛。有了 #pre，容差不再是猜的，
  // 而是这次备份**实际观测到的漂移**。

  it('🔒 2026-08-30 那次真实误报：现在必须放行', () => {
    // 真实数据：基准（dump 后）1808，还原出来 1827，差 19 超了 1% 的 18 → 判红。
    // dump 前是 1830（那几十秒里 cron 清掉了一批），1827 正落在 1808~1830 之间。
    const r = reconcile({ HotItem: 1808 }, { HotItem: 1827 }, { HotItem: 1830 });
    expect(r.ok, '把 cron 的正常写入又判成了备份不可信 —— 第五次喊狼来了').toBe(true);
    expect(r.out).toMatch(/观测区间/);
  });

  it('🔒 安静的表比旧口径更严：没漂移就不给 1% 的免费额度', () => {
    // 旧口径：allow = max(1808*1%, 5) = 18，差 19 才判红。
    // 新口径：dump 前后都是 1808 = 这张表根本没人写，凭什么少 12 行还算正常。
    const r = reconcile({ Quiet: 1808 }, { Quiet: 1796 }, { Quiet: 1808 });
    expect(r.ok, '表没被写却少了 12 行，这是真丢数据，不该放行').toBe(false);
  });

  it('🔒 有 pre 也照样判死空壳（放宽的只是漂移，不是底线）', () => {
    const r = reconcile({ HotItem: 1808 }, { HotItem: 0 }, { HotItem: 1830 });
    expect(r.ok, '备份是空壳却判绿 —— 这场演练就白做了').toBe(false);
    expect(r.out).toMatch(/空壳/);
  });

  it('🔒 #pre 行不能被当成一张表', () => {
    // 漏了跳过 # 开头的行，`#pre HotItem` 会被当成一张「还原后缺失」的表 → 无脑判红。
    const r = reconcile({ HotItem: 1808 }, { HotItem: 1808 }, { HotItem: 1808 });
    expect(r.ok, '把 #pre 行当成表了').toBe(true);
    expect(r.out).not.toMatch(/#pre/);
  });

  it('老备份没有 #pre 行 → 退回百分比容差，不因此判红', () => {
    const r = reconcile({ HotItem: 1907 }, { HotItem: 1913 });
    expect(r.ok, '老备份在新演练下判红了 —— 升级把存量备份变成不可信').toBe(true);
  });

  it('🔒 小表差得离谱照样判死（容差不是免死金牌）', () => {
    const r = reconcile({ Invite: 3 }, { Invite: 40 });
    expect(r.ok).toBe(false);
  });
});

// ── 「写了没接」守卫 ─────────────────────────────────────────────
//
// 上面所有用例都是**测试自己造的 #pre 行**喂给演练的。要是 backup.sh 根本不写这几行，
// 线上每次演练都静默退回旧口径、继续每周喊狼来了，而这个文件依旧 12 绿。
// 这正是本项目反复踩到的那一种假绿，所以判据必须钉在真脚本上。
describe('backup.sh 真的写了 #pre（否则上面全是空转）', () => {
  const BACKUP = fs.readFileSync(path.join(ROOT, 'scripts/backup.sh'), 'utf8');

  it('🔒 dump 之前先数一次', () => {
    // 次序就是全部意义所在：pg_dump 的快照取在它开始那一刻。
    // 数在 dump 之后 = 又回到那个错的参照点，判据看着在、实际没用。
    orderedBefore(BACKUP, 'PRE_COUNTS="$(dump_row_counts', 'pg_dump_to "$TMP"');
  });

  it('🔒 把它写进 .counts', () => {
    const write = between(BACKUP, 'PRE_COUNTS" | sed', '} > "${DEST}.counts"');
    expect(write, 'PRE_COUNTS 算出来了却没写进 .counts —— 演练永远读不到').toBeTruthy();
  });

  it('🔒 两个脚本对 #pre 这个前缀的理解必须一致', () => {
    // 一边写 `#pre `、另一边读 `#pre-` 的话，演练读到空、静默退回旧口径。
    // 改了任一侧的前缀，这条就红。
    const written = /sed 's\/\^\/(#\S*) \//.exec(BACKUP)?.[1];
    const read = /sed -n 's\/\^(#\S*) \/\/p'/.exec(SRC)?.[1];
    expect(written, 'backup.sh 里没找到给 pre 行加前缀的那句').toBeTruthy();
    expect(read, 'restore-drill.sh 里没找到读 pre 行的那句').toBeTruthy();
    expect(written, `写的是 ${written}，读的是 ${read} —— 对不上`).toBe(read);
  });
});
