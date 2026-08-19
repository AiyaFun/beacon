import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

// `tests/setup/per-file.ts` 的 PAID_ENV 是一份**手抄清单**：它的作用是把 @next/env 灌回来的
// 真实付费 key 擦掉，别让 `npm test` 去打真实接口烧额度。
//
// 手抄清单的失效方式很安静：新接一条付费通道、忘了往清单里补一行，测试**照常全绿**——
// 直到某天有人在 .env 里配上那个 key，CI 开始花钱，而且 mock 断言会莫名其妙全红。
// 2026-08-13 查出时就漏了两条（BEACON_IMAGE_LLM_* / BEACON_VISION_LLM_*，即梦生图与视频理解）。
//
// 判据：**代码里 `process.env` 读到的、名字像付费凭证的 key，必须都在 PAID_ENV 里。**
// 用名字判断而不是靠人记：`*_API_KEY` / `*_BASE_URL` / `*_SK` / `*_KEY` 这几种后缀就是付费通道
// 的命名习惯，而纯开关、纯 ID 不是。

const SETUP = readFileSync(resolve(process.cwd(), 'tests/setup/per-file.ts'), 'utf8');

/** PAID_ENV 数组里现有的键 */
const listed = (() => {
  const m = /const PAID_ENV = \[([\s\S]*?)\] as const;/.exec(SETUP);
  if (!m) throw new Error('per-file.ts 里找不到 PAID_ENV —— 改了名就要改这个测试');
  return new Set(Array.from(m[1].matchAll(/'([A-Z0-9_]+)'/g), (x) => x[1]));
})();

/** 递归收集 lib/ 下所有 .ts 里 process.env.XXX 的 XXX */
function collectEnvKeys(dir: string, out = new Set<string>()): Set<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { collectEnvKeys(p, out); continue; }
    if (!p.endsWith('.ts')) continue;
    const src = readFileSync(p, 'utf8');
    for (const m of src.matchAll(/process\.env\.([A-Z0-9_]+)/g)) out.add(m[1]);
  }
  return out;
}

// 付费凭证的命名形态。BASE_URL 一并算：它和 key 成对出现，只擦 key 会让请求打到真实网关地址。
const LOOKS_PAID = /^BEACON_.*(_API_KEY|_BASE_URL|_SK|_AK)$/;

// 明确不是付费凭证的（有则在此登记，附理由——这份豁免清单本身也要说得出道理）
const NOT_PAID = new Set<string>([
  // 下面三个是**自建服务的地址**，不是付费凭证：都跑在自己服务器的容器里
  //（docker-compose 里的 rsshub / dailyhot），调多少次都不花钱。
  // 它们仍然是网络调用，但那属于「测试别打网络」的另一条纪律，不归这份清单管；
  // 而且擦掉它们会让相关用例退回默认地址，反而更难解释。
  'BEACON_RSSHUB_BASE_URL',
  'BEACON_DAILYHOT_BASE_URL',
  'BEACON_60S_BASE_URL',
]);

describe('付费通道 env 的擦除清单不许漏', () => {
  it('🔒 lib/ 里读到的付费 key，PAID_ENV 全覆盖', () => {
    const all = collectEnvKeys(resolve(process.cwd(), 'lib'));
    expect(all.size, 'lib/ 下一个 process.env 都没扫到，正则大概率失效了').toBeGreaterThan(10);

    const missing = [...all].filter((k) => LOOKS_PAID.test(k) && !listed.has(k) && !NOT_PAID.has(k));
    expect(
      missing,
      `这些付费 key 不在 tests/setup/per-file.ts 的 PAID_ENV 里——`
        + `一旦有人在 .env 配上它们，npm test 会打真实接口烧额度：\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('PAID_ENV 里不该有幽灵项（列了但代码里根本没人读）', () => {
    const all = collectEnvKeys(resolve(process.cwd(), 'lib'));
    const ghosts = [...listed].filter((k) => !all.has(k));
    // 幽灵项不致命（多擦一个没坏处），但通常意味着通道已经下线、清单没跟着清理
    expect(ghosts, `PAID_ENV 里这些键在 lib/ 下没有任何读取点，确认是否已下线：${ghosts.join(', ')}`)
      .toEqual([]);
  });
});
