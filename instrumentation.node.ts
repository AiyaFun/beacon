// node runtime 专属的启动装配。由 instrumentation.ts 在 `NEXT_RUNTIME === 'nodejs'` 分支里动态引入，
// 所以这里可以放任何依赖 node API 的东西（edge 打包不会走到本文件）。
// 真正的装配逻辑在 lib/ops/install.ts —— worker.ts 也用同一份。

import { initObservability } from './lib/logger';
import { installOpsAlerting } from './lib/ops/install';
import { schedulerKind } from './lib/jobs/queue';

initObservability('web');
await installOpsAlerting();

// 整机版的定时跑在 web 进程里（BEACON_QUEUE=local）。
//
// 【为什么在这儿起】这是 web 进程唯一一个「只在启动时跑一次」的钩子。
// 放在别处（某个页面、某个 action）意味着「用户没打开过那一页，定时就不存在」——
// 而定时的整个意义就是用户不在的时候也跑。
//
// 【为什么不在 SaaS/私有化上起】那两档有独立的 worker 进程注册 cron；
// web 这边再起一个，每条定时任务就会**每天跑两遍**（一遍 worker、一遍每个 web 实例，
// 而 web 还可能是多实例）。判据统一走 schedulerKind()，别在这里写 env 比较。
if (schedulerKind() === 'local') {
  const { startLocalScheduler } = await import('./lib/jobs/local-scheduler');
  startLocalScheduler();
}
