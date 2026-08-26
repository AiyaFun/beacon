// 各平台创作后台的「发布页地址 + 输入框选择器」——**唯一真相源**。
//
// 【为什么要有这个文件】同一份选择器现在有两个消费方：
//   ① 浏览器插件的 `extension/content/publish-fill.js`（用户自己的浏览器里填表）；
//   ② 整机版的本地发布器 `publisher.ts`（Mac mini / Windows 上跑的 Playwright）。
// 抄两份的下场这个项目已经写过一次教训（work.js 是第三套解析器，每轮真机校准都漏掉它）。
// 所以：**TS 这份是源**，插件那份必须与它逐字一致，`tests/publish/selectors-sync.test.ts` 钉死。
//
// ⚠️ 全部**未真机校准**。平台后台改版频繁，填不进去是预期内的情况——两个消费方都必须
// 诚实降级（复制到剪贴板 / 如实报 failed），绝不假装填好了。
//
// 【发布按钮为什么单独一套规则】填错输入框顶多内容不对，用户看得见；
// 点错按钮可能是「删除」「退出」，或者把半成品发出去且撤不回来。
// 所以按钮只认**精确文案白名单**，且带一份拒绝名单，两者都不许改成模糊匹配。

export type PlatformSelectors = {
  /** 发布页地址（本地发布器直接打开它；插件不用，它是用户自己点进去的） */
  url: string;
  title: string[];
  body: string[];
};

export const PUBLISH_SELECTORS: Record<string, PlatformSelectors> = {
  douyin: {
    url: 'https://creator.douyin.com/creator-micro/content/upload',
    title: ['input[placeholder*="标题"]', '.title-input input', 'input.semi-input[maxlength]'],
    body: ['div[data-placeholder*="作品简介"]', '.editor-kit-container [contenteditable="true"]', 'div[contenteditable="true"]'],
  },
  xiaohongshu: {
    url: 'https://creator.xiaohongshu.com/publish/publish',
    title: ['input[placeholder*="标题"]', '.title-input input', '.d-text input'],
    body: ['div[contenteditable="true"]', '#post-textarea', 'textarea[placeholder*="正文"]'],
  },
  bilibili: {
    url: 'https://member.bilibili.com/platform/upload/video/frame',
    title: ['input[placeholder*="标题"]', '.video-title input', 'input.input-val'],
    body: ['div[contenteditable="true"]', 'textarea[placeholder*="简介"]', '.video-desc textarea'],
  },
  shipinhao: {
    url: 'https://channels.weixin.qq.com/platform/post/create',
    title: ['input[placeholder*="标题"]', '.post-title input'],
    body: ['div[contenteditable="true"]', 'textarea[placeholder*="描述"]'],
  },
  zhihu: {
    url: 'https://zhuanlan.zhihu.com/write',
    title: ['textarea[placeholder*="标题"]', '.WriteIndex-titleInput textarea', 'input[placeholder*="标题"]'],
    body: ['div[contenteditable="true"]', '.public-DraftEditor-content', '.Editable-unstyled'],
  },
  toutiao: {
    url: 'https://mp.toutiao.com/profile_v4/graphic/publish',
    title: ['input[placeholder*="标题"]', 'textarea[placeholder*="标题"]', '.article-title input'],
    body: ['div[contenteditable="true"]', '.ProseMirror', '.ql-editor'],
  },
  baijiahao: {
    url: 'https://baijiahao.baidu.com/builder/rc/edit?type=news',
    title: ['input[placeholder*="标题"]', 'textarea[placeholder*="标题"]', '.cheetah-input'],
    body: ['div[contenteditable="true"]', '.editor-content', '.ql-editor'],
  },
  kuaishou: {
    url: 'https://cp.kuaishou.com/article/publish/video',
    title: ['input[placeholder*="标题"]', '.title-input input'],
    body: ['div[contenteditable="true"]', 'textarea[placeholder*="描述"]', 'textarea[placeholder*="简介"]'],
  },
};

/** 只认这些文字的按钮是「发布」。短、精确、不做包含匹配——宁可漏，不可错。 */
export const PUBLISH_BUTTON_TEXT = /^(发布|立即发布|发表|确认发布|发布视频|发布笔记|发布文章)$/;

/** 命中任何一个词就**不是**发布按钮。存草稿/预览/定时/删除点下去的后果各不相同，一律排除。 */
export const PUBLISH_BUTTON_DENY = /(草稿|预览|定时|设置|取消|返回|删除)/;

/** 这个平台能不能由本地发布器/插件填表 */
export function selectorsFor(platform: string): PlatformSelectors | null {
  return PUBLISH_SELECTORS[platform] ?? null;
}
