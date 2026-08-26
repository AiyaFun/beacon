import Link from 'next/link';

// 「看效果」页顶部的三合一切换：数据看板 / 什么跑得动 / 平台怎么想。
//
// 服务端 view 参数切换，只渲染当前 tab（见 /data/page.tsx 早返回）——不是 PageTabs 的全渲染，
// 因为「平台怎么想」会调 LLM，全渲染等于每次访问都白烧一次。
const VIEWS = [
  { key: 'data', label: '数据看板', href: '/data' },
  { key: 'genes', label: '什么跑得动', href: '/data?view=genes' },
  { key: 'algorithm', label: '平台怎么想', href: '/data?view=algorithm' },
] as const;

export function EffectTabs({ active, inline }: { active: 'data' | 'genes' | 'algorithm'; /** 嵌进 HubHeader 行内时用，去掉整行下边框 */ inline?: boolean }) {
  return (
    <div className={`tabs${inline ? " tabs-inline" : ""}`} style={{ marginBottom: inline ? 0 : 16 }}>
      {VIEWS.map((v) => (
        <Link key={v.key} href={v.href} className={`tab${v.key === active ? ' active' : ''}`}>
          {v.label}
        </Link>
      ))}
    </div>
  );
}
