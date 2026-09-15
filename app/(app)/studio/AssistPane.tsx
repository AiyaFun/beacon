'use client';

import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { TitleCoverPanel } from './TitleCoverPanel';
import { DeriveCard } from './DeriveCard';
import { DraftAdvisorCard } from './DraftAdvisorCard';
import { SkillPanel } from './SkillPanel';
import { IllustrationPanel } from './IllustrationPanel';
import type { CoverQuota } from './CoverStation';
import type { MediaAssetSummary } from '@/lib/media/store';
import type { StylePreset } from './cover-actions';
import type { FamilyMember } from '@/lib/studio/family';
import type { SkillSummary } from '@/lib/skills';

type AssistTabKey = 'polish' | 'cover' | 'multi';

export function AssistPane({
  draftId,
  platform,
  draftTitle,
  hasContent,
  personaText,
  defaultStyleKey,
  defaultFontKey,
  coverQuota,
  coverLibrary,
  draftCovers,
  coverAssetId,
  stylePresets,
  family,
  familyCoverCounts,
  wechatAiHint,
  draftSessionCount,
  draftAdoptedCount,
  skills,
  materials,
  draftIllustrations,
  illustrationStyles,
  onTriggerPolish,
  onTriggerCompliance,
  onTriggerToneRewrite,
  onDerivePlatform,
  isDirty,
  compliancePassed,
}: {
  draftId?: string;
  platform?: string;
  draftTitle?: string;
  hasContent: boolean;
  personaText: string;
  defaultStyleKey?: string;
  defaultFontKey?: string;
  coverQuota: CoverQuota;
  coverLibrary: MediaAssetSummary[];
  draftCovers: MediaAssetSummary[];
  coverAssetId: string | null;
  stylePresets: StylePreset[];
  family: FamilyMember[];
  familyCoverCounts: Record<string, number>;
  wechatAiHint: boolean;
  draftSessionCount: number;
  draftAdoptedCount: number;
  skills: SkillSummary[];
  materials: { id: string; type: string; content: string }[];
  /** 正文配图：这一篇已经出过的图 + 可选风格（入口见「标题封面」页签下的「给正文配图」） */
  draftIllustrations: { id?: string; url: string; scene: string; anchor?: string; aigcEmbedded: boolean }[];
  illustrationStyles: { key: string; name: string; hint: string }[];
  onTriggerPolish?: () => void;
  onTriggerCompliance?: () => void;
  onTriggerToneRewrite?: () => void;
  onDerivePlatform?: (targetPlatform: string) => void;
  isDirty?: boolean;
  compliancePassed?: boolean;
}) {
  const { lang } = useI18n();
  const isEn = lang === 'en';

  const [activeTab, setActiveTab] = useState<AssistTabKey>('polish');
  const [activeView, setActiveView] = useState<'cover' | 'advisor' | 'derive' | 'skill' | 'illust' | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  if (collapsed) {
    return (
      <aside
        className="surface assist-pane"
        style={{
          width: 42,
          minWidth: 42,
          padding: '12px 6px',
          alignItems: 'center',
          cursor: 'pointer',
        }}
        onClick={() => setCollapsed(false)}
        title={isEn ? 'Expand AI & Output Panel' : '展开 AI 与成品面板'}
      >
        <span
          style={{
            writingMode: 'vertical-rl',
            letterSpacing: 2,
            fontSize: 12,
            color: 'var(--text-2)',
            fontWeight: 600,
          }}
        >
          {isEn ? 'AI & Output' : 'AI 与成品'}
        </span>
      </aside>
    );
  }

  return (
    <aside className="surface assist-pane">
      <div className="surface-head">
        <strong>{isEn ? 'AI & Outputs' : 'AI 与成品'}</strong>
        <span
          className="meta"
          style={{ marginLeft: 'auto', cursor: 'pointer' }}
          onClick={() => setCollapsed(true)}
          role="button"
          tabIndex={0}
        >
          {isEn ? 'Collapse' : '可收起'}
        </span>
      </div>

      {activeView ? (
        <div className="stack" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          <div
            style={{
              padding: '8px 14px',
              borderBottom: '1px solid var(--border)',
              background: 'var(--surface-2)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <button
              type="button"
              className="btn small ghost"
              style={{ fontSize: 12, padding: '2px 8px' }}
              onClick={() => setActiveView(null)}
            >
              ← {isEn ? 'Back to Tools' : '返回工具'}
            </button>
            <span className="small muted">
              {activeView === 'cover' && (isEn ? 'Title & Cover Station' : '标题与封面工位')}
              {activeView === 'advisor' && (isEn ? 'Draft Reviewer' : '草稿多人物会诊')}
              {activeView === 'derive' && (isEn ? 'Multi-Platform Derivatives' : '一稿多平台')}
              {activeView === 'skill' && (isEn ? 'Formatted Output' : '技能出成品')}
              {activeView === 'illust' && (isEn ? 'Body Illustrations' : '正文配图')}
            </span>
          </div>

          <div style={{ padding: 14 }}>
            {activeView === 'cover' && (
              <TitleCoverPanel
                draftId={draftId}
                platform={platform}
                draftTitle={draftTitle}
                hasContent={hasContent}
                personaText={personaText}
                defaultStyleKey={defaultStyleKey}
                defaultFontKey={defaultFontKey}
                quota={coverQuota}
                library={coverLibrary}
                covers={draftCovers}
                coverAssetId={coverAssetId}
                stylePresets={stylePresets}
              />
            )}
            {activeView === 'advisor' && draftId && (
              <DraftAdvisorCard
                draftId={draftId}
                adoptedCount={draftAdoptedCount}
                sessionCount={draftSessionCount}
              />
            )}
            {activeView === 'derive' && (
              <DeriveCard
                draftId={draftId}
                currentPlatform={platform}
                family={family}
                coverCounts={familyCoverCounts}
                wechatHint={wechatAiHint}
              />
            )}
            {activeView === 'skill' && (
              <SkillPanel
                draftId={draftId}
                skills={skills}
                draftPlatform={platform}
                materials={materials}
              />
            )}
            {activeView === 'illust' && (
              <IllustrationPanel
                draftId={draftId}
                platform={platform}
                styles={illustrationStyles}
                existing={draftIllustrations}
              />
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="assist-tabs">
            <button
              type="button"
              className={`assist-tab ${activeTab === 'polish' ? 'active' : ''}`}
              onClick={() => setActiveTab('polish')}
            >
              {isEn ? 'Polish' : '打磨'}
            </button>
            <button
              type="button"
              className={`assist-tab ${activeTab === 'cover' ? 'active' : ''}`}
              onClick={() => setActiveTab('cover')}
            >
              {isEn ? 'Title & Cover' : '标题封面'}
            </button>
            <button
              type="button"
              className={`assist-tab ${activeTab === 'multi' ? 'active' : ''}`}
              onClick={() => setActiveTab('multi')}
            >
              {isEn ? 'Multi-Platform' : '多平台'}
            </button>
          </div>

          <div className="assist-content">
            {activeTab === 'polish' && (
              <div className="assist-panel active" id="assist-polish">
                <button
                  type="button"
                  className="tool-row"
                  onClick={() => {
                    if (onTriggerPolish) onTriggerPolish();
                  }}
                >
                  <strong>{isEn ? 'Structural Diagnostics' : '结构诊断'}</strong>
                  <span className="small muted">
                    {isEn ? 'Check hook, structure, length and engagement' : '检查钩子、结构、篇幅和互动引导'}
                  </span>
                </button>

                <button
                  type="button"
                  className="tool-row"
                  onClick={() => {
                    if (onTriggerToneRewrite) onTriggerToneRewrite();
                  }}
                >
                  <strong>{isEn ? 'Rewrite in Account Voice' : '按账号语气改写'}</strong>
                  <span className="small muted">
                    {isEn ? 'Use historical sentences and consistent speech habits' : '使用历史原句和稳定表达习惯'}
                  </span>
                </button>

                <button
                  type="button"
                  className="tool-row"
                  onClick={() => setActiveView('advisor')}
                >
                  <strong>{isEn ? 'Draft Consultation' : '草稿会诊'}</strong>
                  <span className="small muted">
                    {isEn ? 'Get revision advice from multiple character angles' : '从多个人物视角给出修改意见'}
                  </span>
                </button>
              </div>
            )}

            {activeTab === 'cover' && (
              <div className="assist-panel active" id="assist-cover">
                <button
                  type="button"
                  className="tool-row"
                  onClick={() => setActiveView('cover')}
                >
                  <strong>{isEn ? 'Generate 6 Titles' : '生成 6 个标题'}</strong>
                  <span className="small muted">
                    {isEn ? 'Distinct angles with automated compliance check' : '每个角度不同，并自动检查红线'}
                  </span>
                </button>

                <button
                  type="button"
                  className="tool-row"
                  onClick={() => setActiveView('cover')}
                >
                  <strong>{isEn ? 'Generate Cover' : '生成封面'}</strong>
                  <span className="small muted">
                    {isEn ? 'Auto ratio for platform with title on image' : '按目标平台比例，标题可直接上图'}
                  </span>
                </button>

                {/* 【2026-09-12 接回来的入口】正文配图的后端（actPlanIllustrationScenes /
                    actRunIllustration）一直是好的，而它在工坊里唯一的挂载点是 page.tsx 里一个
                    **从没进过 return 的 tabs 数组**——功能在、入口没了，且不报错。
                    更伤的是 /images 页至今写着「创作工坊 · 正文配图：按某一篇的正文自动拆成一组画面」，
                    照着这句话去工坊的人找不到任何东西。放在「标题封面」下：它和封面同属出图，
                    共用同一份日配额与留存窗口。 */}
                <button
                  type="button"
                  className="tool-row"
                  onClick={() => setActiveView('illust')}
                >
                  <strong>{isEn ? 'Illustrate the Body' : '给正文配图'}</strong>
                  <span className="small muted">
                    {isEn ? 'Break the draft into a coherent scene set, one consistent style' : '按正文自动拆成一组画面，风格保持一致'}
                  </span>
                </button>
              </div>
            )}

            {activeTab === 'multi' && (
              <div className="assist-panel active" id="assist-multi">
                <button
                  type="button"
                  className="tool-row"
                  onClick={() => {
                    if (onDerivePlatform) onDerivePlatform('xiaohongshu');
                    else setActiveView('derive');
                  }}
                >
                  <strong>{isEn ? 'Derive Xiaohongshu Variant' : '派生小红书版本'}</strong>
                  <span className="small muted">
                    {isEn ? 'Independent save, publish, and tracking loop' : '独立保存、发布和回流数据'}
                  </span>
                </button>

                <button
                  type="button"
                  className="tool-row"
                  onClick={() => {
                    if (onDerivePlatform) onDerivePlatform('douyin');
                    else setActiveView('derive');
                  }}
                >
                  <strong>{isEn ? 'Derive Douyin Script' : '派生抖音口播稿'}</strong>
                  <span className="small muted">
                    {isEn ? 'Preserve core arguments in spoken rhythm' : '保留核心观点，改成口语表达'}
                  </span>
                </button>
              </div>
            )}
          </div>

          <div className="readiness">
            <b>{compliancePassed === false ? (isEn ? 'Compliance Needs Review' : '合规有待处理') : (isEn ? 'Readiness Good' : '发布准备度良好')}</b>
            <br />
            {isDirty
              ? (isEn ? 'Draft modified. Save edits before export or publishing.' : '正文已修改，建议保存后再进行合规检查或发布。')
              : (isEn ? 'Draft saved. Ready for final compliance check and publishing.' : '正文已保存，建议先完成一次合规检查。')}
          </div>
        </>
      )}
    </aside>
  );
}
