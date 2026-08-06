// node runtime 专属的启动装配。由 instrumentation.ts 在 `NEXT_RUNTIME === 'nodejs'` 分支里动态引入，
// 所以这里可以放任何依赖 node API 的东西（edge 打包不会走到本文件）。
// 真正的装配逻辑在 lib/ops/install.ts —— worker.ts 也用同一份。

import { initObservability } from './lib/logger';
import { installOpsAlerting } from './lib/ops/install';

initObservability('web');
await installOpsAlerting();
