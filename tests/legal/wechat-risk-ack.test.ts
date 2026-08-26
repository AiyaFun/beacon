import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// 公众号采集的风险确认（2026-08-24 抓取合规审查）。
//
// 这条通道与插件其它所有采集**性质不同**：其它的都是读用户屏幕上已渲染的公开页面，
// 而它是用用户自己的公众平台登录态去调 searchbiz / appmsgpublish 两个**非官方**后台接口。
// 代码里一直知道这件事（lib/wechat-collect-rules.ts 文件头就写着「踩线的后果由用户自己的号
// 承担」），但对外一个字都没说过——节流降低的是概率，不能代替告知。
//
// 本文件钉住两件事：闸真的在咽喉上，以及三处对外文本都把代价讲全了。

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const SW = read('extension/sw.js');
const POPUP_HTML = read('extension/popup.html');
const POPUP_JS = read('extension/popup.js');
const OPTIONS_HTML = read('extension/options.html');
const TERMS = read('app/(public)/legal/terms/page.tsx');
const STORE_MD = read('extension/store/privacy.md');
const WEB_PRIVACY = read('app/(public)/legal/privacy/page.tsx');
const OFFSHORE = read('scripts/privacy-page.ts');

describe('🔒 风险确认闸在咽喉上', () => {
  it('闸在 collectWechatOne 里，且排在节流闸之前', () => {
    const fnAt = SW.indexOf('async function collectWechatOne');
    expect(fnAt, 'collectWechatOne 不见了？闸挂在它身上').toBeGreaterThan(-1);
    const body = SW.slice(fnAt, fnAt + 1500);
    const riskAt = body.indexOf('wechatRiskAcked()');
    const throttleAt = body.indexOf('wechatGate(name)');
    expect(riskAt, '风险闸不在 collectWechatOne 里').toBeGreaterThan(-1);
    // 还没告知就不该发出任何请求——也不该先去查节流
    expect(riskAt).toBeLessThan(throttleAt);
  });

  it('🔒 闸不看 interactive —— 定时那轮同样拦得住', () => {
    // 只拦「用户当场点击」那条路，等于定时任务在用户从没确认过的情况下照跑。
    const fnAt = SW.indexOf('async function collectWechatOne');
    const gate = SW.slice(fnAt, SW.indexOf('wechatGate(name)', fnAt));
    expect(gate).not.toMatch(/opts\.interactive/);
  });

  it('🔒 采集是单一咽喉 —— 没有第二条绕过闸的公众号采集路径', () => {
    // askWechatTab 是真正向内容脚本要数据的那一步。它只该被 collectWechatOne 调用；
    // 多一个调用方就多一条不过闸的路。
    const callers = SW.split('\n').filter(
      (l) => l.includes('askWechatTab(') && !l.trim().startsWith('//') && !l.includes('async function askWechatTab'),
    );
    expect(callers.length, `askWechatTab 有 ${callers.length} 处调用，逐一确认都在闸后：\n${callers.join('\n')}`)
      .toBeLessThanOrEqual(2); // collectWechatOne 里两次（登录前 + 扫码登录后重试）
  });

  it('🔒 确认只认布尔 true（fail-closed）', () => {
    // `if (msg.acked)` 会让字符串 'false' 也算同意。这道闸宁可多问一次。
    const at = SW.indexOf("msg?.type === 'wechat-risk-ack'");
    expect(at).toBeGreaterThan(-1);
    const handler = SW.slice(at, at + 500);
    expect(handler).toContain('msg.acked === true');
  });

  it('🔒 版本化 —— 告知内容改了能要求重新确认', () => {
    expect(SW).toMatch(/WECHAT_RISK_VERSION\s*=\s*\d+/);
    // 读取时必须真的比版本，只判 truthy 的话升版本号不会让任何人重新确认
    const at = SW.indexOf('async function wechatRiskAcked');
    expect(SW.slice(at, at + 400)).toContain('>= WECHAT_RISK_VERSION');
  });

  it('🔒 解绑/注销时清掉确认 —— 换了人不能沿用上一个人的意思表示', () => {
    const at = SW.indexOf('LOCAL_KEYS_ON_UNLINK');
    const list = SW.slice(at, SW.indexOf('];', at));
    expect(list).toContain("'wechatRiskAck'");
  });
});

describe('🔒 三处对外文本都要把代价讲全', () => {
  // 判据是「这几件事都说到了」，不是「出现了某个词」。
  // 只断言「包含『风险』二字」的话，把整段说明删成一句「有风险」也能绿。
  const MUST_SAY: [string, RegExp][] = [
    ['不是官方接口', /非官方接口|不是微信官方开放的数据接口|不是官方/],
    ['可能违反平台协议', /可能违反.{0,12}《微信公众平台服务协议》|可能违反《微信公众平台服务协议》/],
    // 「自己的（微信）公众号账号」——中间允许「微信」这类限定词，但主语必须是「自己的…账号」
    ['后果落在用户自己的号上', /自己的.{0,4}公众号账号/],
    ['我们无法代为申诉', /无法代为申诉|不能代为申诉/],
    ['节流不能消除风险', /不能消除风险|只能降低概率|不能消除这一风险/],
  ];

  for (const [name, text] of [
    ['插件确认面板 popup.html', POPUP_HTML],
    ['插件设置页 options.html', OPTIONS_HTML],
    ['站内服务条款 3.3', TERMS],
  ] as [string, string][]) {
    it(`${name} 讲全了五件事`, () => {
      for (const [what, re] of MUST_SAY) {
        expect(re.test(text), `${name} 没说清「${what}」`).toBe(true);
      }
    });
  }

  it('三份隐私政策也都提到这条通道的风险', () => {
    // 商店那份与境外托管那份是审核机器实际会读的；站内那份是用户点进去看的。
    for (const [name, text] of [
      ['商店 privacy.md', STORE_MD],
      ['境外托管版 privacy-page.ts', OFFSHORE],
      ['站内 /legal/privacy', WEB_PRIVACY],
    ] as [string, string][]) {
      expect(/可能违反《微信公众平台服务协议》/.test(text), `${name} 没写「可能违反平台协议」`).toBe(true);
      expect(/自己的.{0,4}公众号账号/.test(text), `${name} 没写「后果落在用户自己的号上」`).toBe(true);
    }
  });

  it('🔒 确认必须先勾选 —— 光点按钮不算', () => {
    expect(POPUP_HTML).toContain('id="wechatRiskCheck"');
    // 按钮初始 disabled，且 JS 里还有一道「没勾就直接 return」的双保险
    const btnAt = POPUP_HTML.indexOf('id="wechatRiskOk"');
    expect(POPUP_HTML.slice(btnAt, btnAt + 200)).toContain('disabled');
    expect(POPUP_JS).toMatch(/if \(!check\.checked\) return/);
  });

  it('🔒 设置页能关掉 —— 政策承诺了「之后可随时关闭」', () => {
    expect(OPTIONS_HTML).toContain('id="wechatRiskAck"');
    expect(read('extension/options.js')).toContain("type: 'wechat-risk-ack'");
  });
});
