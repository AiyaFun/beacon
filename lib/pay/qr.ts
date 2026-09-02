// QR 码编码器（字节模式 + 纠错等级 M + 版本 1-10）→ SVG。零依赖。
//
// ── 为什么自己写而不是加 qrcode 依赖 ──────────────────────
// Native 扫码支付的产物是 code_url（weixin://wxpay/bizpayurl/... 一个 ≤64 字符的 ASCII 串），
// **必须**渲染成二维码，否则功能不成立（让用户复制 weixin:// 串去哪儿粘贴？扫码支付就是扫码）。
// 三个选项：
//   (a) 加 qrcode 依赖 —— 项目坚持零运行时依赖，且这是「处理真钱」的路径上多一个供应链面。
//   (b) 让用户复制 code_url —— 不是方案，是把功能做成占位。
//   (c) 自己实现 —— QR 编码是**规范完全公开、行为确定、可差分对拍**的算法。
// 选 (c) 的决定性理由是**可验证性**：正确性不靠「我觉得写对了」，而是拿 qrcode 库当参照物做
// 差分测试 —— 同一输入两边的模块矩阵必须逐 bit 相同。见 tests/pay/qr.test.ts 里固化的
// 参照向量（由 qrcode@1.5.4 生成，生成脚本在测试文件注释里，可复跑）。
// 差分对不上就是我错了，这条判据不含糊。这跟签名层拿官方向量对拍是同一个打法。
//
// 范围克制：只做 code_url 真正需要的那一小块 —— 字节模式、等级 M、版本 1-10
// （版本 10-M 可容纳 213 字节，而 code_url 上限 64 字节，头寸足够）。
// 不做数字/字母数字模式（省不了几个格子，多几百行分支就多几百行 bug）、
// 不做版本 11-40（用不上的容量 = 用不上的对齐图案表 = 没人验证过的代码）。

