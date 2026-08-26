import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// 「代点发布」：本插件唯一一个会替用户做**对外意思表示**的动作。
//
// 用户 2026-08-19 拍板要这个开关，但它的每一条闸都必须钉死——因为它错一次的代价
// 不是「功能没生效」，而是**一条没检查过的内容被公开发出去了，且撤不回来**。
// 这一组用例守四件事：默认关、半填不点、认不出按钮不点、点之前给得起后悔药。
//
// 顺带守「说的和做的一致」：隐私政策里那句承诺必须跟着代码变。此前它写的是
// 「永不点击发布按钮」——加了开关还留着这句，就是本项目审计过的那种「文案与行为相反」。

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const FILL = read('extension/content/publish-fill.js');
const OPTIONS_HTML = read('extension/options.html');
const OPTIONS_JS = read('extension/options.js');
const PRIVACY = read('extension/store/privacy.md');

describe('默认关：不点是缺省，点是例外', () => {
  it('🔒 判据是 === true —— 没显式打开就一律不点', () => {
    expect(FILL).toContain("cfg.autoClickPublish !== true");
    // 真值判断（if (cfg.autoClickPublish)）也能跑，但语义不同：
    // 存量里任何非空值都会被当成「开了」。不可逆动作只认严格相等。
    expect(FILL).not.toMatch(/if\s*\(\s*cfg\.autoClickPublish\s*\)/);
  });

  it('🔒 设置页读回来时同样按 === true 判（默认关不能靠 undefined 碰巧为假）', () => {
    expect(OPTIONS_JS).toContain('s.autoClickPublish === true');
  });

  it('🔒 开关在设置页里，且描述把代价讲全（用户的同意就是在这句话上给的）', () => {
    expect(OPTIONS_HTML).toContain('id="autoClickPublish"');
    for (const word of ['风险自负', '协议', '不可撤销', '倒计时']) {
      expect(OPTIONS_HTML, `开关说明里缺「${word}」`).toContain(word);
    }
  });
});

describe('四道闸：填不全不点、认不出不点、点前能取消、点了如实报', () => {
  it('🔒 只有填充成功才可能走到点击（失败分支先 return）', () => {
    const failIdx = FILL.indexOf("status: 'failed'");
    const clickIdx = FILL.indexOf('target.click()');
    expect(failIdx).toBeGreaterThan(-1);
    expect(clickIdx).toBeGreaterThan(failIdx); // 失败分支在前且 return，点击够不到
  });

  it('🔒 认不出发布按钮就不点（找不到按钮时报 filled，不是 published）', () => {
    expect(FILL).toContain('const target = findPublishButton();');
    expect(FILL).toMatch(/if\s*\(!target\)/);
  });

  it('🔒 按钮识别有拒绝名单：草稿/预览/定时/删除 一律不认', () => {
    for (const word of ['草稿', '预览', '定时', '删除']) {
      expect(FILL, `拒绝名单里缺「${word}」`).toContain(word);
    }
    // 只认精确文案，不做模糊包含——「保存并发布」这种也不点，宁可漏不可错
    // 【断在「真的拿它判了」上】两个常量光声明就各占一处——把 findPublishButton 里
    // 那两行 .test() 删掉，它照样绿，而那正是「认不出按钮就不点」「不点草稿/定时」两道闸本身。
    expect(FILL, '认按钮的白名单没参与判断').toMatch(/PUBLISH_BUTTON_TEXT\.test\(/);
    expect(FILL, '黑名单没参与判断——会点到草稿/定时/删除').toMatch(/PUBLISH_BUTTON_DENY\.test\(/);
  });

  it('🔒 点之前有倒计时且能取消（不可逆动作的后悔药）', () => {
    expect(FILL).toContain('function countdown(');
    expect(FILL).toContain("cancel.textContent = '取消'");
    expect(FILL).toMatch(/countdown\(status,\s*\d+\)/);
  });

  it('🔒 代点之后报 published 但不带链接——链接拿不到就不许编', () => {
    const seg = FILL.slice(FILL.indexOf('target.click()'), FILL.indexOf('target.click()') + 600);
    expect(seg).toContain("status: 'published'");
    expect(seg).not.toMatch(/url:\s*[^\s,}]/); // 不许塞一个猜出来的地址
  });
});

describe('说的和做的一致', () => {
  it('🔒 隐私政策不许再写「永不点击发布按钮」（有开关之后那是假话）', () => {
    expect(PRIVACY).not.toContain('永不点击发布按钮');
  });

  it('🔒 政策要写明：默认不点、开了才点、以及开了之后的那几道闸', () => {
    expect(PRIVACY).toContain('默认不点击发布按钮');
    expect(PRIVACY).toContain('autoClickPublish');
    expect(PRIVACY).toContain('倒计时');
    expect(PRIVACY).toContain('找不到就不点');
  });

  it('🔒 站内能力矩阵也不许再承诺「不代点」', () => {
    // 【断言必须落在真给用户看的那几行上】这条原来是 `expect(cap).toContain('默认停在发布按钮前')`，
    // 而那句话在 capability.ts 里**只存在于文件头的注释**——我为讲清楚这条通道而写的说明。
    // 于是把八条 why 文案全改回「我们绝不替你点」它照样绿：守的是我的说明，不是产品的承诺。
    // 而它放过的恰好就是它本该抓的——快手那条 why 当时就没说破代点开关。
    // 剥注释是硬要求，不是保险。
    const cap = read('lib/publish/capability.ts');
    const bare = cap.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(bare, '注释剥完什么都不剩了——这条守卫自己坏了').toMatch(/PUBLISH_CAPS/);
    expect(bare).not.toMatch(/不代点发布：/);

    // 走插件的平台，代点开关对它们一视同仁（findPublishButton 不认平台），
    // 所以每一条 why 都得说破有这个开关——只说「你来点」就是漏了一半。
    const whys = [...bare.matchAll(/channel: 'extension',[\s\S]*?why: '([^']*)'/g)].map((m) => m[1]);
    expect(whys.length, '一个 extension 平台都没扫到，正则大概坏了').toBeGreaterThan(4);
    for (const w of whys) {
      expect(w, `这条 why 没说破代点开关：${w.slice(0, 40)}…`).toMatch(/代点发布/);
    }
  });
});
