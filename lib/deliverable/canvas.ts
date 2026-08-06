// 图文卡的落图层：绘制指令 → canvas → 带 AIGC 隐式标识的 PNG 字节。
//
// 从 React 组件里拆出来，是为了它**能被单独跑起来验证**（浏览器里 import 这一个文件就能出图，
// 不用登录、不用起整个应用）。组件那边只剩状态与下载，逻辑都在这。
//
// 只用 DOM API，不 import 任何 node: 模块 —— 这条约束别破坏，破坏了客户端包就炸。

import type { Card, CardOp } from './card';
import { injectPngAigcMetadata } from './png-meta';

// 中文优先的字体栈：Mac 用苹方，Windows 用雅黑，都没有就退思源。
// 服务端不参与出图，所以字体是用户系统里的那套——同一张卡在不同系统上字形会有细微差别，这是已知取舍。
export const CARD_FONT_STACK =
  '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", "Source Han Sans SC", sans-serif';

export function drawCard(canvas: HTMLCanvasElement, card: Card): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  canvas.width = card.w;
  canvas.height = card.h;
  ctx.fillStyle = card.bg;
  ctx.fillRect(0, 0, card.w, card.h);
  ctx.textBaseline = 'top'; // 与 card.ts 的「y = 文本顶边」口径对齐，别改
  for (const op of card.ops) paintOp(ctx, op);
}

function paintOp(ctx: CanvasRenderingContext2D, op: CardOp): void {
  if (op.kind === 'rect') {
    ctx.fillStyle = op.fill;
    ctx.fillRect(op.x, op.y, op.w, op.h);
    return;
  }
  ctx.fillStyle = op.color;
  ctx.font = `${op.bold ? '700 ' : ''}${op.size}px ${CARD_FONT_STACK}`;
  ctx.textAlign = op.align ?? 'left';
  ctx.fillText(op.text, op.x, op.y);
}

/** canvas → PNG 字节，并把 AIGC 隐式标识写进 iTXt 分块（第五条）。 */
export async function cardToPng(canvas: HTMLCanvasElement, metadataJson: string): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('出图失败'))), 'image/png');
  });
  return injectPngAigcMetadata(new Uint8Array(await blob.arrayBuffer()), metadataJson);
}