// ── GF(256) 伽罗瓦域（QR 用本原多项式 0x11D）────────────────
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** 生成多项式 g(x) = ∏(x - α^i)，i∈[0,degree) */
function rsGenerator(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** Reed-Solomon 纠错码字：数据多项式除以生成多项式取余 */
function rsEncode(data: Uint8Array, ecLen: number): Uint8Array {
  const gen = rsGenerator(ecLen);
  const res = new Uint8Array(data.length + ecLen);
  res.set(data);
  for (let i = 0; i < data.length; i++) {
    const factor = res[i];
    if (factor === 0) continue;
    for (let j = 0; j < gen.length; j++) res[i + j] ^= gfMul(gen[j], factor);
  }
  return res.subarray(data.length);
}

// ── 版本表（仅纠错等级 M）──────────────────────────────────
// [每块纠错码字数, 组1块数, 组1每块数据码字, 组2块数, 组2每块数据码字]
const VERSIONS_M: Record<number, [number, number, number, number, number]> = {
  1: [10, 1, 16, 0, 0],
  2: [16, 1, 28, 0, 0],
  3: [26, 1, 44, 0, 0],
  4: [18, 2, 32, 0, 0],
  5: [24, 2, 43, 0, 0],
  6: [16, 4, 27, 0, 0],
  7: [18, 4, 31, 0, 0],
  8: [22, 2, 38, 2, 39],
  9: [22, 3, 36, 2, 37],
  10: [26, 4, 43, 1, 44],
};

// 版本 2-6 尾部有 7 个剩余 bit；版本 1 与 7-13 为 0
const REMAINDER_BITS: Record<number, number> = { 1: 0, 2: 7, 3: 7, 4: 7, 5: 7, 6: 7, 7: 0, 8: 0, 9: 0, 10: 0 };

// 对齐图案中心坐标（版本 2-10）
const ALIGN_POS: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

function dataCodewordsOf(v: number): number {
  const [, b1, d1, b2, d2] = VERSIONS_M[v];
  return b1 * d1 + b2 * d2;
}

/** 字符计数指示符位宽：字节模式下版本 1-9 是 8 位，10-40 是 16 位 */
function countBitsOf(v: number): number {
  return v <= 9 ? 8 : 16;
}

function chooseVersion(byteLen: number): number {
  for (let v = 1; v <= 10; v++) {
    const need = 4 + countBitsOf(v) + byteLen * 8;
    if (need <= dataCodewordsOf(v) * 8) return v;
  }
  throw new Error(`内容过长（${byteLen} 字节），超出版本 10-M 的容量（213 字节）`);
}

// ── 位流 ───────────────────────────────────────────────────
class BitBuffer {
  private bits: number[] = [];
  put(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
  get length(): number {
    return this.bits.length;
  }
  toBytes(): Uint8Array {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((b, i) => {
      if (b) out[i >> 3] |= 0x80 >> (i & 7);
    });
    return out;
  }
}

/** 编码成数据码字（含终止符、补位、填充字节） */
function encodeData(bytes: Uint8Array, version: number): Uint8Array {
  const totalData = dataCodewordsOf(version);
  const capacityBits = totalData * 8;
  const buf = new BitBuffer();
  buf.put(0b0100, 4); // 字节模式
  buf.put(bytes.length, countBitsOf(version));
  for (const b of bytes) buf.put(b, 8);

  // 终止符：最多 4 个 0，不够就少放几个
  buf.put(0, Math.min(4, capacityBits - buf.length));
  // 补到整字节
  if (buf.length % 8 !== 0) buf.put(0, 8 - (buf.length % 8));

  const out = new Uint8Array(totalData);
  out.set(buf.toBytes());
  // 交替填充字节 0xEC / 0x11
  for (let i = buf.length / 8; i < totalData; i++) out[i] = (i - buf.length / 8) % 2 === 0 ? 0xec : 0x11;
  return out;
}

/** 分块 → 各块算 RS → 按规范交织（数据块逐列交织，纠错块同理） */
function buildCodewords(data: Uint8Array, version: number): Uint8Array {
  const [ecLen, b1, d1, b2, d2] = VERSIONS_M[version];
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (const [count, size] of [
    [b1, d1],
    [b2, d2],
  ]) {
    for (let i = 0; i < count; i++) {
      const block = data.subarray(offset, offset + size);
      offset += size;
      dataBlocks.push(block);
      ecBlocks.push(rsEncode(block, ecLen));
    }
  }

  const out: number[] = [];
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) for (const b of dataBlocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ecLen; i++) for (const b of ecBlocks) out.push(b[i]);
  return new Uint8Array(out);
}

// ── 矩阵 ───────────────────────────────────────────────────
type Matrix = { size: number; get(r: number, c: number): boolean; modules: Int8Array };

function newMatrix(size: number): Int8Array {
  return new Int8Array(size * size).fill(-1); // -1 = 未填
}

function placeFunctionPatterns(m: Int8Array, size: number, version: number): void {
  const set = (r: number, c: number, v: number) => {
    if (r >= 0 && r < size && c >= 0 && c < size) m[r * size + c] = v;
  };

  // 定位图案（三个角）+ 分隔符
  for (const [br, bc] of [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ]) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const inFinder = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const dark = inFinder && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        set(br + r, bc + c, dark ? 1 : 0);
      }
    }
  }

  // 定时图案
  for (let i = 8; i < size - 8; i++) {
    const v = i % 2 === 0 ? 1 : 0;
    m[6 * size + i] = v;
    m[i * size + 6] = v;
  }

  // 对齐图案（跳过与定位图案重叠的三处）
  const pos = ALIGN_POS[version];
  for (const r of pos) {
    for (const c of pos) {
      if ((r === 6 && c === 6) || (r === 6 && c === pos[pos.length - 1]) || (r === pos[pos.length - 1] && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          set(r + dr, c + dc, dark ? 1 : 0);
        }
      }
    }
  }

  // 固定黑点
  m[(size - 8) * size + 8] = 1;

  // 预留格式信息位（先占位为 0，稍后写入真值）
  for (let i = 0; i < 9; i++) {
    if (i !== 6) set(8, i, 0);
    if (i !== 6) set(i, 8, 0);
  }
  for (let i = 0; i < 8; i++) {
    set(8, size - 1 - i, 0);
    if (size - 1 - i !== size - 8) set(size - 1 - i, 8, 0);
  }

  // 预留版本信息位（版本 ≥ 7）
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        set(i, size - 11 + j, 0);
        set(size - 11 + j, i, 0);
      }
    }
  }
}

