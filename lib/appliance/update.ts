import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { assertCan } from '../edition';
import { compareVersion } from '../downloads';
import { createLogger } from '../logger';
import pkg from '../../package.json';

const log = createLogger({ module: 'appliance-update' });

// ── 整机版「一键增量更新」──────────────────────────────────────────────────
//
// 这条链路会**下载代码并在客户机器上执行**，是整个产品里最接近 RCE 的一段。
// 六道闸，一道都不能省（每一道都对应一种真实的坏结局）：
//
// ① 形态闸：只有 appliance/private 有「本机这台机器」。SaaS 上这条路由存在本身就是错的。
// ② 角色闸：owner/admin（与密钥同级）——更新会重启服务、动全部代码。
// ③ **来源钉死**：更新源只能是编译期常量或运维配的 env，**绝不接受调用方传入的 URL**。
//    接受入参 = 任何能调到这个 action 的人都能让客户机器去执行他的代码。
// ④ sha256 校验：清单里的哈希与下载到的包必须逐字节对上，对不上立刻中止。
//    （校验在 shell 脚本里做——那里才是真正落盘的地方，在 Node 里校验完再交给脚本
//    等于留了一段「校验过的」与「实际用的」不是同一份文件的窗口。）
// ⑤ 不许降级：目标版本必须严格大于当前版本。降级能把已修好的漏洞装回去。
// ⑥ 单例：正在更新时不许再触发一次（两个 npm ci 同时写 node_modules 必坏）。
//
// 【为什么是 detached 起脚本而不是在请求里跑完】更新的最后一步是重启服务——
// 跑到那一步时，发起这次请求的进程自己就没了。所以：起一个脱离父进程的脚本，
// 立刻返回，前端轮询 /api/health 等它回来（见 ApplianceUpdateCard）。

/**
 * 更新源。**只认这两个来源**：运维在 env 里配的、或官方站点。
 * 绝不从函数入参取——见文件头闸③。
 */
export function updateOrigin(): string {
  const raw = process.env.BEACON_UPDATE_ORIGIN?.trim();
  const origin = raw || 'https://beacon.iyunci.cn';
  return origin.replace(/\/+$/, '');
}

export type UpdateCheck =
  | { ok: true; current: string; latest: string; hasUpdate: boolean; sizeMB: number; notes: string[] }
  | { ok: false; error: string };

/** 问一下官方站点有没有新版本。只读，不落地任何东西。 */
export async function checkApplianceUpdate(): Promise<UpdateCheck> {
  assertCan('passwordLogin'); // appliance / private 才有本机服务这回事
  const url = `${updateOrigin()}/downloads/appliance.manifest.json`;
  try {
    const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return { ok: false, error: `更新源没有响应（HTTP ${res.status}）：${url}` };
    const m = (await res.json()) as { version?: string; sizeMB?: number; sha256?: string; notes?: string[] };
    if (!m.version || !m.sha256) return { ok: false, error: '更新源返回的清单不完整（缺版本或校验值）' };
    return {
      ok: true,
      current: pkg.version,
      latest: m.version,
      hasUpdate: compareVersion(m.version, pkg.version) > 0,
      sizeMB: m.sizeMB ?? 0,
      notes: Array.isArray(m.notes) ? m.notes : [],
    };
  } catch (e) {
    return { ok: false, error: `连不上更新源：${(e as Error).message.slice(0, 160)}` };
  }
}

/** 更新脚本与它的状态文件（脚本自己往里写进度，前端靠它知道跑到哪一步了）。 */
export const UPDATE_SCRIPT = 'deploy/appliance/update.sh';
export const UPDATE_STATE_FILE = '.appliance-update.state';

export type StartUpdate = { ok: true; version: string } | { ok: false; error: string };

/**
 * 触发一次更新。返回后**服务会在几分钟内自行重启**——调用方要立刻把这件事告诉用户。
 *
 * 注意：这里不传任何 URL 给脚本，脚本自己从 BEACON_UPDATE_ORIGIN / 默认官方站取，
 * 与本模块的 updateOrigin() 同一个口径（闸③：来源钉死在服务端配置里）。
 */
export async function startApplianceUpdate(): Promise<StartUpdate> {
  assertCan('passwordLogin');

  const check = await checkApplianceUpdate();
  if (!check.ok) return { ok: false, error: check.error };
  // 闸⑤：不许降级，也不许「更新」到同一个版本（那只是白白重启一次服务）
  if (!check.hasUpdate) {
    return { ok: false, error: `已经是最新版 v${check.current}，无需更新` };
  }

  const root = process.cwd();
  const script = join(root, UPDATE_SCRIPT);
  if (!existsSync(script)) {
    return { ok: false, error: `找不到更新脚本 ${UPDATE_SCRIPT}——这个实例不是从整机版安装包装的？` };
  }
  // 闸⑥：单例。脚本开跑时写 state 文件、结束时删；文件在就是有一次在跑
  if (existsSync(join(root, UPDATE_STATE_FILE))) {
    return { ok: false, error: '已经有一次更新在跑了，等它跑完（或删掉 .appliance-update.state 后重试）' };
  }

  log.info('触发整机版更新', { from: check.current, to: check.latest, origin: updateOrigin() });

  // detached + unref：脚本要活过发起它的这个请求，甚至要活过服务重启那一刻
  const child = spawn('bash', [script, '--fetch'], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, BEACON_UPDATE_ORIGIN: updateOrigin() },
  });
  child.unref();

  return { ok: true, version: check.latest };
}
