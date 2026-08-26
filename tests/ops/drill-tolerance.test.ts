import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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
function reconcile(baseline: Record<string, number>, restored: Record<string, number | null>): {
  ok: boolean; out: string;
} {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'drill-'));
  const countsFile = path.join(dir, 'b.counts');
  fs.writeFileSync(countsFile, Object.entries(baseline).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
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
  for (const must of ['TOL_PCT', '空壳', 'MISMATCH']) {
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

  it('🔒 小表差得离谱照样判死（容差不是免死金牌）', () => {
    const r = reconcile({ Invite: 3 }, { Invite: 40 });
    expect(r.ok).toBe(false);
  });
});
