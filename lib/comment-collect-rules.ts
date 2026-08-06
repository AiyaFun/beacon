// 评论采集的硬上限——唯一事实源。
// 插件侧的 comment-rules.gen.js 从这里导出的常量生成，测试比对两边一致。

export const MAX_COMMENTS_READ = 200;
export const MAX_QUESTIONS_PER_RUN = 12;
export const RATE_LIMIT_PER_HOUR = 30;
export const MIN_LEN = 5;
export const MAX_LEN = 60;
export const STALE_DAYS = 90;
export const PURGE_DAYS = 180;
