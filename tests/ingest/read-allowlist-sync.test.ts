import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { BROWSER_READ_ALLOWED_ORIGINS, isReadAllowed } from '@/lib/browser-task/read-allowlist';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
/**
 * 源码断言前先剥注释。第一版直接全文搜 `endsWith(`，结果被**解释这件事的注释**判红——
 * 注释里正写着「endsWith('douyin.com') 会放行 www.douyin.com.evil.com」。
 * 断言看的是代码在做什么，不是文件里出现过什么字符串（同 shell-modes 那份的做法）。
 */
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// 「让插件替我打开并读取一个网页」这条能力的全部防线，都在这一份清单上。
//
// 它是唯一一个由**服务端指定 URL**、让用户已登录的浏览器去打开的动作。
// 没有白名单，它就是「把一个可远程驱动的浏览器交给模型」——那不是功能，是漏洞。
//
// 这一份用例守三件事：两边的清单一致、比对方式没被放松、以及插件端真的有这道闸。

describe('两边的清单必须一模一样', () => {
  const pluginSrc = read('extension/content/read-allowlist.js');

  it('插件端与服务端逐条对得上', () => {
    // 【为什么两边都要有】只在服务端校验 = 插件无条件信任服务端，
    // 而插件连的服务端地址是**可配置的**（zip 版自己填、私有化各连各的、开发连 localhost）。
    // 一个被改过地址或被攻陷的服务端，就能让用户的浏览器去打开任意网址。
    // bridge.js 那次 localhost 端口漏洞的教训：锚一旦可被外部改写，防线就不存在。
    const inPlugin = [...pluginSrc.matchAll(/'(https:\/\/[^']+)'/g)].map((m) => m[1]);
    expect(new Set(inPlugin), '插件端清单与服务端对不上——改一边漏一边，服务端排得出的活插件永远拒绝执行')
      .toEqual(new Set(BROWSER_READ_ALLOWED_ORIGINS));
  });

  it('service worker 复用同一个文件，不许再抄第三份', () => {
    const sw = code('extension/sw.js');
    expect(sw, 'sw 没有引入共享的那份清单').toMatch(/importScripts\(['"]content\/read-allowlist\.js['"]\)/);
    // 抄第三份的下场是确定的：改一处漏两处，而漏掉的那处正好是防线所在
    expect(sw, 'sw 里又抄了一份 origin 清单').not.toMatch(/https:\/\/www\.douyin\.com['"]\s*,/);
  });
});

describe('比对方式不许放松', () => {
  it('只认 origin 全等，后缀匹配会被 evil 域名骗过', () => {
    expect(isReadAllowed('https://www.douyin.com/video/123')).toBe(true);
    // 这三个是同一类攻击：endsWith('douyin.com') 会把它们全放行
    expect(isReadAllowed('https://www.douyin.com.evil.com/x'), '后缀匹配漏洞').toBe(false);
    expect(isReadAllowed('https://evil.com/?a=www.douyin.com'), '查询串里带白名单域').toBe(false);
    expect(isReadAllowed('https://douyin.com.attacker.io/'), '子域冒充').toBe(false);
  });

  it('http 明文一律不许（中间人能把内容换成任意文字，而那段文字要进模型）', () => {
    expect(isReadAllowed('http://www.douyin.com/video/1')).toBe(false);
  });

  it('非常规端口与 userinfo 冒充挡得住', () => {
    expect(isReadAllowed('https://www.douyin.com:8443/x'), '端口不同就是另一个 origin').toBe(false);
    expect(isReadAllowed('https://www.douyin.com@evil.com/x'), 'userinfo 冒充').toBe(false);
  });

  it('不是 URL 的东西不会被当成通过', () => {
    for (const bad of ['', '不是网址', 'javascript:alert(1)', '//www.douyin.com/x']) {
      expect(isReadAllowed(bad), `${bad} 不该通过`).toBe(false);
    }
  });

  it('插件端那份也是 origin 全等 + 只认 https（源码断言：这是它唯一的判据）', () => {
    const src = code('extension/content/read-allowlist.js');
    expect(src, '插件端没用 origin 比对').toMatch(/\.includes\(u\.origin\)/);
    expect(src, '插件端没挡 http').toMatch(/protocol !== 'https:'/);
    expect(src, '插件端用了后缀匹配').not.toMatch(/endsWith\(|indexOf\(|includes\(u\.hostname/);
  });
});

describe('最终 URL 复验：白名单域里到处是跳转口', () => {
  it('内容脚本按自己的 location.href 再验一次', () => {
    // 派单时校验通过的 URL，落地可以是任意站点（b23.tv、t.cn、youtube.com/redirect、微博短链）。
    // 复验放在内容脚本里是刻意的：它跑在**落地后的那一页**上，拿的是自己的 location.href，
    // 比 service worker 事后去读 tab.url 更准，也不需要额外的 "tabs" 权限
    const common = code('extension/content/common.js');
    expect(common, '页面文本通道没有对派活来的请求做白名单校验').toMatch(/beaconReadAllowed\(location\.href\)/);
    expect(common, '没有区分「用户当场点」与「服务端派活」').toMatch(/msg\.forTask/);
  });

  it('用户自己点的那条路不受影响（他是对着眼前这一页发起的）', () => {
    const common = code('extension/content/common.js');
    // 闸只在 forTask 时生效。把它加到所有请求上会让侧栏的「分析这一页」在非白名单站点上失效——
    // 而那本来就是用户当场对着自己正在看的页面点的
    expect(common).toMatch(/if \(msg\.forTask\)/);
  });
});

describe('这条能力默认是关的', () => {
  it('工作区开关默认 false（用户得知道自己开了什么）', () => {
    for (const p of ['prisma/schema.prisma', 'prisma/schema.postgres.prisma']) {
      expect(read(p), `${p} 里的开关不是默认关`).toMatch(/browserReadEnabled Boolean @default\(false\)/);
    }
  });

  it('派活工具会先查这个开关', () => {
    const tools = code('lib/agent/tools.ts');
    // 【两处都要断】只验名字的话，`select: { browserReadEnabled: true }` 那一行就够它绿了——
    // 把下面真正拦人的 if 删掉，开关照样形同虚设，而守卫毫无反应。
    expect(tools, '没把开关查出来').toMatch(/select: \{ browserReadEnabled: true \}/);
    expect(tools, '查了却没拦 = 默认关形同虚设').toMatch(/if \(!ws\?\.browserReadEnabled\)/);
  });
});
