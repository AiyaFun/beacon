import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  PUBLISH_SELECTORS,
  PUBLISH_BUTTON_TEXT,
  PUBLISH_BUTTON_DENY,
} from '@/lib/publish/selectors';
import { PUBLISH_CAPS } from '@/lib/publish/capability';

// 发布页选择器现在有**两个消费方**：浏览器插件（用户自己的浏览器）与本地发布器
// （整机版跑在 Mac mini / Windows 上的 Playwright）。
//
// 这个项目已经吃过一次「同一件事两份实现」的亏：work.js 是第三套解析器，
// 每轮真机校准都漏掉它，结果小红书拆解采到背景卡片的数喂给了模型。
// 所以这里钉死：**lib/publish/selectors.ts 是源**，插件那份必须逐字一致；
// 谁只改了一边，这条用例当场红。

const ROOT = path.resolve(__dirname, '../..');
const FILL = fs.readFileSync(path.join(ROOT, 'extension/content/publish-fill.js'), 'utf8');

/** 从插件的 JS 里把 SELECTORS 那个对象字面量抠出来求值（测试环境里跑，不进产物）。 */
function extensionSelectors(): Record<string, { title: string[]; body: string[] }> {
  const start = FILL.indexOf('const SELECTORS = {');
  expect(start, '插件里找不到 SELECTORS —— 结构变了就来改这条用例，别删它').toBeGreaterThan(-1);
  const open = FILL.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < FILL.length; i++) {
    if (FILL[i] === '{') depth++;
    else if (FILL[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  expect(end).toBeGreaterThan(open);
  // eslint-disable-next-line no-new-func
  return new Function(`return ${FILL.slice(open, end)}`)() as Record<string, { title: string[]; body: string[] }>;
}

describe('选择器两份必须一致', () => {
  const ext = extensionSelectors();

  it('平台集合一致（谁多一个少一个都算漂）', () => {
    expect(Object.keys(ext).sort()).toEqual(Object.keys(PUBLISH_SELECTORS).sort());
  });

  it('每个平台的 title / body 选择器逐字一致', () => {
    for (const [platform, conf] of Object.entries(PUBLISH_SELECTORS)) {
      expect(ext[platform].title, `${platform} 的标题选择器两份不一致`).toEqual(conf.title);
      expect(ext[platform].body, `${platform} 的正文选择器两份不一致`).toEqual(conf.body);
    }
  });

  it('发布按钮的白名单与拒绝名单两份一致', () => {
    const okSrc = /const PUBLISH_BUTTON_TEXT = \/(.+)\/;/.exec(FILL)?.[1];
    const denySrc = /const PUBLISH_BUTTON_DENY = \/(.+)\/;/.exec(FILL)?.[1];
    expect(okSrc, '插件里没有发布按钮白名单').toBeTruthy();
    expect(okSrc).toBe(PUBLISH_BUTTON_TEXT.source);
    expect(denySrc).toBe(PUBLISH_BUTTON_DENY.source);
  });

  it('能力矩阵里标 extension 的平台，两份里都要有它', () => {
    for (const [platform, cap] of Object.entries(PUBLISH_CAPS)) {
      if (cap.channel !== 'extension') continue;
      expect(PUBLISH_SELECTORS[platform], `${platform} 缺 lib 侧选择器`).toBeTruthy();
      expect(ext[platform], `${platform} 缺插件侧选择器`).toBeTruthy();
    }
  });

  it('每个平台都写了发布页地址（本地发布器要用它打开页面）', () => {
    for (const [platform, conf] of Object.entries(PUBLISH_SELECTORS)) {
      expect(conf.url, `${platform} 没写发布页地址`).toMatch(/^https:\/\//);
    }
  });
});

describe('本地发布器的闸门', () => {
  const PUB = fs.readFileSync(path.join(ROOT, 'publisher.ts'), 'utf8');

  it('🔒 默认不点发布（要显式设环境变量才代点）', () => {
    expect(PUB).toContain("process.env.BEACON_PUBLISHER_AUTO_CLICK === '1'");
    expect(PUB).toMatch(/if \(!AUTO_CLICK\)/);
  });

  it('🔒 填不全不点：失败分支先 return，点击够不到', () => {
    const failIdx = PUB.indexOf("await receipt(task.id, 'failed', r.reason)");
    const clickIdx = PUB.indexOf('await clickPublish(page)');
    expect(failIdx).toBeGreaterThan(-1);
    expect(clickIdx).toBeGreaterThan(failIdx);
  });

  it('🔒 认不出发布按钮就报 filled，不许报 published', () => {
    expect(PUB).toMatch(/if \(!clicked\)[\s\S]{0,200}receipt\(task\.id, 'filled'\)/);
  });

  it('🔒 按钮判据直接引用共用常量，不在本地另写一套', () => {
    expect(PUB).toContain('PUBLISH_BUTTON_TEXT.source');
    expect(PUB).toContain('PUBLISH_BUTTON_DENY.source');
  });

  it('🔒 登录态留在本机：不上传 cookie、不读 storage 外发', () => {
    expect(PUB).toContain('launchPersistentContext');
    expect(PUB).not.toMatch(/cookies\(\)/);
    expect(PUB).not.toMatch(/storageState/);
  });

  it('🔒 playwright 不进 package.json 依赖（SaaS 镜像不该多几百 MB）', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.playwright).toBeUndefined();
    expect(pkg.devDependencies?.playwright).toBeUndefined();
    // 但脚本入口要在，否则用户照文档跑不起来
    expect(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts.publisher).toBe('tsx publisher.ts');
  });
});
