// 运行环境判定的单一事实来源。
//
// 「生产态要收紧」的开关必须全部从这里取：判定散落各处 = 早晚有一个文件写漏一半条件，
// 于是它在生产态悄悄走了 dev 分支（lib/auth.ts 的 devCode 回显就是这么漏的）。
//
// 判定口径与既有实现保持一致（lib/crypto.ts:9、lib/quota.ts:35、lib/logger.ts:12）：
// BEACON_ENV=prod 与 NODE_ENV=production 等效，任一成立即为生产。
//
// ⚠️ 必须是函数、在调用点读 env，不能是模块级 const —— 模块级快照会让
// crypto.ts 那套「懒校验」失效（构建期 NODE_ENV=production 会被固化进去），
// 单测里的 vi.stubEnv 也会失灵。
export function isProd(): boolean {
  return process.env.NODE_ENV === 'production' || process.env.BEACON_ENV === 'prod';
}
