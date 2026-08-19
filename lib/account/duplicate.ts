// 「这两个号其实是同一个号」的判定。纯函数、不碰库——服务端建号去重与网页端的
// 「疑似重复」提示共用同一份口径，两边口径不一致会出现最尴尬的那种情况：
// 页面提示你有重复，插件却照样又建一个。
//
// 【为什么会出现重复】账号有两条产生路径：
//   ① 网页里手填（用户写的是**昵称**：「Aiya哎呀」，handle 填 Aiyafun）
//   ② 插件在作品页就地建号（名字取页面上抓到的**用户名**：「aiyafun」）
// 两条路径给出的 name 天然对不上，于是同一个 X 号在库里躺成两条，数据从此一分为二——
// 而数据看板每一页都按 accountId 过滤，用户看到的是「一半数据不见了」。
//
// 【判据】平台必须相同（跨平台同名是常态，不能算重复），然后
// name/handle 四种交叉里任意一个规范化后相等即视为同一个号：
//   name↔name、handle↔handle、name↔handle、handle↔name。
// 后两种是这里的关键——真实重复恰恰是「一边把用户名当名字，另一边把它填进了 handle」。

/**
 * 规范化：去首尾空白、去掉 @ 前缀、去掉内部空白、转小写。
 * 空串返回 ''（调用方一律当「没有这个信息」，不参与比较）。
 */
export function normalizeAccountKey(raw: string | null | undefined): string {
  return (raw ?? '')
    .trim()
    .replace(/^@+/, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

export type AccountLike = { id?: string; name: string; platform: string; handle?: string | null };

/** 一个账号的全部可比较标识（去空去重） */
function keysOf(a: { name: string; handle?: string | null }): string[] {
  const keys = [normalizeAccountKey(a.name), normalizeAccountKey(a.handle)].filter(Boolean);
  return [...new Set(keys)];
}

/** 同平台 + 标识交叉命中 = 疑似同一个号 */
export function looksLikeSameAccount(a: AccountLike, b: AccountLike): boolean {
  if (a.platform !== b.platform) return false;
  const ka = keysOf(a);
  const kb = keysOf(b);
  return ka.some((k) => kb.includes(k));
}

/**
 * 找出疑似重复的分组（每组 ≥2 个账号，按传入顺序）。
 * 用并查集式的滚雪球合并：A≈B、B≈C 时三个归一组，避免同一批号弹出两条重叠提示。
 */
export function duplicateGroups<T extends AccountLike>(accounts: T[]): T[][] {
  const groups: T[][] = [];
  for (const acc of accounts) {
    const hit = groups.find((g) => g.some((m) => looksLikeSameAccount(m, acc)));
    if (hit) hit.push(acc);
    else groups.push([acc]);
  }
  return groups.filter((g) => g.length > 1);
}
