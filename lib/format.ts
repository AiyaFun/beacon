export function fmtNum(n: number | undefined | null): string {
  const v = n ?? 0;
  if (v >= 100000000) return `${(v / 100000000).toFixed(1)}亿`;
  if (v >= 10000) return `${(v / 10000).toFixed(1)}w`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
}

export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

export function relTime(d: Date | string | null | undefined): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  const diff = Date.now() - date.getTime();
  const h = Math.floor(diff / 3600000);
  if (h < 1) return '刚刚';
  if (h < 24) return `${h}小时前`;
  const day = Math.floor(h / 24);
  return `${day}天前`;
}

export function scoreColor(score: number): string {
  if (score >= 75) return 'var(--green)';
  if (score >= 55) return 'var(--amber)';
  return 'var(--red)';
}
