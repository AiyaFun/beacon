'use client';

import { useEffect, useState } from 'react';
import { CoverStation, type CoverQuota, type CoverText } from './CoverStation';
import type { MediaAssetSummary } from '@/lib/media/store';
import type { StylePreset } from './cover-actions';
import { TitleMatrixCard } from './TitleMatrixCard';

// 「标题与封面」tab 的容器：封面工位在上（这一 tab 的出成品动作），标题矩阵在下（它的输入之一）。
// 两者共享「封面大字 / 副字」这一份状态：标题矩阵每条标题旁的「作封面大字」、封面建议的
// 「用作封面文案」都写进来；「用这条」采纳标题时也顺手填进去——采纳的标题 = 封面主文案，这条链天然成立。
// 状态放在这里而不是提到 page 级：两个组件同属一个 tab，不需要跨 tab 传。

export function TitleCoverPanel({
  draftId,
  platform,
  draftTitle,
  hasContent,
  personaText,
  defaultStyleKey,
  defaultFontKey,
  quota,
  library,
  covers,
  coverAssetId,
  stylePresets,
}: {
  draftId?: string;
  platform?: string;
  draftTitle?: string;
  hasContent: boolean;
  personaText: string;
  /** 人设「品牌视觉」里设的默认封面风格 / 字体倾向（空 = 按赛道推荐 / 随风格） */
  defaultStyleKey?: string;
  defaultFontKey?: string;
  quota: CoverQuota;
  library: MediaAssetSummary[];
  covers: MediaAssetSummary[];
  coverAssetId: string | null;
  stylePresets: StylePreset[];
}) {
  const [coverText, setCoverText] = useState<CoverText>({ mainTitle: '', subTitle: '' });

  // 切草稿：上一篇的封面文案不该跟到这一篇
  useEffect(() => {
    setCoverText({ mainTitle: '', subTitle: '' });
  }, [draftId]);

  return (
    <div className="stack" style={{ gap: 18 }}>
      <CoverStation
        draftId={draftId}
        platform={platform}
        draftTitle={draftTitle}
        hasContent={hasContent}
        personaText={personaText}
        defaultStyleKey={defaultStyleKey}
        defaultFontKey={defaultFontKey}
        quota={quota}
        initialLibrary={library}
        initialCovers={covers}
        initialCoverAssetId={coverAssetId}
        initialStylePresets={stylePresets}
        coverText={coverText}
        onCoverTextChange={setCoverText}
      />
      <div className="divider" style={{ margin: 0 }} />
      <TitleMatrixCard
        draftId={draftId}
        onUseAsCover={(mainTitle, subTitle) =>
          setCoverText((prev) => ({ mainTitle, subTitle: subTitle ?? prev.subTitle }))
        }
      />
    </div>
  );
}
