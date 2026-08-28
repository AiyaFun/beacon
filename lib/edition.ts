// 部署形态（edition）的单一事实来源。
//
// 同一份代码要交付三种形态，能力面各不相同：
//
//   saas       —— 现在的线上（beacon.iyunci.cn）。短信登录、微信支付、平台垫付 AI 渠道、按套餐计费。
//   appliance  —— 卖给客户的整机（Mac mini / Win 主机）。SQLite + 进程内队列，装完即用，
//                 登录走 OA 扫码，AI 只能 BYOK，没有支付也没有短信通道。
//   private    —— 客户自己云上的 Docker 私有化。Postgres + Redis 与 saas 同构，
//                 但同样没有支付/短信，登录走 OA。
//
// 【为什么必须收在这里】
// 「这块功能哪个版本有」如果写成散落各处的 if，早晚有一处写漏：交付给客户的机器上
// 微信支付回调端点还活着、登录页还挂着短信输入框、AI 调用还在往平台 env 的 Key 上撞。
// 这类漏法的共同特征是**不报错**——功能静静地在不该在的地方可用。
//
// 与 lib/env.ts 的 isProd() 是**正交**的两件事，不要混：
//   isProd()  回答「要不要收紧」（要不要主密钥、要不要禁掉 devCode 回显）。
//   edition() 回答「这是哪个产品形态」。
// 客户整机跑的就是 NODE_ENV=production，isProd() 为真而 edition() 是 appliance ——
// 两个判定同时成立且互不替代。谁要是用 isProd() 去判「是不是 SaaS」，客户机器上
// 支付路由立刻复活。
//
// ⚠️ 必须是函数、在调用点读 env（同 lib/env.ts 的理由）：模块级 const 会被构建期快照固化，
//    单测里的 vi.stubEnv 也会失灵。

/** 三种交付形态。 */
export type Edition = 'saas' | 'appliance' | 'private';

/**
 * 受形态管辖的能力。新增一项就必须在下面 MATRIX 里给三个形态各写一个答案 ——
 * TypeScript 会强制你写全，这是刻意的：漏掉一个格子的代价是功能出现在不该出现的版本里。
 */
export type Capability =
  /** 微信支付、订阅、退款、发票 —— 只有 SaaS 收钱 */
  | 'payment'
  /** 短信验证码登录（火山短信按条计费） */
  | 'smsLogin'
  /** OA（飞书/钉钉/企微）扫码免登 —— 企业内部形态的主登录方式 */
  | 'oaLogin'
  /**
   * 本机密码登录（个人创作者小站）：装机向导可设一个登录密码，之后凭它进来。
   * 没有它的话，个人用户（没有企业应用）在会话过期后被永久锁在门外只能重装——
   * OA 是可选步、一次性登录链接又要「已登录的管理员」才能生成。
   * SaaS 恒 false：那边有短信/微信，多一条密码通道只是多一个撞库面。
   */
  | 'passwordLogin'
  /** 平台垫付的 AI 渠道（超管在 /ops/ai 配的 + env 兜底）。非 SaaS 一律 BYOK */
  | 'platformLlmChannel'
  /** 按套餐档位的配额与账单 */
  | 'quotaBilling'
  /** 首次启动的配置向导（建管理员 / 填 Key / 配 OA） */
  | 'setupWizard'
  /** 机器人入站走飞书长连接（WS）而非公网 webhook —— NAT 后的整机没有公网地址 */
  | 'botInboundWs'
  /**
   * 本地发布器：在装了烽火台的那台机器上跑一个常驻登录的浏览器，替你打开创作后台填内容。
   * SaaS 恒为 false —— 服务端在机房，够不到用户的浏览器；把这条开给 SaaS 只能靠云端托管
   * 登录态，那是另一回事（也是我们不做的那件事）。
   */
  | 'localPublisher';

