import { describe, it, expect } from 'vitest';
import { encodeQrDetail, encodeQrMatrix, renderQrSvg } from '@/lib/pay/qr';

// ── 这些黄金向量怎么来的（关系到这个测试值不值钱，务必读完再改）──────────────
//
// 由 **qrcode@1.5.4**（npm 上最主流的 QR 库，与我们的实现毫无血缘）生成，参数：
//   QRCode.create([{ data: text, mode: 'byte' }], { errorCorrectionLevel: 'M', maskPattern: <我们选中的掩码> })
// 存的是最终模块矩阵，按行主序每 8 个模块打包成 1 字节再 base64。
//
// 两个参数为什么要显式钉住（否则对拍会对出假警报，我在验证时**真的踩了这两个**）：
//   1. mode: 'byte' —— qrcode 库默认会做**混合模式分段优化**（把数字段用数字模式编码更省位），
//      我们只做字节模式。不钉住的话，含数字的输入（比如 pr=1234）两边码流天然不同，
//      看起来像 bug 实际不是。钉住后 425 例随机语料**脱掩码后数据区 100% 逐 bit 相同**。
//   2. maskPattern —— 掩码选择是纯启发式（选哪个都能扫，掩码号写在格式信息里）。
//      qrcode 库的罚分规则 N4 用的是 |ceil(percent/5) - 10|，而 ISO/IEC 18004 §7.8.3.1
//      的读法（ZXing 与 thonky 教程一致，我用 10001 个采样点验过两者完全等价）是
//      floor(|percent - 50| / 5)。两者在 percent 略大于 5 的倍数时分歧（如 52% → 库给 10 分、
//      规范给 0 分），会让极少数输入选到不同掩码（425 例里 5 例）。**我们实现的是规范读法**，
//      不跟库的这个非标算法。把掩码作为参数钉住，就把这个纯偏好变量从对拍里摘掉了 ——
//      剩下比的全是硬东西：版本选择 / 数据编码 / RS 纠错码字 / 分块交织 / 模块排布 /
//      功能图案 / 格式信息 / 版本信息。这不是挑数据：向量集是**先按原则定的**
//      （真实 code_url 形态 + 版本 1-10 每档容量边界 + 中文），24 例 24 例全过。
//
// 另外用 **jsQR**（独立解码器）做过 325 例解码回环：全部解回原文，证明我们生成的码真能被扫。
// jsQR / qrcode 都只在临时目录里当参照物用过，**没有进 package.json**（项目零运行时依赖）。
// 复跑脚本见 docs/微信支付接入.md「二维码方案」。
const GOLDEN: { text: string; version: number; mask: number; b64: string }[] = [
  { text: "weixin://wxpay/bizpayurl/up?pr=NwY5Mz9&groupid=00", version: 4, mask: 0, b64: "/kkVP8FqrtBujCIrt0yoZdupgHLsEgMpB/qqqv4A6d4Aqg9WiVRlVngMtxA56T0SrxKskGYZx0qXv68xkX8jCq958rxMNbbeJHtk16o58bGu5T0hCvdSRe31hrgmeR6BgZlwn311+oBARke/lZLq8E7wkQut4e+V0AiU1utRL3sEiu+C/p5FhYA=" },
  { text: "weixin://wxpay/bizpayurl?pr=abcdefg", version: 3, mask: 0, b64: "/koT/BXg0G6MSLt0uHXbrM8uwSn9B/qqr+AOGgCqCPCX4uVzVcywrpP94gdsLPA27XU8OXCj/iY6MHbwwxqPp3HuoLtGyL+Em7ov/YBJVHf58GpwSQ0ZusjPjdKmBe6gqHMEaPmv7s2RgA==" },
  { text: "weixin://wxpay/bizpayurl/up?pr=Zx8Kq2M&groupid=00", version: 4, mask: 0, b64: "/kkVP8FKrtBulCIrt0yoZduoAHLsEkMpB/qqqv4Ayd4Aqh9WiRRFVnhMrxA5oTkSryvkEGYAzwqXv+sxkW8CGq9R8qxMM/L8JHtFxio5+D3u5TytKvbBQS31NrpmeRahoZlgvn11/IBgRkc/lJLq8E6wkQutwe+V0ViU5usxL3sEiu+K/o5FhYA=" },
  { text: "a", version: 1, mask: 5, b64: "/lv8FZButLt1ZdukrsEZB/qv4BgAgrZ0wO5LmsCrPq09/4BkF/nT0ERHunTl0voul3cEfo/qkwA=" },
  { text: "烽火台中文测试", version: 2, mask: 0, b64: "/la/wVxQbo0Lt0V126v67BHhB/qq/gBBAKpuiRysdU3xW5cjWla5qQkF+cru5lCpHZ268vuAaEb/gSvQQjHLqp+d0e+y624TBN9G/tN5gA==" },
  { text: "xxxxxxxxxxxxxx", version: 1, mask: 0, b64: "/jv8FxBujrt05duorsE5B/qv4AYAqkCSZndQ3u86oiuuRABXd/ju8EYjuuRV0neurusEIi/uRYA=" },
  { text: "xxxxxxxxxxxxxxx", version: 2, mask: 0, b64: "/lS/wV3Qbo2rt0Xl26si7BFhB/qq/gDNAKpbiRqxk0fdIuqnKyBnl0IA5Tapai6Q3rK+c/wASUd/iWrwQhEbqo/V0Oh662lrBB3i/rOlgA==" },
  { text: 'x'.repeat(26), version: 2, mask: 0, b64: "/hU/wWqQboqrt09V26rS7BDpB/qq/gBaAKolCVzpU1WMovaoqy/510DDlTYYKi6bKrKT1fwAdUd/iurwTpE7q0/F0lhy6qlrBCni/tWlgA==" },
  { text: 'x'.repeat(27), version: 3, mask: 0, b64: "/gJT/BVikG6KSrt0uVXbrs0uwTHpB/qqr+AOKgCqSNCXgy1TWcjqLsKNqyn0NXQI8ZU3eRCi+Tsqshaw10PprVNu2Oou4G2rKvwz/ABlhHf5kWrwTyERutiPxdPOhy61aWsEWd4v6dOlgA==" },
  { text: 'x'.repeat(42), version: 3, mask: 0, b64: "/m1T/BeqkG6aqrt0xVXbqlUuwRKpB/qqr+AAqgCqVVCQZtVTdcSqLmtaqyG1VXRaZVU32Sqi/JGqsjN1V0NNFVNv6Kou4tqrKLRV/ABhVHf4qurwR6kTuoNPxdOFh+6hqWsEap4v7DWlgA==" },
  { text: 'x'.repeat(43), version: 4, mask: 2, b64: "/mqfP8EYklBuusGrt1oGtdut/KLsFMGtB/qqqv4BwXoAvibbPgC/bbDuwdCswRysE8T3KfzIiKsHDxzOssw7gkk8I1XLTOKlT7Dfisks2agg08GzI1TOg95bDv+Y0s05SXk/ui7b/IBKbcT/ldDq0F0sMcuuCe/N1JsGRuo+sYkEgkps/sPLnQA=" },
  { text: 'x'.repeat(62), version: 4, mask: 0, b64: "/n1VP8FyqpBuhKqrt0dVVduq1VLsEKqpB/qqqv4A2qoAqnVVCSbJVVN87Kqi6j+qqyMitVdFpcVVNErSqi/gjqqy9sNVdCquVVNGw6qi8LOqqyamdVdCjWVVNpkqqi6DQqqzs/FV/QBsVUd/larq8ElqkSurVU/F0yVYdutiqWsEsqni/rFVpYA=" },
  { text: 'x'.repeat(63), version: 5, mask: 2, b64: "/i9q6/wTlaCQbr3vJLt1NbTV260Jtq7BX9FJB/qqqq/gGKASAL4wP+viTN4Da7S0i2QXm81KJRj8zLb6fndvtrgZRRJBarbs0lHbOJVvoQTrV2uf1O0EFvHSeSUa5r2m+lZATba52PyKQXosIBJRnqY/76RsTgNrquYLZBcAZUolKWXstvsAc2+0e/n9EitwXqzREbrilf+l1ktXv66/7SdTBJp5EB/r/bYrgA==" },
  { text: 'x'.repeat(84), version: 5, mask: 0, b64: "/lFVU/wUnqqQboSqqrt0nlVV263FVS7BHCqpB/qqqq/gCrqqAKpP1VCUTblVU3PhKqovmkKqqyzxNVV0GjhVVTauwqqi958qqrJriVVXRsIFVVN20aqqLuCmqqsn5/VVdF6+VVU02pKqov8F6qqy1ltVV0ApFVVTYMWqqi6LhqqrK6aVVf2AWVVUd/iyqurwTCqpErq9VU/F0XVVhy64qqlvBJaqni/t1VWlgA==" },
  { text: 'x'.repeat(85), version: 6, mask: 0, b64: "/lpRUT/BXdqakG6FWjort0GNnZXbr6dXUuwQ/qqpB/qqqqr+AJGqqgCqfdVVCVgOFVVTU/lKqqL1mfqqqynw1V1bQaFhnZ40P9KOji5JjKmpskeExUV0Ul61dVN/x+srIv+Iji4rIGRLExdGqOlFRTd+dqqqL/gEqqqwB0zVVXX6MBVVU2bKaqqy7yTaqq8sYe3V1UPj1dnaNnyC6Ogu+m+amrKan1RU/ABXF1dHf5pSsurwT5Li0SuqsTEvxdJCVFhy6iSqqW8Efeqp4v7HdVWlgA==" },
  { text: 'x'.repeat(106), version: 6, mask: 3, b64: "/r3bbb/BXmSSUG6fxJJLt1ILbbXbpkttsuwRcJJJB/qqqqr+AZeSSQC3dW22pfqELbbdQvcySSzGFOJJJRa+fbbZei9ZttsMia5JJBdDpkkkilc8NttMzmZ222u9j4kkmhO4aSSTzmaO22+gBQrbbdWLFSSSzcNjJJJQH8/bbZeCxhttsO2tpJJBZ4VkkkioIvNttMkgn222uo9qkkmgEfGSSTx7gG22+gBZLbbFf6zySWrQVeJJERuiy7bP/dV4ttZG6gxJJ1cEhckn2v7RttudAA==" },
  { text: 'x'.repeat(107), version: 7, mask: 2, b64: "/gpXVkv8Eiwv5pBuuio6dLt1ivRGNdup3f9jrsF0FE5BB/qqqqqv4BwNFTwAvg0vg1PgAX92sOjQ1gFfK+3AoHBDxc2lxrE1BIwLbqEOjw0wZ8q+xCbGlTxcJlzgA1BJiZ56sOjx8ud/K+1JaWETxcP8Hvw1/PxY5EsMTWsxK3Lqyx7TFT0c/8nfg0/JhG3SsEDWjxnfLUyzPUtr7/1uC4iUrJBewS4ED6yNv6rUzRmklT787uOpg0rNp9LWsEDCyJjfLUzxkk/T78m+Y/o0/IB8rHsET/js6nKq0FUTFT0cutIvg1/N18sWsJRustMfLg0E4b5H2s/oo1l0fQA=" },
  { text: 'x'.repeat(122), version: 7, mask: 0, b64: "/mjZbov8FsOh3pBug6mkRLt0nheINduvJf7vrsEiPF3BB/qqqqqv4AiLHd8Aqlbvu7CWKR30iAte+OTxEw5CqILd/S7p7sO7PGSFn0iAte6yTxEw/QWoLd/STjjsO7PCyV30iAtj60TxEw/DWYLd/Sj7pvu7/HxS3EiEdat+KxFq8xFZHd8Sz7o/u6/HpM5ciKNYzepRFa85JSjd1z7gO2u6lHLApciKNs8LpRFa57o6jd1yggA2u6lDjx1ciKNC8XpRFa7zoqjd1ympm/u6/AB7lEiMd/mjaxEq8E6VHd8SupHvu7/F0CqIiHdusCERFu8EWd3d4i/sm7u6RYA=" },
  { text: 'x'.repeat(123), version: 8, mask: 0, b64: "/jY2xEC/wUNx5mfQbojAJERrt0WSmIgl26pfPu7C7BHi0d3RB/qqqqqq/gAgFF3fAKpXt/u6iR56c8iIS1G8YtEREOcz+x3d3SywRdu7s8OBY6iIgLbqpfkREw7gPKnIi9IeSreu7zwiFdOCIgtW+bqTu7DgvusZ3f0ua5Vfu7PHiS06iIC3P72vkRPuERF8Xd8SOrqyu7qsFFohGIhHX+c7+RE+4KrPcd3nJC9GubupQ8rwaoiKNr1bl5EVrzrWFmZlcWahlREQlDzgsC3do0OakjzM2uwFrzXd1yF1iTG7qULjTiKIijUdKDORFa7hQDdd3XLjgPP7uvwAS9MYiMd/i0KpESrwQRvF3fErqN3/u7/F0tuViId263BmERbvBN4qSIoi/vrWLu5FgA==" },
  { text: 'x'.repeat(152), version: 8, mask: 2, b64: "/lDg1gi/wQkJPlHQbrYFynxrt1YcsGul26x+f2DC7BUNEeUxB/qqqqqq/gEY1FPnAL40O+NYviB0S2sGM5K9AR8p038YdSU+cx86e7g1iyUoobawYzq5o5HynTdKSJJT5zEmwxuDWLJAoAtrBjOYw3kfKdNgL0UlPnMR5aW4NYslqcq2sGM5/jef8p/3ETicU+cROtk+o1mqRFQZGwZHk/dY/ym/fC0FTT5ZFTNd0jWRpQEArLBpuuvNi3KbluEiVNPlkVJ2nSNZGlxUWssGm5yicLcpuXSlMU0+WRb6KdI1kaDLJaywabke5Atym5bjWdTT5ZHj43/jWfoAResbBse/k6mvKetwXpnFPnEbquG+NY+l1AuZsGT+6u4ecpjRBGrZk+bB/tlYY1nLgA==" },
  { text: 'x'.repeat(153), version: 9, mask: 0, b64: "/lvutuwj/BefMB3nkG6BwKpGRLt0wOE4qNXbrR1f7+ouwTP7xdnxB/qqqqqqr+AMCrHt3wCqAa77O7CQQbRfTIgLTdhST1ETDnJhaCnd/S4mmWx7uzwEx2n2iIC0Hf0k+REw6pnUgtXf0mdoBsObs8PGRl9JiAtbztVPCRMOqdu8Ldj9IDURTDvrPERywviKALYZ2iLRGzD9tFuT3tfS39bu+7OfxEdq1EjJR36/KGsVDq9RVgkc3fEt/O7/q7r8Zn4NVAiKN89zA1MRWvUoXKxd3XDKJqdJu6lHB2BW2IijcuwwJJEVryIp+o2d1yKgA3a/upRgZs1cqIo1rlPKUZFa8Cb7KN1tcl/Z22u5KUSB5kXInKN3qL4lENWuwZPqjc2XIS/If7q+/ABsoUSArHf47xKxMarwSCnx7d8SuuFE+zu/xdIWIIyIdy6myTFRFukEklHJ3eIv7xV6+7pFgA==" },
  { text: 'x'.repeat(180), version: 9, mask: 0, b64: "/l7tlu6j/Be2Oh3fkG6AcJpERLt0yGF4iFXbrP1f7u4uwTf7xd3RB/qqqqqqr+AMCrHd3wCqAY77u7CQQbZfSIgLTdhSTxETDnFhaC3d/S0mmOw7uzwUh2X0iIC0Hv0k8REw7qnXgt3f0laIHsO7s8NIQt9IiAtztlRPERMPiZ+4Ld39JLPZbDu7PCJRwfSIgLQ5zSTxETD8tQeC3d/SX8zO+7u/xEeb3EiIR367ICsRFq9RVskd3fEt/Oz/u7r8ZH4dXIiKN+9zAlERWvUoXKjd3XLKJr9ru6lfB2AVyIijeuw0JREVrwIp2o3d1yG2E3a7upRg9oVciIo07V2iURFa6iILqN3dch+CX2u7qUKF4lXIiKN3rp4lERWuwIXqjd3XIS5of7u6/ABqgUSIjHf4roaxESrwSy2R3d8SuuFi+7u/xdIXKIiId26myRERFukEklnd3eIv7xX7u7pFgA==" },
  { text: 'x'.repeat(181), version: 10, mask: 2, b64: "/mGz1ghnP8EZq35SppBuqHUKHKfLt1ZrIHsGJduvGrvo1hLsFWpXHT5RB/qqqqqqqv4Bc1zHpSwAvjEbfxglPlR7FtsmuOj+zbMnIfC+0KYFCj1bxcuzGd61AVBM57VE8CoOj9xXPzLeq+16JlET5Txei1UXQ1g1BUJ6G9sGsOj01TYnKfK+0DZliX7jxcj01VZ1q1BMCSLdkH8OjHkywnqDK+0CZriS5TxcD2U1Ylg1BIDiEduGsuj39KwvifM+yRahhHZQ0cOuw1K3g8rMRl0fEWtMTr9Y2/sfb+w4QxT79X78Y+y0iUh0rLamUIEOkEDghOwdq/rUpZjBL75T78Y4mvYVg0rC6nXukGsEDvnO6pqfLUwpDACr4D78b6HVCV00rKqXYsEEMEDsmPK9qVLU2xrCD45Tb8IundDdg2rKzrZsBGsUDpuOa9afNU3wrCD3pS78A2C9Pxgk/IBr9tEmuET/mkYqofCq0FrixH1b0cuuK7/1AV/N1pNHQCoJQuo8forergkEYykv5T2s/oY1XVg0fQA=" },
  { text: 'x'.repeat(213), version: 10, mask: 0, b64: "/npd7u7rP8FTo53d3pBulJCERETLt0TpGIiIJdupolvu7tLsEWn5Hd3RB/qqqqqqqv4AS7tF3d8AqlIXf7u7CQ727TiIiAt09JApEREw7oWrsd3d/Sq9cTW7u7PDj2LjiIiAt0/dApEREw6Y3rcd3d/Qs5aNW7u7PaDUJDiIiAt6/dupEREw6Jnksd3d/Stz7rW7u7PCLIKTiIiAtJ79upEREw+KXrsd3d/SN5bbW7u7PCKoGTiIiAtr78+vkRE+6RavvF3d8S+oi7K7u6rExo6RGIiEdv7Q6/kRF+/xdft13d1yawi5Mbu6lFwrqyKIiKMmrC4zkRFa2TtvN13d1yXyo1Mbu6lMwpZyKIiKNgrBszkRFa+j9CN13d1yW2ojMbu6lEwhSiKIiKNTphMzkRFa6zpKN13d1ymxIzMbu6lC4pTiKIiKNpwAUzkRFa/zvMN13d1yA4CzP7u6/ABmTjGIiMd/gqUqkREq8EkcvF3d8Suoexf7u7/F0kTxeIiHeus2UmkRFusEW8eh3d4i/sWvZbu6RYA=" },
];

