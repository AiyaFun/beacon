'use client';

import { useRef } from 'react';

// 带内联标注的正文编辑框。
//
// 原来「哪个词有问题」只在改写结果卡里以列表形式出现：写完一整篇才知道，而且只说命中了什么、
// 不说在哪儿——用户拿到「『最好』是慎用词」之后还得自己回正文里翻。现在直接标在字下面。
//
// 【实现】textarea 没法给局部文字上色，所以在它下面垫一层同字体同盒模型的镜像文本：
// 镜像层只画色块、文字全透明，真正看到的字来自上面的 textarea。样式对齐规则见 globals.css 的 .hl-wrap。
//
// 【为什么不用 contenteditable】那就等于富文本了：光标行为、输入法组合、粘贴清洗全都要自己接，
// 还会把「正文是纯文本」这条前提弄丢。textarea + 镜像层是用一点排版约束换整条数据链路不变。

export type Mark = {
  start: number;
  end: number;
  /** block=红线禁用词 warn=慎用词 ai=大模型套话 */
  kind: 'block' | 'warn' | 'ai';
};

export function HighlightedEditor({
  value,
  onChange,
  marks,
  placeholder,
  focusMode = false,
  rows = 12,
  minHeight,
  taRef,
  fontSize,
  lineHeight,
}: {
  value: string;
  onChange: (v: string) => void;
  marks: Mark[];
  placeholder?: string;
  focusMode?: boolean;
  rows?: number;
  minHeight?: number;
  /** 交给外部拿光标位置（markdown 工具条在光标处插入记号） */
  taRef?: React.RefObject<HTMLTextAreaElement | null>;
  fontSize?: number;
  lineHeight?: number;
}) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);

  return (
    <div
      className={`hl-wrap${focusMode ? ' is-focus' : ''}`}
      style={{ fontSize, lineHeight }}
    >
      <div className="hl-layer" ref={layerRef} aria-hidden="true">
        {renderSegments(value, marks)}
        {/* 末尾补一个换行：正文最后一行是空行时，镜像层不补就会比 textarea 少一行高度，
            滚到底部时两层错位一行 */}
        {'\n'}
      </div>
      <textarea
        className="textarea"
        ref={(el) => {
          innerRef.current = el;
          if (taRef) taRef.current = el;
        }}
        rows={rows}
        style={minHeight !== undefined ? { minHeight } : undefined}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        // 镜像层不会自己滚，得跟着 textarea 走，否则一滚动色块就留在原地
        onScroll={(e) => {
          const layer = layerRef.current;
          if (!layer) return;
          layer.scrollTop = e.currentTarget.scrollTop;
          layer.scrollLeft = e.currentTarget.scrollLeft;
        }}
        spellCheck={false}
      />
    </div>
  );
}

// marks 必须已按 start 升序且互不重叠（调用方负责）。这里再挡一次越界与回退，
// 因为 marks 来自 700ms 前那次诊断，正文可能已经变短了。
function renderSegments(text: string, marks: Mark[]): React.ReactNode[] {
  if (marks.length === 0) return [text];
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  marks.forEach((m, i) => {
    if (m.start < cursor || m.start >= text.length) return;
    const end = Math.min(m.end, text.length);
    if (end <= m.start) return;
    if (m.start > cursor) parts.push(text.slice(cursor, m.start));
    parts.push(
      <mark key={i} className={`k-${m.kind}`}>
        {text.slice(m.start, end)}
      </mark>,
    );
    cursor = end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}
