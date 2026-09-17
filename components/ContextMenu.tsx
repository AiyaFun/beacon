'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePortalReady } from './Overlay';

// 列表行的右键菜单。**和 Overlay 一样必须 portal 到 body**——理由同 Overlay 顶部那段：
// `.card:hover` 会给卡片加 transform，带 transform 的祖先会成为后代 position:fixed 的包含块，
// 就地渲染的菜单会被按住它的那张卡片截住（而右键菜单**恰恰**总是在指针悬停某张卡片时打开的，
// 本地随手点常常撞不到，用户每次都撞）。
//
// 【为什么不复用 Overlay】它是模态：锁背景滚动 + 半透明遮罩 + aria-modal。右键菜单不是模态，
// 锁滚动会让「右键看一眼再滚走」这个最常见的动作卡住。这里只借它的 usePortalReady。
//
// 【删除一律两步】菜单项填了 confirm，第一下只把这一行换成确认文案，第二下才真执行。
// 右键菜单本来就容易误触（指针已经压在行上、菜单在指针正下方），删除又不可撤销。

export type ContextMenuItem = {
  key: string;
  label: string;
  /** 危险动作：红字。配 confirm 一起用 */
  danger?: boolean;
  disabled?: boolean;
  /** 填了就要点两下：第一下把这一行换成这句话，第二下才真执行 */
  confirm?: string;
  /** 次要说明，灰字显示在标签下面（比如「连同 3 个版本一起删」） */
  hint?: string;
  onSelect: () => void | Promise<void>;
};

type OpenState = { x: number; y: number; items: ContextMenuItem[]; seq: number };

/**
 * 用法：在列表行上挂 `onContextMenu={(e) => menu.open(e, [...])}`，再把 `menu.node` 渲染出来
 * （放在列表任意位置都行，它自己 portal 走）。不需要给行套一层 wrapper——套 wrapper 会打坏
 * grid/flex 布局，这是这个 API 长这样的唯一原因。
 */
export function useContextMenu() {
  const [state, setState] = useState<OpenState | null>(null);
  /**
   * 每开一次 +1，当 panel 的 key 用。
   *
   * ⚠️ 不能省。菜单开着时右键**另一行**：document 上那个 capture 的 contextmenu 先 close、
   * 这一行的 React 处理器再 open，两次 setState 在同一个原生事件里被合批 —— panel 的
   * 类型和位置都没变，React 就**不会卸载它**，于是「等二次确认」的 armed 状态原样留给了新的一行：
   * 右键一下、再点一下，另一条就没了，中间一次确认都没有。key 变了才是真的换了一个菜单。
   */
  const seq = useRef(0);

  const open = useCallback((e: React.MouseEvent, items: ContextMenuItem[]) => {
    if (items.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    // 键盘激活（Enter/空格触发的 click）clientX/Y 是 0，菜单会飞到屏幕左上角。
    // 这时按触发元素自己的位置放。
    const kbd = e.clientX === 0 && e.clientY === 0;
    const r = kbd && e.currentTarget instanceof Element ? e.currentTarget.getBoundingClientRect() : null;
    seq.current += 1;
    setState({ x: r ? r.left : e.clientX, y: r ? r.bottom + 4 : e.clientY, items, seq: seq.current });
  }, []);

  const close = useCallback(() => setState(null), []);

  const node = state ? (
    <ContextMenuPanel key={state.seq} x={state.x} y={state.y} items={state.items} onClose={close} />
  ) : null;

  return { open, close, node, isOpen: state !== null };
}

/** useContextMenu() 的返回值。列表组件要把它往下传给行组件时用这个类型。 */
export type ContextMenuHandle = ReturnType<typeof useContextMenu>;

function ContextMenuPanel({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const ready = usePortalReady();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  /** 已经点过一次、正等第二下确认的那一项 */
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(false);

  // 量完再摆：贴着右边/下边打开时要翻到指针另一侧，否则菜单有一半在屏幕外点不到。
  //
  // ⚠️ ready 必须在依赖里。第一帧 ready=false（portal 还没挂），ref.current 是 null，
  // 这个 effect 只能空跑一趟；ready 翻成 true 时如果 x/y 没变就再也不跑第二趟——
  // 结果就是**翻转从来没生效过**，只有菜单本来就在屏幕内时看起来才是对的（连带首项也不会聚焦）。
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const pad = 8;
    let nx = x;
    let ny = y;
    if (nx + width > window.innerWidth - pad) nx = Math.max(pad, x - width);
    if (ny + height > window.innerHeight - pad) ny = Math.max(pad, y - height);
    setPos({ x: nx, y: ny });
    el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [x, y, ready]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (e.target instanceof Node && ref.current?.contains(e.target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    // 菜单是 fixed 定位的，页面一滚它就和那一行脱节了——脱节不如关掉
    const onScroll = () => { if (!busyRef.current) onClose(); };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('contextmenu', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    window.addEventListener('blur', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('contextmenu', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('blur', onScroll);
    };
  }, [onClose]);

  async function run(item: ContextMenuItem) {
    if (busyRef.current) return;
    if (item.confirm && armed !== item.key) {
      setArmed(item.key);
      return;
    }
    busyRef.current = true;
    setBusy(item.key);
    try {
      await item.onSelect();
    } catch (e) {
      // 菜单项十有八九调的是 server action，而「按设计拒绝」（RBAC / 配额）在这个项目里是**抛**出来的。
      // 不接住就是一个没人处理的 rejection：菜单关掉、界面一声不吭，用户以为删成功了。
      // 错误文案由调用方自己在 onSelect 里显示，这里只保证它不会变成静默失败。
      console.error('[ContextMenu] 菜单项执行失败', e);
    } finally {
      busyRef.current = false;
      onClose();
    }
  }

  function onKeyNav(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const btns = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    if (btns.length === 0) return;
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'ArrowDown' ? (i + 1) % btns.length : (i <= 0 ? btns.length - 1 : i - 1);
    btns[next].focus();
  }

  if (!ready) return null;

  return createPortal(
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={onKeyNav}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it) => {
        const waiting = it.confirm && armed === it.key;
        return (
          <button
            key={it.key}
            type="button"
            role="menuitem"
            className={`ctx-menu-item ${it.danger ? 'danger' : ''} ${waiting ? 'armed' : ''}`}
            disabled={it.disabled || (busy !== null && busy !== it.key)}
            onClick={() => void run(it)}
          >
            <span className="ctx-menu-label">
              {busy === it.key ? '…' : waiting ? it.confirm : it.label}
            </span>
            {it.hint && !waiting && busy !== it.key && <span className="ctx-menu-hint">{it.hint}</span>}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}

/**
 * 行尾那颗「⋯」。右键是给鼠标用户的快捷方式，**不能是唯一入口**——触屏没有右键、
 * 键盘用户也按不出来（藏功能这件事在这个项目栽过：插件竖条那次）。
 * 平时透明，悬停/聚焦时显形，点开的是同一份菜单。
 */
export function RowMoreButton({
  onOpen,
  label = '更多',
  /** 传 'row-more-abs' 把它绝对定位到行的右上角（行本身要有 .has-row-more） */
  className = '',
}: {
  onOpen: (e: React.MouseEvent) => void;
  label?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`row-more ${className}`}
      aria-label={label}
      title={label}
      onClick={onOpen}
      // 挂在 Link/卡片里面时，别让点击冒泡出去顺手触发跳转
      onMouseDown={(e) => e.stopPropagation()}
    >
      ⋯
    </button>
  );
}