/**
 * 能力矩阵。**这张表就是三个版本的产品定义**，改它等于改产品边界，不要顺手改。
 *
 * 口径说明：
 * - appliance 与 private 的差别**只在基础设施**（SQLite+进程内队列 vs Postgres+Redis）
 *   和入站通道（WS vs webhook）。能力面上它们是同一个产品，别让它们分叉。
 * - 支付/短信在两个企业版里都是 false：客户已经买断或按项目付费，
 *   机器上留着支付回调端点只是多一个攻击面。
 */
const MATRIX: Record<Edition, Record<Capability, boolean>> = {
  saas: {
    localPublisher: false,
    payment: true,
    smsLogin: true,
    oaLogin: false,
    passwordLogin: false,
    platformLlmChannel: true,
    quotaBilling: true,
    setupWizard: false,
    botInboundWs: false,
  },
  appliance: {
    localPublisher: true,
    payment: false,
    smsLogin: false,
    oaLogin: true,
    passwordLogin: true,
    platformLlmChannel: false,
    quotaBilling: false,
    setupWizard: true,
    // 整机在 NAT 后面，飞书服务器打不进来 —— 入站只能由本机主动出站连长连接。
    botInboundWs: true,
  },
  private: {
    localPublisher: true,
    payment: false,
    smsLogin: false,
    oaLogin: true,
    // D6：appliance 与 private 能力面一致——个人模式密码在两个企业版都可用
    passwordLogin: true,
    platformLlmChannel: false,
    quotaBilling: false,
    setupWizard: true,
    // 客户云上有公网地址和证书，沿用现成的 webhook 入站，不引入长连接进程。
    botInboundWs: false,
  },
};

const EDITIONS = Object.keys(MATRIX) as Edition[];

/** 认得的形态名（给设置页/安装脚本做校验用）。 */
export function knownEditions(): readonly Edition[] {
  return EDITIONS;
}

export class UnknownEditionError extends Error {
  readonly code = 'UNKNOWN_EDITION';
  constructor(raw: string) {
    super(
      `BEACON_EDITION="${raw}" 不是合法的部署形态。可选：${EDITIONS.join(' | ')}（留空=saas）`,
    );
    this.name = 'UnknownEditionError';
  }
}

/**
 * 当前部署形态。未设置 = saas。
 *
 * 【为什么拼错要抛而不是回落 saas】
 * 回落是这里最危险的选项：客户整机的启动脚本要是把 `appliance` 敲成 `applaince`，
 * 静默回落意味着那台卖出去的机器跑的是 SaaS 版 —— 支付路由活着、登录页要短信
 * （而机器上根本没有短信通道，用户直接卡在登录页）、AI 去撞不存在的平台 Key。
 * 全都不报错，只是"处处都不太对"，而这种故障远程排查要好几轮。
 * 留空回落 saas 则是安全的：现有生产环境一个字都没配，必须保持原样。
 */
export function edition(): Edition {
  const raw = process.env.BEACON_EDITION?.trim().toLowerCase() ?? '';
  if (!raw) return 'saas';
  if ((EDITIONS as string[]).includes(raw)) return raw as Edition;
  throw new UnknownEditionError(raw);
}

/** 当前形态有没有这项能力。 */
export function can(cap: Capability): boolean {
  return MATRIX[edition()][cap];
}

/** 便捷判定：是不是卖给企业的形态（appliance / private）。用于「两个企业版一致」的分支。 */
export function isEnterpriseEdition(): boolean {
  return edition() !== 'saas';
}

export class CapabilityDisabledError extends Error {
  readonly code = 'CAPABILITY_DISABLED';
  constructor(cap: Capability, ed: Edition) {
    super(`本版本（${ed}）不提供该功能：${cap}`);
    this.name = 'CapabilityDisabledError';
  }
}

/**
 * 硬闸：能力不在当前形态里就抛。
 * 用在**服务端入口**（路由 / server action）而不是 UI —— UI 藏起来只是不显示，
 * 端点还在就还能被直接打。
 */
export function assertCan(cap: Capability): void {
  const ed = edition();
  if (!MATRIX[ed][cap]) throw new CapabilityDisabledError(cap, ed);
}
