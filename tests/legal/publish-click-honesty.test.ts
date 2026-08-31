import { describe, it, expect } from 'vitest';
import fs, { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { LEGAL_VERSION, LEGAL_TEXT_FINGERPRINT } from '@/lib/legal';

// 「插件永远不会点击发布按钮」这句话与代码相反（2026-08-30 修）。
//
// ── 缺陷 ──
// 四处对外法律文本写死了绝对句「**永远不会**点击发布按钮」：
//   app/(public)/legal/privacy/page.tsx、extension/store/privacy.md（两处）、
//   scripts/privacy-page.ts（进而生成 extension/store/privacy-policy.html）
// 而 extension/content/publish-fill.js:268 在 `autoClickPublish === true` 时确实
// `target.click()`。同一份 privacy.md 的另一处（第 159 行）反倒是写对的
//（「默认不点击…用户可显式开启代点发布」）——自相矛盾。
//
// 这属于本项目专门做过一轮审计的那一类：**文案与实际行为相反**。
// 而这一条尤其重要：发布是对外的意思表示，「我们永远不会替你做」是一句法律承诺。
const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/**
 * 我们**能在本地控制**的三处源头。
 *
 * 【为什么不含 extension/store/privacy-policy.html】那是 `scripts/privacy-page.ts`
 * **去抓线上页面**再镜像出来的产物（脚本里 `await fetch(SRC)`）。也就是说它只能在
 * **部署之后**重跑才会更新——拿本地源码去断言一个生产产物是范畴错误，
 * 而把它写进用例只会让「改了政策还没上线」这段时间里整个测试套永远红着。
 * 那一步记在 docs/上线清单-2026-08-24-抓取合规.md 与本轮的上线清单里。
 */
const DOCS = [
  'app/(public)/legal/privacy/page.tsx',
  'extension/store/privacy.md',
  'scripts/privacy-page.ts',
];

describe('代点发布：文案必须与代码一致', () => {
  it('🔒 插件里确实存在这个开关（前提没了，这组守卫就该重写而不是继续绿着）', () => {
    // 【必须剥注释】把 `target.click()` 注释掉之后那行字还在文件里，
    // 不剥的话这条守卫在「代点功能真的被移除了」时仍然是绿的——
    // 而那正是它该提醒「这组文案守卫该重写了」的时刻。
    const fill = read('extension/content/publish-fill.js')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(fill, 'autoClickPublish 不在了').toContain("chrome.storage.sync.get(['autoClickPublish'])");
    expect(fill, '不再有代点动作了').toContain('target.click()');
  });

  it.each(DOCS)('%s 里不许再出现「永远不点击发布」这种绝对句', (f) => {
    const s = read(f);
    for (const bad of ['永远不会点击发布', '永远不点击发布']) {
      expect(s, `${f} 里写着「${bad}」，而插件在用户开启 autoClickPublish 后确实会点`).not.toContain(bad);
    }
  });

  it.each(DOCS)('%s 要说清楚「默认关 + 可显式开启」', (f) => {
    const s = read(f);
    expect(s, `${f} 没说默认不点`).toMatch(/默认不点击发布|默认到此为止/);
    expect(s, `${f} 没说用户可以显式开启`).toContain('代点发布');
  });

  it('🔒 说了开关就要连护栏一起说（只说「可以开」等于漏掉了刹车）', () => {
    // 代码里的三道护栏：标题正文都填成功才找按钮 / 5 秒倒计时可取消 / 认不出按钮就不点。
    // 只写「可以开启代点」而不写这些，读者会以为开了就是无条件自动发。
    for (const f of ['app/(public)/legal/privacy/page.tsx', 'extension/store/privacy.md']) {
      const s = read(f);
      expect(s, `${f} 没写倒计时`).toMatch(/5 秒倒计时/);
      expect(s, `${f} 没写「认不出按钮就不点」`).toMatch(/一律不点|就不点/);
    }
  });
});

describe('🔒 政策正文改了，版本号必须跟着升', () => {
  // 【为什么这条最要紧】横幅只在 consentVersion !== LEGAL_VERSION 时出现
  //（components/LegalUpdateBanner.tsx:30）。版本不升 = 横幅永远不出 =
  // 「重大变更会通过站内通知或弹窗告知」这句承诺是空的，
  // 新增的处理活动没有任何用户在任何时点同意过。
  const legal = read('lib/legal.ts');

  it('当前版本在变更史里有对应的一条（升了版号却不写变更 = 说不清改了什么）', () => {
    expect(legal, `变更史里没有 ${LEGAL_VERSION} 这一条`).toContain(`//  ${LEGAL_VERSION}`);
  });

  // 【这条才是真判据】原来只断「变更史里有当前版本」——把版本号改回旧值时，
  // 旧那一条还在，守卫照样绿（变异验证当场抓到）。版本号本身证明不了任何事，
  // 要判的是**政策正文有没有在版本号不动的情况下被改过**。
  it('🔒 政策正文的指纹与 LEGAL_TEXT_FINGERPRINT 一致', () => {
    const strip = (p: string) => read(p)
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\{[^{}]*\}/g, '')
      .replace(/\s+/g, '');
    const body = ['app/(public)/legal/privacy/page.tsx', 'app/(public)/legal/terms/page.tsx',
      'app/(public)/legal/payment/page.tsx'].map(strip).join('');
    const fp = createHash('sha256').update(body).digest('hex').slice(0, 16);
    expect(
      fp,
      `政策正文变了但 lib/legal.ts 的指纹没跟着改。新指纹是 ${fp}。\n`
      + '请做一次有意识的选择：实质变更 → 升 LEGAL_VERSION + 写变更史 + 更新指纹；'
      + '只是措辞润色 → 版本号不动，只更新指纹并在提交说明里写清。\n'
      + '（不升版号的后果：横幅只在 consentVersion !== LEGAL_VERSION 时出现，'
      + '不升 = 横幅永远不出 = 新增的处理活动没有任何用户同意过。）',
    ).toBe(LEGAL_TEXT_FINGERPRINT);
  });

  it('本轮新增的处理活动都进了变更史', () => {
    for (const item of ['截图', '采集配方', '引用回执']) {
      expect(legal, `变更史里没提「${item}」`).toContain(item);
    }
  });

  it('🔒 上线清单里写明了「部署后要重跑 privacy-page.ts」（否则商店那份镜像会一直是旧的）', () => {
    // 商店镜像抓的是线上页面，本地跑只会把**旧文**又抄一遍。
    // 它是 Chrome 商店审核与用户实际会读到的那一份，落后就等于对外挂着一句失实的话。
    const docs = fs.readdirSync(join(ROOT, 'docs')).filter((f) => f.startsWith('上线清单'));
    const hit = docs.some((f) => readFileSync(join(ROOT, 'docs', f), 'utf8').includes('scripts/privacy-page.ts'));
    expect(hit, '没有任何一份上线清单提到要重跑 scripts/privacy-page.ts').toBe(true);
  });
});
