import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { redactSecrets } from '@/lib/agent/redact';

// 本机命令输出 / 本机文件进模型上下文前的密钥脱敏（2026-09-02）。

describe('redactSecrets', () => {
  it.each([
    ['OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456', 'sk-abcdefghij'],
    ['AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE'],
    ['DATABASE_URL=postgresql://beacon:S3cretPass@db.internal:5432/beacon', 'S3cretPass'],
    ['REDIS_URL=redis://:redispass123@127.0.0.1:6379', 'redispass123'],
    ['Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def', 'eyJhbGci'],
    ['BEACON_KEY_SECRET="0123456789abcdef"', '0123456789abcdef'],
    ['"api_key": "zzzz-yyyy-xxxx-1234"', 'zzzz-yyyy'],
    ['password: hunter2hunter2', 'hunter2hunter2'],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nABC\n-----END RSA PRIVATE KEY-----', 'MIIEow'],
    ['token ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_abcdefghij'],
  ])('打码：%s', (input, secret) => {
    const r = redactSecrets(input);
    expect(r.count).toBeGreaterThan(0);
    expect(r.text).not.toContain(secret);
    expect(r.text).toContain('[已脱敏]');
  });

  it('键名留着、值打码：模型仍然看得出那一行是什么配置', () => {
    const r = redactSecrets('DATABASE_URL=postgresql://beacon:S3cretPass@db.internal:5432/beacon\nOPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(r.text).toContain('DATABASE_URL=postgresql://beacon:[已脱敏]@db.internal:5432/beacon');
    expect(r.text).toContain('OPENAI_API_KEY=sk-[已脱敏]');
    expect(r.count).toBe(2);
  });

  it('🔒 不许误伤：普通输出一字不动', () => {
    for (const s of [
      'On branch main\nnothing to commit, working tree clean',
      'total 8\n-rw-r--r-- 1 u u 12 Sep 2 a.txt',
      'PORT=3070\nNODE_ENV=production\nBEACON_EDITION=appliance',
      'token 这个词出现在正文里但后面不是值',
      'https://example.com/path?x=1',
    ]) {
      const r = redactSecrets(s);
      expect(r.count, s).toBe(0);
      expect(r.text).toBe(s);
    }
  });

  it('形状与 .githooks/pre-commit 那份保持同步（改一处要看另一处）', () => {
    const hook = readFileSync('.githooks/pre-commit', 'utf8');
    // pre-commit 里每一条能构造出样本的形状，这里都得认得出
    expect(hook).toContain('sk-[a-zA-Z0-9_-]{20,}');
    expect(hook).toContain('AKIA[0-9A-Z]{16}');
    expect(hook).toContain('postgresql://');
    const sample = [
      'sk-' + 'a'.repeat(24),
      'AKIA' + 'B'.repeat(16),
      'AKLT' + 'c'.repeat(24),
      'postgresql://u:p4ssw0rd@h/db',
      'redis://:p4ssw0rd@h',
      'password = "longpassword"',
      'secret = "longsecret1"',
    ];
    for (const s of sample) expect(redactSecrets(s).count, s).toBeGreaterThan(0);
  });
});

describe('接进了工具', () => {
  it('run_shell 与 read_file 的源码都过了 redactSecrets（写了没接是这个项目最常见的错）', () => {
    const src = readFileSync('lib/agent/tools-local.ts', 'utf8');
    const uses = src.split('redactSecrets(').length - 1;
    expect(uses).toBeGreaterThanOrEqual(2);
  });
});
