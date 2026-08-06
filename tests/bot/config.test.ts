import { describe, it, expect, vi, afterEach } from 'vitest';
import { readBotSecrets, writeBotSecrets } from '@/lib/bot';
import { storeLinks, BROWSER_CARDS } from '@/lib/downloads';

// 机器人密钥加解密 + 下载页配置。

describe('bot secrets 加解密', () => {
  it('round-trip：写入再读出一致', () => {
    const s = { signSecret: 'sec', appSecret: 'as', verificationToken: 'vt', encryptKey: 'ek' };
    expect(readBotSecrets(writeBotSecrets(s))).toEqual(s);
  });
  it('空串 → 空对象（不炸）', () => {
    expect(readBotSecrets('')).toEqual({});
  });
  it('密文不含明文（确有加密）', () => {
    const enc = writeBotSecrets({ appSecret: 'super-secret-value' });
    expect(enc).not.toContain('super-secret-value');
  });
});

describe('downloads · 商店链接与浏览器卡片', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('storeLinks 只有 chrome 一条（其余商店不提交审核，留空字段只会让页面误显示「审核中」）', () => {
    vi.stubEnv('BEACON_EXT_STORE_CHROME', 'https://chrome.example/x');
    const links = storeLinks();
    expect(links.chrome).toBe('https://chrome.example/x');
    expect(Object.keys(links)).toEqual(['chrome']);
  });

  it('Safari 卡片标注即将支持（install=coming），不给 crx', () => {
    const safari = BROWSER_CARDS.find((c) => c.key === 'safari');
    expect(safari?.install).toBe('coming');
  });

  it('Chromium 系卡片存在（Chrome/Edge/360）', () => {
    const keys = BROWSER_CARDS.filter((c) => c.engine === 'Chromium').map((c) => c.key);
    expect(keys).toEqual(expect.arrayContaining(['chrome', 'edge', 'threesixty']));
  });

  // 页面用 install==='store' 决定要不要显示「商店审核中」。只有 Chrome 是我们真提交的商店，
  // 别的卡片一旦被标成 store，页面就会挂出一个永远不会通过的「审核中」，等于骗用户白等。
  it('只有 Chrome 是 store 卡片，Edge/360/Brave 一律 unpacked', () => {
    const store = BROWSER_CARDS.filter((c) => c.install === 'store').map((c) => c.key);
    expect(store).toEqual(['chrome']);
    for (const key of ['edge', 'threesixty', 'brave']) {
      expect(BROWSER_CARDS.find((c) => c.key === key)?.install, `${key} 不该走商店`).toBe('unpacked');
    }
  });

  it('unpacked 卡片不带 store 渠道（带了就说明有人又把它接回商店流程了）', () => {
    for (const c of BROWSER_CARDS.filter((c) => c.install !== 'store')) {
      expect(c.store, `${c.key} 不该有 store 渠道`).toBeUndefined();
    }
  });
});