/** 功能图案占用区（数据不能落在这里）。与 placeFunctionPatterns 的覆盖范围必须一致。 */
function isFunction(r: number, c: number, size: number, version: number): boolean {
  if (r === 6 || c === 6) return true; // 定时
  if (r < 9 && c < 9) return true; // 左上定位+格式
  if (r < 9 && c >= size - 8) return true; // 右上
  if (r >= size - 8 && c < 9) return true; // 左下
  if (version >= 7 && ((r < 6 && c >= size - 11) || (c < 6 && r >= size - 11))) return true; // 版本信息
  const pos = ALIGN_POS[version];
  for (const ar of pos) {
    for (const ac of pos) {
      if ((ar === 6 && ac === 6) || (ar === 6 && ac === pos[pos.length - 1]) || (ar === pos[pos.length - 1] && ac === 6)) continue;
      if (Math.abs(r - ar) <= 2 && Math.abs(c - ac) <= 2) return true;
    }
  }
  return false;
}

/** 数据位按之字形从右下往上放（跳过第 6 列的定时图案） */
function placeData(m: Int8Array, size: number, version: number, codewords: Uint8Array, remainder: number): void {
  const totalBits = codewords.length * 8 + remainder;
  let bitIndex = 0;
  const nextBit = (): number => {
    if (bitIndex >= codewords.length * 8) return 0; // 剩余 bit 一律 0
    const b = (codewords[bitIndex >> 3] >> (7 - (bitIndex & 7))) & 1;
    return b;
  };

  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // 第 6 列是定时图案，整列跳过
    for (let v = 0; v < size; v++) {
      const row = upward ? size - 1 - v : v;
      for (let k = 0; k < 2; k++) {
        const col = right - k;
        if (isFunction(row, col, size, version)) continue;
        if (bitIndex >= totalBits) continue;
        m[row * size + col] = nextBit();
        bitIndex++;
      }
    }
    upward = !upward;
  }
}

const MASK_FN: ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMask(m: Int8Array, size: number, version: number, mask: number): Int8Array {
  const out = Int8Array.from(m);
  const fn = MASK_FN[mask];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (isFunction(r, c, size, version)) continue;
      if (fn(r, c)) out[r * size + c] ^= 1;
    }
  }
  return out;
}

// 格式信息：BCH(15,5)，生成多项式 0x537，最后异或掩码 0x5412
function formatBits(mask: number): number {
  const ECL_M = 0b00;
  let data = (ECL_M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) {
    rem <<= 1;
    if (rem & 0x400) rem ^= 0x537;
  }
  return (((data << 10) | rem) ^ 0x5412) & 0x7fff;
}

// 版本信息：BCH(18,6)，生成多项式 0x1F25
function versionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) {
    rem <<= 1;
    if (rem & 0x1000) rem ^= 0x1f25;
  }
  return ((version << 12) | rem) & 0x3ffff;
}

function writeFormatAndVersion(m: Int8Array, size: number, version: number, mask: number): void {
  const bits = formatBits(mask);
  for (let i = 0; i < 15; i++) {
    const bit = (bits >> i) & 1;
    // 左上：竖列 + 横行
    if (i < 6) m[i * size + 8] = bit;
    else if (i === 6) m[7 * size + 8] = bit;
    else if (i === 7) m[8 * size + 8] = bit;
    else if (i === 8) m[8 * size + 7] = bit;
    else m[8 * size + (14 - i)] = bit;
    // 副本：右上横行 + 左下竖列
    if (i < 8) m[8 * size + (size - 1 - i)] = bit;
    else m[(size - 15 + i) * size + 8] = bit;
  }
  m[(size - 8) * size + 8] = 1; // 固定黑点（不能被格式信息覆盖）

  if (version >= 7) {
    const vb = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = (vb >> i) & 1;
      const r = Math.floor(i / 3);
      const c = size - 11 + (i % 3);
      m[r * size + c] = bit;
      m[c * size + r] = bit;
    }
  }
}