function unpack(b64: string, size: number): boolean[][] {
  const bytes = Buffer.from(b64, 'base64');
  const out: boolean[][] = [];
  for (let r = 0; r < size; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < size; c++) {
      const i = r * size + c;
      row.push((bytes[i >> 3] & (0x80 >> (i & 7))) !== 0);
    }
    out.push(row);
  }
  return out;
}

describe('pay/qr · 与 qrcode@1.5.4 的黄金向量逐 bit 对拍', () => {
  for (const g of GOLDEN) {
    const label = /^x+$/.test(g.text) ? `${g.text.length} 字节` : JSON.stringify(g.text.slice(0, 34));
    it(`v${g.version} mask${g.mask} · ${label}`, () => {
      const d = encodeQrDetail(g.text);
      expect(d.version).toBe(g.version);
      expect(d.mask).toBe(g.mask);
      expect(d.matrix.length).toBe(g.version * 4 + 17);
      expect(d.matrix).toEqual(unpack(g.b64, g.version * 4 + 17));
    });
  }

  it('向量集覆盖版本 1-10 全部十档', () => {
    expect([...new Set(GOLDEN.map((g) => g.version))].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

describe('pay/qr · 版本选择边界', () => {
  // 每档 M 级字节模式容量：v1=14 v2=26 v3=42 v4=62 v5=84 v6=106 v7=122 v8=152 v9=180 v10=213
  const CAP: [number, number][] = [
    [14, 1],
    [15, 2],
    [26, 2],
    [27, 3],
    [42, 3],
    [43, 4],
    [62, 4],
    [63, 5],
    [84, 5],
    [85, 6],
    [106, 6],
    [107, 7],
    [122, 7],
    [123, 8],
    [152, 8],
    [153, 9],
    [180, 9],
    [181, 10],
    [213, 10],
  ];
  for (const [len, v] of CAP) {
    it(`${len} 字节 → 版本 ${v}`, () => {
      expect(encodeQrDetail('x'.repeat(len)).version).toBe(v);
    });
  }

  it('超出版本 10-M 容量（>213 字节）→ 明确报错，不静默截断', () => {
    // 静默截断 = 生成一个能扫但内容是半截 code_url 的二维码 = 用户付款到一个不存在的单
    expect(() => encodeQrMatrix('x'.repeat(214))).toThrow(/内容过长/);
  });

  it('真实 code_url（≤64 字节）落在版本 4-5，离上限很远', () => {
    const d = encodeQrDetail('weixin://wxpay/bizpayurl/up?pr=NwY5Mz9&groupid=00');
    expect(d.version).toBeLessThanOrEqual(5);
  });

  it('中文按 UTF-8 字节数算容量（不是字符数）', () => {
    expect(encodeQrDetail('中'.repeat(71)).version).toBe(10); // 71*3 = 213 字节，正好塞满 v10
    expect(() => encodeQrMatrix('中'.repeat(72))).toThrow(/内容过长/); // 216 字节 → 溢出
  });
});

describe('pay/qr · 结构不变式', () => {
  const m = encodeQrMatrix('weixin://wxpay/bizpayurl/up?pr=NwY5Mz9&groupid=00');
  const n = m.length;

  it('尺寸 = 版本 × 4 + 17，且为奇数', () => {
    expect(n).toBe(4 * 4 + 17);
    expect(n % 2).toBe(1);
  });

  it('三个角有 7×7 定位图案（缺一个就扫不出来）', () => {
    for (const [br, bc] of [
      [0, 0],
      [0, n - 7],
      [n - 7, 0],
    ]) {
      for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 7; c++) {
          const dark = r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
          expect(m[br + r][bc + c]).toBe(dark);
        }
      }
    }
  });

  it('右下角**没有**定位图案（有的话就不是 QR 码了）', () => {
    let dark = 0;
    for (let r = n - 7; r < n; r++) for (let c = n - 7; c < n; c++) if (m[r][c]) dark++;
    expect(dark).toBeLessThan(40); // 真定位图案是 33 个深色且严格成型，这里只要求不成型
  });

  it('定时图案：第 6 行/列黑白交替', () => {
    for (let i = 8; i < n - 8; i++) {
      expect(m[6][i]).toBe(i % 2 === 0);
      expect(m[i][6]).toBe(i % 2 === 0);
    }
  });

  it('固定黑点常在（规范要求 (size-8, 8) 恒为深色）', () => {
    expect(m[n - 8][8]).toBe(true);
  });

  it('深色占比在 40%-60%（掩码选择真的在干活）', () => {
    const dark = m.flat().filter(Boolean).length;
    const pct = (dark * 100) / (n * n);
    expect(pct).toBeGreaterThan(40);
    expect(pct).toBeLessThan(60);
  });

  it('同一输入两次编码结果相同（确定性，无随机）', () => {
    const t = 'weixin://wxpay/bizpayurl/up?pr=Test123&groupid=00';
    expect(encodeQrMatrix(t)).toEqual(encodeQrMatrix(t));
  });

  it('不同 code_url → 不同矩阵', () => {
    expect(encodeQrMatrix('weixin://wxpay/bizpayurl?pr=aaa')).not.toEqual(encodeQrMatrix('weixin://wxpay/bizpayurl?pr=bbb'));
  });
});

describe('pay/qr · SVG 渲染', () => {
  const url = 'weixin://wxpay/bizpayurl/up?pr=NwY5Mz9&groupid=00';

  it('产出自包含 SVG（无外部引用，可直接内联）', () => {
    const svg = renderQrSvg(url);
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)/); // 除命名空间外不得有外链
  });

  it('含静区（quiet zone）≥4 模块 —— 少了扫不出来', () => {
    const n = encodeQrMatrix(url).length;
    expect(renderQrSvg(url)).toContain(`viewBox="0 0 ${n + 8} ${n + 8}"`);
    expect(renderQrSvg(url, { margin: 6 })).toContain(`viewBox="0 0 ${n + 12} ${n + 12}"`);
  });

  it('白底 + 黑模块（反色扫不出来）', () => {
    const svg = renderQrSvg(url);
    expect(svg).toContain('fill="#fff"');
    expect(svg).toContain('fill="#000"');
  });

  it('尺寸可控，且默认给出无障碍标签', () => {
    expect(renderQrSvg(url, { size: 320 })).toContain('width="320" height="320"');
    expect(renderQrSvg(url)).toContain('role="img"');
  });

  it('同行连续深色模块被合并成一条路径指令（体积优化真的生效）', () => {
    // 每模块一个 rect 的话，v4 码会有几百个元素；合并后路径指令数应远少于模块数
    const svg = renderQrSvg(url);
    const cmds = (svg.match(/M/g) ?? []).length;
    const darkModules = encodeQrMatrix(url).flat().filter(Boolean).length;
    expect(cmds).toBeLessThan(darkModules);
  });

  it('SVG 里不出现 code_url 原文（二维码是图，不该把原文也漏进 DOM）', () => {
    expect(renderQrSvg(url)).not.toContain('bizpayurl');
  });
});
