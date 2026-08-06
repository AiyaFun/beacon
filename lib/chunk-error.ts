// 「浏览器加载 JS/CSS 分片（chunk）失败」的识别与自愈。
//
// 为什么需要单独处理这类错误：它和业务错误的正确应对完全相反。业务错误要把原因摊给用户看，
// 而 chunk 加载失败的原因用户无能为力、也读不懂（"Loading chunk 5515 failed"），
// 但**重新加载页面拿到新的资源清单**几乎总能解决。
//
// 两种成因：
//   1. 换版部署：旧页面停在浏览器里，它记录的 chunk 文件名属于上一版构建，
//      而 web 容器已被 `docker compose up -d --build` 换掉，重启窗口内取不到。
//   2. 静态资源短暂不可达：2026-07-23 事故——服务器根盘 100% 满，宿主 nginx 传不完
//      响应体（响应头 200 带 content-length，body 传一半断流），随机 chunk 加载失败。
//      根因已由 scripts/deploy-gate.sh 闸门 1 + 服务器 docker-disk-guard.sh 定时清理堵住，
//      这里是兜底：万一再有类似抖动，用户看到的是自动刷新，不是错误卡片。

/** 各浏览器/打包器对「分片加载失败」的不同说法，命中任一即认定。 */
const CHUNK_ERROR_PATTERNS = [
  /loading chunk [\w\-./]+ failed/i, // webpack：本项目实际遇到的就是这条
  /loading css chunk/i, // webpack 的 CSS 分片
  /failed to fetch dynamically imported module/i, // Chrome/Edge 动态 import
  /error loading dynamically imported module/i, // Firefox
  /importing a module script failed/i, // Safari
];

/**
 * 判断一个错误是否属于「分片加载失败」。
 * 入参故意放宽成 unknown：错误边界拿到的是 Error，window 事件里可能只有字符串。
 */
export function isChunkLoadError(error: unknown): boolean {
  if (!error) return false;

  // webpack 会把 name 明确标成 ChunkLoadError，最可靠，优先认它
  if (typeof error === 'object' && (error as { name?: unknown }).name === 'ChunkLoadError') {
    return true;
  }

  const message =
    typeof error === 'string'
      ? error
      : typeof (error as { message?: unknown }).message === 'string'
        ? ((error as { message: string }).message)
        : '';

  if (!message) return false;
  return CHUNK_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

export const CHUNK_RELOAD_KEY = 'beacon:chunk-reload-at';

/**
 * 两次自动刷新之间的最短间隔。
 * 作用是防死循环：如果刷新后依然加载失败（例如资源是真的没了），不能无限刷下去，
 * 必须让错误卡片露出来。超过这个窗口的再次失败视为**新的一次**抖动，允许再自愈一次。
 */
export const RELOAD_COOLDOWN_MS = 60_000;

/**
 * 纯判定：现在该不该刷新。抽出来是为了能脱离浏览器环境直接测。
 * @param now 当前时间戳
 * @param lastAttempt 上次自动刷新的时间戳（sessionStorage 里的原始字符串，可能为 null 或脏值）
 */
export function shouldReloadForChunkError(now: number, lastAttempt: string | null): boolean {
  if (lastAttempt === null || lastAttempt === '') return true;
  const last = Number(lastAttempt);
  // 脏值（被别的代码写坏、或用户手改）当作没刷过，宁可多刷一次也不要卡死在错误页
  if (!Number.isFinite(last)) return true;
  return now - last > RELOAD_COOLDOWN_MS;
}

/**
 * 执行自愈：满足冷却条件就刷新页面。
 * @returns 是否真的触发了刷新。返回 false 表示调用方应该照常显示错误界面。
 */
export function recoverFromChunkError(): boolean {
  if (typeof window === 'undefined') return false;

  // sessionStorage 在隐私模式/禁用 Cookie 时会抛异常。拿不到存储就**不敢**自动刷新——
  // 没有防重入标记的自动刷新一旦失败就是无限刷新循环，比露出错误卡片糟糕得多。
  let storage: Storage;
  let lastAttempt: string | null;
  try {
    storage = window.sessionStorage;
    lastAttempt = storage.getItem(CHUNK_RELOAD_KEY);
  } catch {
    return false;
  }

  if (!shouldReloadForChunkError(Date.now(), lastAttempt)) return false;

  try {
    storage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
  } catch {
    return false; // 同上：标记写不进去就别刷
  }

  window.location.reload();
  return true;
}