// 掩码罚分（规范 §8.8.2 的四条规则，N1=3 N2=3 N3=40 N4=10）
function penalty(m: Int8Array, size: number): number {
  const at = (r: number, c: number) => m[r * size + c] === 1;
  let score = 0;

  // 规则1：行/列上连续同色 ≥5
  for (let i = 0; i < size; i++) {
    for (const isRow of [true, false]) {
      let run = 1;
      let prev = isRow ? at(i, 0) : at(0, i);
      for (let j = 1; j < size; j++) {
        const cur = isRow ? at(i, j) : at(j, i);
        if (cur === prev) run++;
        else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
          prev = cur;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }

  // 规则2：2×2 同色块
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = at(r, c);
      if (v === at(r, c + 1) && v === at(r + 1, c) && v === at(r + 1, c + 1)) score += 3;
    }
  }

  // 规则3：行/列中出现 10111010000 或 00001011101
  const P1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const P2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let i = 0; i < size; i++) {
    for (let j = 0; j <= size - 11; j++) {
      for (const isRow of [true, false]) {
        let m1 = true;
        let m2 = true;
        for (let k = 0; k < 11; k++) {
          const v = (isRow ? at(i, j + k) : at(j + k, i)) ? 1 : 0;
          if (v !== P1[k]) m1 = false;
          if (v !== P2[k]) m2 = false;
        }
        if (m1) score += 40;
        if (m2) score += 40;
      }
    }
  }

  // 规则4：深色模块占比偏离 50%
  let dark = 0;
  for (let i = 0; i < size * size; i++) if (m[i] === 1) dark++;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

/** 编码结果（含版本与选中的掩码号）。掩码号导出出来是为了让差分对拍能把「掩码偏好」这个
 *  启发式变量摘掉 —— 见 tests/pay/qr.test.ts 的黄金向量说明。 */
export type QrDetail = { matrix: boolean[][]; version: number; mask: number };

/** 编码成模块矩阵（true = 深色）。这是差分对拍的对象。 */
export function encodeQrDetail(text: string): QrDetail {
  const bytes = new Uint8Array(Buffer.from(text, 'utf8'));
  const version = chooseVersion(bytes.length);
  const size = version * 4 + 17;

  const codewords = buildCodewords(encodeData(bytes, version), version);
  const base = newMatrix(size);
  placeFunctionPatterns(base, size, version);
  placeData(base, size, version, codewords, REMAINDER_BITS[version]);

  // 八个掩码全试，取罚分最低的（规范 §7.8.3）
  let best: Int8Array | null = null;
  let bestMask = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const cand = applyMask(base, size, version, mask);
    writeFormatAndVersion(cand, size, version, mask);
    const s = penalty(cand, size);
    if (s < bestScore) {
      bestScore = s;
      best = cand;
      bestMask = mask;
    }
  }

  const m = best!;
  const matrix: boolean[][] = [];
  for (let r = 0; r < size; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < size; c++) row.push(m[r * size + c] === 1);
    matrix.push(row);
  }
  return { matrix, version, mask: bestMask };
}

export function encodeQrMatrix(text: string): boolean[][] {
  return encodeQrDetail(text).matrix;
}

/**
 * 渲染成 SVG 字符串。服务端生成，前端直接 dangerouslySetInnerHTML / <img src=data:>。
 * 用矩形路径合并同行连续深色模块 —— 比每个模块一个 <rect> 小一个数量级。
 */
export function renderQrSvg(text: string, opts: { size?: number; margin?: number; /** 读屏标签；默认是付款码的叫法，别的用途（微信绑定码）传自己的 */ label?: string } = {}): string {
  const matrix = encodeQrMatrix(text);
  const n = matrix.length;
  const margin = opts.margin ?? 4; // 规范要求的静区（quiet zone）≥4 模块，少了扫不出来
  const total = n + margin * 2;
  const px = opts.size ?? 280;

  let path = '';
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!matrix[r][c]) {
        c++;
        continue;
      }
      let len = 1;
      while (c + len < n && matrix[r][c + len]) len++;
      path += `M${c + margin} ${r + margin}h${len}v1h-${len}z`;
      c += len;
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${total} ${total}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="${opts.label ?? '微信支付二维码'}">` +
    `<rect width="${total}" height="${total}" fill="#fff"/>` +
    `<path d="${path}" fill="#000"/>` +
    `</svg>`
  );
}
