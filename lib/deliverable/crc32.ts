// CRC-32（IEEE 802.3，多项式 0xEDB88320）。zip 条目校验与 PNG 分块校验用的是同一套。
//
// 单独成文件是为了**能被客户端 import**：zip.ts 依赖 node:zlib，一旦被浏览器包引用就炸；
// 而图文卡的 PNG 元数据注入跑在浏览器 canvas 之后，只需要这一个纯函数。
//
// 入参是 Uint8Array 而非 Buffer：Buffer 本身就是 Uint8Array 的子类，服务端照常传 Buffer，
// 浏览器侧传 Uint8Array，一份实现两处用。

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (c >>> 8) ^ TABLE[(c ^ buf[i]) & 0xff];
  }
  return (c ^ 0xffffffff) >>> 0;
}
