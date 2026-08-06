// Next.js 启动钩子。Next 15 起 instrumentation 已稳定，next.config 无需再开
// experimental.instrumentationHook（该选项在 15.0 已移除）。
// 每个 server runtime 启动一次；edge runtime 也会跑，故初始化只做纯 JS 的事。

import type { Instrumentation } from 'next';

export async function register() {
  // ⚠️ node 专属的东西必须写在 `=== 'nodejs'` 这个**条件块里面**再 import。
  // Next 会按运行时把 process.env.NEXT_RUNTIME 编译成字面量，条件为假的分支连同它的
  // 动态 import 一起被摇掉；写成「先 if(...) return; 再 import」不行——那时 import
  // 已经在顶层控制流上，edge 构建照样会去解析它，链路上有 `node:crypto` 就直接构建失败
  // （真踩过：lib/ops/alert → lib/bot → lib/crypto → UnhandledSchemeError: node:crypto）。
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./instrumentation.node');
  }
}

// Next 15 的服务端错误钩子：渲染 / route handler / server action / middleware 抛出的
// 未捕获错误都会到这里。接上 logger（error 级会自动上报）。
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  const { log } = await import('./lib/logger');
  log.error('请求未捕获异常', {
    err,
    path: request.path,
    method: request.method,
    routePath: context.routePath,
    routeType: context.routeType,
    // 注意：不要整包打 request.headers，里面有 cookie / authorization
    requestId: request.headers['x-request-id'],
  });
};
