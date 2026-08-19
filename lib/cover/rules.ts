// AI 封面的硬边界常量：参考图张数 / 大小、封面文案长度、保留口径。
//
// 为什么单独一个文件：这些数字**同时**出现在代码（校验）、UI（提示）与对外文案（隐私政策/技能说明）里。
// 此前 3 张 / 8MB 分散在 SkillPanel 与 lib/skills 两处靠一行注释同步；隐私政策则一个字都没写。
// 现在代码只从这里读，tests/legal/portrait-promises.test.ts 再拿同一份常量去对政策原文——
// 谁改了数字没改文案（或反过来），测试当场变红。client-safe 纯常量，不许引 prisma。

/** 人像/主体参考图：最多 1 张（多张人像会让模型不知道保谁的脸）。 */
export const MAX_SUBJECT_IMAGES = 1;
/** 背景/氛围参考图：最多 2 张。 */
export const MAX_BACKGROUND_IMAGES = 2;
/** 参考图总数上限 = 主体 + 背景。多了既拖慢又稀释主体保真，请求体也会撑大。 */
export const MAX_REFERENCE_IMAGES = MAX_SUBJECT_IMAGES + MAX_BACKGROUND_IMAGES;
/**
 * 单张参考图上限（浏览器先压到长边 ≤1600 再传；服务端按真实字节再判一次）。
 * 1MB 是「多部分表单 + 内联给方舟」都舒服的量级——不是 Next server action 的 1MB 默认，
 * 那道墙已经被 Route Handler 绕开了。
 */
export const MAX_REFERENCE_BYTES = 1024 * 1024;
export const MAX_REFERENCE_MB = 1;
/** 浏览器压缩后的最长边（像素）。 */
export const REFERENCE_MAX_EDGE = 1600;

/** 封面主标题：超过这个字数上图会挤（提示，不截断）。 */
export const COVER_TITLE_SOFT_MAX = 14;
/** 封面主标题 / 副标题 / 备注的硬上限（进 prompt 前截）。 */
export const COVER_TITLE_HARD_MAX = 24;
export const COVER_SUBTITLE_HARD_MAX = 20;
export const COVER_EXTRA_HARD_MAX = 300;

// ── 保存口径（第二期起）───────────────────────────────────────────────
//
// 分两种，政策文本必须把两种都写清楚（守卫见 tests/legal/portrait-promises.test.ts）：
//   ① 直接选文件上传的参考图 = **一次性使用、不保存**：只在这一次请求里内联发给图像模型，
//      服务端不落库、不落盘、不进日志；
//   ② 用户主动点「存进我的形象」的才落库，加密存储，保存到他自己删除或注销为止（无自动过期——
//      它跟草稿、素材一样是用户主动建的东西，替他定个期限反而奇怪）。

/** ① 一次性上传的参考图永不落库。 */
export const REFERENCE_IMAGES_NOT_STORED = true;

/** ② 形象库（人像/背景/品牌元素）每个工作区最多存几张。备份会把图片一起带走，配额必须是硬的。 */
export const LIBRARY_MAX_ASSETS = 20;

/**
 * 一次最多出几张（变体 / 多风格 / 公众号成对都吃这个上限）。
 * 3 而不是外部工具的 6：一张就是一次真实付费调用，6 张会让 free 档的日额度一次去掉 20%，
 * 串行出图也要 1-3 分钟。给到 3，且按钮上明示「占 N 个名额」。
 */
export const MAX_COVER_IMAGES = 3;

/** 生成的封面自动留存的天数与张数（超出按时间从旧到新清理；用户钉住的不清）。 */
export const COVER_RETENTION_DAYS = 90;
export const COVER_MAX_PER_WORKSPACE = 50;

/** 参考图的接收方（隐私政策「委托处理 / 接收方」段落里的名字，与代码里的渠道一致）。 */
export const IMAGE_PROCESSOR_NAME = '火山引擎方舟（即梦）';
