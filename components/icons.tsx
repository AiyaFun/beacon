// 轻量内联 SVG 图标集（避免外部依赖，CSP 友好）
type P = { className?: string; size?: number; style?: React.CSSProperties };
const base = (size = 18, style?: React.CSSProperties) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  style,
});

export const Icon = {
  home: (p: P) => (<svg {...base(p.size, p.style)} className={p.className}><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /></svg>),
  fire: (p: P) => (<svg {...base(p.size, p.style)} className={p.className}><path d="M12 3c1 3-2 4-2 7a4 4 0 0 0 8 0c0-1-1-2-1-3 2 1 3 3 3 6a8 8 0 1 1-15-1c0-4 5-5 4-9 .5.5 2 .8 3 0z" /></svg>),
  radar: (p: P) => (<svg {...base(p.size, p.style)} className={p.className}><path d="M12 3a9 9 0 1 0 9 9" /><path d="M12 12l6-4.5" /><circle cx="12" cy="12" r="1.5" /><path d="M12 12a5 5 0 1 0 4-2" /></svg>),
  user: (p: P) => (<svg {...base(p.size, p.style)} className={p.className}><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 4-6 8-6s8 2 8 6" /></svg>),
  bulb: (p: P) => (<svg {...base(p.size, p.style)} className={p.className}><path d="M9 18h6" /><path d="M10 21h4" /><path d="M12 3a6 6 0 0 0-4 10c1 1 1 2 1 3h6c0-1 0-2 1-3a6 6 0 0 0-4-10z" /></svg>),
  pen: (p: P) => (<svg {...base(p.size, p.style)} className={p.className}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>),
  shield: (p: P) => (<svg {...base(p.size, p.style)} className={p.className}><path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z" /><path d="M9 12l2 2 4-4" /></svg>),
  chart: (p: P) => (<svg {...base(p.size, p.style)} className={p.className}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></svg>),
  users: (p: P) => (<svg {...base(p.size, p.style)} className={p.className}><circle cx="9" cy="8" r="3.2" /><path d="M3 20c0-3 3-5 6-5s6 2 6 5" /><path d="M16 5.5a3 3 0 0 1 0 5.5" /><path d="M18 15c2 .5 3.5 2 3.5 4.5" /></svg>),
  gauge: (p: P) => (<svg {...base(p.size, p.style)} className={p.className}><path d="M12 14l4-4" /><path d="M4 18a8 8 0 1 1 16 0" /><circle cx="12" cy="14" r="1.4" /></svg>),
  cpu: (p: P) => (<svg {...base(p.size, p.style)} className={p.className}><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3" /></svg>),
  settings: (p: P) => (<svg {...base(p.size, p.style)} className={p.className}><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" /></svg>),
  chat: (p: P) => (<svg {...base(p.size, p.style)} className={p.className}><path d="M21 12a8 8 0 0 1-11 7.5L4 21l1.5-6A8 8 0 1 1 21 12z" /></svg>),
  check: (p: P) => (<svg {...base(p.size, p.style)} className={p.className}><path d="M5 12l5 5L20 6" /></svg>),
  x: (p: P) => (<svg {...base(p.size, p.style)} className={p.className}><path d="M6 6l12 12M18 6L6 18" /></svg>),
  refresh: (p: P) => (<svg {...base(p.size, p.style)} className={p.className}><path d="M21 12a9 9 0 1 1-3-6.7L21 7" /><path d="M21 3v4h-4" /></svg>),
  clock: (p: P) => (<svg {...base(p.size, p.style)} className={p.className}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></svg>),
  arrow: (p: P) => (<svg {...base(p.size, p.style)} className={p.className}><path d="M5 12h14M13 6l6 6-6 6" /></svg>),
  plus: (p: P) => (<svg {...base(p.size, p.style)} className={p.className}><path d="M12 5v14M5 12h14" /></svg>),
  sparkles: (p: P) => (<svg {...base(p.size, p.style)} className={p.className}><path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8z" /><path d="M18 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" /></svg>),
  upload: (p: P) => (<svg {...base(p.size, p.style)} className={p.className}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 10l5-5 5 5" /><path d="M12 5v10" /></svg>),
  download: (p: P) => (<svg {...base(p.size, p.style)} className={p.className}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 10l5 5 5-5" /><path d="M12 15V3" /></svg>),
  help: (p: P) => (<svg {...base(p.size, p.style)} className={p.className}><circle cx="12" cy="12" r="9" /><path d="M9.5 9.2a2.5 2.5 0 0 1 4.8 1c0 1.6-2.3 2-2.3 3.3" /><path d="M12 17h.01" /></svg>),
  edit: (p: P) => (<svg {...base(p.size, p.style)} className={p.className}><path d="M11 4H4v16h16v-7" /><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z" /></svg>),
  maximize: (p: P) => (<svg {...base(p.size, p.style)} className={p.className}><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></svg>),
  minimize: (p: P) => (<svg {...base(p.size, p.style)} className={p.className}><path d="M4 14h6v6M20 10h-6V4M10 14l-7 7M14 10l7-7" /></svg>),
  move: (p: P) => (<svg {...base(p.size, p.style)} className={p.className}><path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20" /></svg>),
  zoomIn: (p: P) => (<svg {...base(p.size, p.style)} className={p.className}><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /><line x1="11" y1="8" x2="11" y2="14" /><line x1="8" y1="11" x2="14" y2="11" /></svg>),
  zoomOut: (p: P) => (<svg {...base(p.size, p.style)} className={p.className}><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /><line x1="8" y1="11" x2="14" y2="11" /></svg>),
  eye: (p: P) => (<svg {...base(p.size, p.style)} className={p.className}><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>),
  chevron: (p: P) => (<svg {...base(p.size, p.style)} className={p.className}><path d="M6 9l6 6 6-6" /></svg>),
};

export type IconName = keyof typeof Icon;
