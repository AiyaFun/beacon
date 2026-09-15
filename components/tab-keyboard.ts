import type { KeyboardEvent } from 'react';

/** Keep keyboard navigation within this tab list; click preserves each caller's state handling. */
export function onTabListKeyDown(event: KeyboardEvent<HTMLElement>) {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'));
  const current = tabs.findIndex((tab) => tab === event.target);
  if (current < 0 || !tabs.length) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0
    : event.key === 'End' ? tabs.length - 1
    : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next].focus();
  tabs[next].click();
}
