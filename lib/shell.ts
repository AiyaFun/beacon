// ── 单壳化兼容层（2026-08-26）─────────────────────────────────────────────────
//
// 工作台（workbench）已删：用户拍板「删掉工作台」。多轮页面合并后两套侧栏内容
// 几乎重合，双壳只剩维护成本（每次改导航两张表 + 对等守卫）。
// 这个文件从「第二套导航 + 外壳切换机制」瘦成一个 re-export：
//   · TASK_NAV 就是 lib/nav.ts 的 NAV（唯一真相源在那边）；
//   · SHELL_COOKIE / DEFAULT_SHELL / ShellMode / 切换器 全部退役；
//   · Member.shellMode 列保留但不再读（删列要迁移，读死值零成本）。
// 保留这个文件是为了存量 import（几十处 tests 与组件写着 from '@/lib/shell'）。

export { NAV as TASK_NAV } from '@/lib/nav';
