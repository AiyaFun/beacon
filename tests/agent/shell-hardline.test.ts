import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCommand, hardlineReason, SHELL_DEFAULTS } from '@/lib/agent/shell';

// 本机命令的底线（2026-09-02）。**full 档也拦**——这一条是它存在的全部意义，
// 所以下面每个用例都在 full 档下跑；allowlist 档下这些命令本来就不在清单里，测了等于没测。

let root = '';
beforeAll(() => {
  root = join(mkdtempSync(join(tmpdir(), 'beacon-hard-')), 'work');
  mkdirSync(root);
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'a.txt'), 'x');
});
afterAll(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* 不影响结论 */ } });

const full = () => ({ allow: [] as string[], mode: 'full' as const, root, ...SHELL_DEFAULTS });

describe('full 档下的底线', () => {
  it.each([
    [['sudo', 'ls'], '提权'],
    [['su', '-'], '提权'],
    [['shutdown', '-h', 'now'], '关机'],
    [['reboot'], '重启'],
    [['mkfs.ext4', '/dev/sda1'], '格式化'],
    [['mkfs', '-t', 'ext4', 'sub'], '格式化'],
    [['dd', 'if=a.txt', 'of=/dev/disk2'], '块设备'],
    [['diskutil', 'eraseDisk', 'APFS', 'X', 'disk2'], '抹盘'],
    [['kill', '-1'], '所有进程'],
    [['kill', String(process.pid)], '自己的进程'],
    [['kill', '-9', String(process.ppid)], '自己的进程'],
    [['pkill', '-f', 'next-server'], '自己'],
    [['killall', 'node'], '自己'],
    [['rm', '-rf', '.'], '整个工作目录'],
    [['rm', '-r', '--', '/'], '整个工作目录'],
    [['rm', '-Rf', '~'], '整个工作目录'],
  ])('%j → 拦（%s）', async (argv, why) => {
    const r = await checkCommand(full(), argv as string[]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(why);
  });

  it('rm 的目标解析到工作目录本身也算', async () => {
    const r = await checkCommand(full(), ['rm', '-rf', root]);
    expect(r.ok).toBe(false);
  });

  it('外壳剥掉再判：env / nohup / nice -n / timeout 10 包着的 sudo 一样拦', async () => {
    for (const argv of [
      ['env', 'FOO=1', 'sudo', 'ls'],
      ['nohup', 'shutdown', 'now'],
      ['nice', '-n', '10', 'reboot'],
      ['timeout', '10', 'sudo', 'ls'],
      ['env', 'nice', '-n', '5', 'nohup', 'sudo', 'id'],
    ]) {
      const r = await checkCommand(full(), argv);
      expect(r.ok, argv.join(' ')).toBe(false);
    }
  });

  it('shell -c 里的脚本按文本形状判', async () => {
    for (const script of [
      'rm -rf /',
      'cd sub && rm -rf ~',
      'mkfs.ext4 /dev/sda1',
      'dd if=/dev/zero of=/dev/sda bs=1M',
      ':(){ :|:& };:',
      'sudo apt install x',
      'pkill -f node',
      'kill -9 -1',
      'ls; shutdown -h now',
    ]) {
      const r = await checkCommand(full(), ['bash', '-c', script]);
      expect(r.ok, script).toBe(false);
    }
  });

  it('🔒 不许误伤：正常命令在 full 档照常放行', async () => {
    for (const argv of [
      ['ls', '-la'],
      ['git', 'status'],
      ['rm', '-rf', 'sub'],            // 删子目录是正常操作
      ['rm', 'a.txt'],
      ['kill', '12345'],                // 别的进程随他
      ['pkill', '-f', 'my-python-script'],
      ['bash', '-c', 'echo rm -rf / is dangerous'],   // 只是 echo 一句话
      ['bash', '-c', 'git commit -m "remove sudo usage"'],
      ['grep', '-r', 'sudo', 'sub'],
      ['diskutil', 'list'],
      ['dd', 'if=a.txt', 'of=sub/b.txt'],
    ]) {
      const r = await checkCommand(full(), argv);
      expect(r.ok, argv.join(' ')).toBe(true);
    }
  });

  it('allowlist 档下底线的理由优先于「不在清单里」：用户看到的是真正的原因', async () => {
    const r = await checkCommand({ ...full(), mode: 'allowlist', allow: ['ls'] }, ['sudo', 'ls']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('提权');
  });

  it('hardlineReason 是纯判定，不看档位', () => {
    expect(hardlineReason(root, ['sudo', 'ls'])).not.toBeNull();
    expect(hardlineReason(root, ['ls'])).toBeNull();
  });
});

describe('路径闸补的那个洞：key=value 形状', () => {
  it('--output=/etc/x 与 of=/dev/sda 的等号后半也要过闸', async () => {
    for (const argv of [['curl', '--output=/etc/evil', 'http://x'], ['tar', '-cf', 'a.tar', '--directory=/etc', '.'], ['cp', 'a.txt', 'dest=/tmp/x']]) {
      const r = await checkCommand(full(), argv);
      expect(r.ok, argv.join(' ')).toBe(false);
      if (!r.ok) expect(r.error).toContain('工作目录之外');
    }
  });
  it('🔒 不许误伤：等号后面是工作目录内的路径或根本不是路径', async () => {
    for (const argv of [['curl', '--output=sub/x.bin', 'http://x'], ['make', 'CC=gcc'], ['echo', 'a=b'], ['git', 'log', '--format=%h']]) {
      const r = await checkCommand(full(), argv);
      expect(r.ok, argv.join(' ')).toBe(true);
    }
  });
});
