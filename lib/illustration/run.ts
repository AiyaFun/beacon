import crypto from 'node:crypto';
import { llmImage } from '../llm/image';
import { llmComplete } from '../llm/gateway';
import { redlineHits, redlineReason } from '../compliance/engine';
import { aigcMetadataJson } from '../compliance/aigc';
import { injectImageAigcMetadata } from '../deliverable/image-meta';
import { saveMediaAsset, readMediaDataUri } from '../media/store';
import { coverSpec, specForPlatform } from '../cover/specs';
import { coverStyle } from '../cover/styles';
import { MAX_COVER_IMAGES, MAX_SUBJECT_IMAGES } from '../cover/rules';
import { parseJson } from '../json';
import { createLogger } from '../logger';

const log = createLogger({ module: 'illustration' });

// ── 全域配图：把生图从「封面」扩到正文插图 / 小红书组图 / 素材库 ────────────────
//
// 【与封面的分工】封面是**一张**要把标题写上去的门面图（lib/cover/run.ts 有一整套
// 抽标题 → 上字 → 红线检文字的逻辑）。配图不一样：它是一组**不上字**的画面，
// 跟着正文的段落走，风格必须一致。硬塞进 runCover 会让那条链路长出一堆
// 「这次不要标题」的分支，两边都变难读。
//
// 【共用的东西一个都不重写】出图走同一个 llmImage（同一套配额/预算/记账闸），
// 打标走同一个 injectImageAigcMetadata，落库走同一个 saveMediaAsset。
// 这三样任何一样在这里重写一遍，早晚会出现「配图不打 AIGC 标识」这种合规事故。
//
// 【为什么不上字】中文上字是生图模型最不稳的部分（封面那条链路至今标着「待真机校准」）。
// 正文配图一旦把字画错，整张就废了，而封面还能靠重出。所以配图一律走「纯画面 + 禁止文字」，
// 要文字请用封面工位。

export const MAX_ILLUSTRATIONS = MAX_COVER_IMAGES;

export type IllustrationScene = {
  /** 这张图画什么（一句话，喂给生图模型） */
  scene: string;
  /** 对应正文的哪一段（给用户看的定位，不进提示词） */
  anchor?: string;
};

export type IllustrationInput = {
  tenantId: string;
  workspaceId?: string;
  accountId?: string | null;
  draftId?: string | null;
  platform: string;
  /** 比例；缺省按平台推（小红书组图默认 3:4） */
  specKey?: string;
  styleKey?: string;
  /** 直接给画面清单；不给就用 planScenes 从正文拆 */
  scenes?: IllustrationScene[];
  /** 补充要求（不上字这条是硬的，用户写什么都不会让它上字） */
  extra?: string;
  /** 参考图（保持人物/产品一致），与封面同一批额度口径 */
  referenceAssetIds?: string[];
  onProgress?: (step: 'plan' | 'image' | 'tag', message: string) => void;
};

export type IllustrationImage = {
  id?: string;
  url: string;
  mime: string;
  scene: string;
  anchor?: string;
  bytes: number;
  aigcEmbedded: boolean;
};

export type IllustrationResult =
  | { ok: true; images: IllustrationImage[]; scenes: IllustrationScene[]; model: string; source: 'platform' | 'byok' }
  | { ok: false; error: string; reason: 'not_configured' | 'quota' | 'failed' | 'input' | 'redline' };

/** 组图的画面清单：把正文拆成 n 个可画的画面。拆不出来就如实返回空，不硬编。 */
export async function planScenes(
  tenantId: string,
  input: { title: string; content: string; count: number; platform: string },
): Promise<IllustrationScene[]> {
  const count = Math.min(Math.max(1, input.count), MAX_ILLUSTRATIONS);
  const body = input.content.slice(0, 3000);
  if (!body.trim()) return [];

  const res = await llmComplete(
    tenantId,
    'generation',
    [
      {
        role: 'system',
        content: [
          '你把一篇稿子拆成一组可以画出来的画面，用于社交平台的图文配图。',
          `一共 ${count} 张，按正文顺序推进，风格要能保持一致（同一场景/同一主体/同一色调）。`,
          '每张给两段：scene = 画面描述（只描述看得见的东西：主体、动作、环境、光线、构图），',
          'anchor = 它对应正文里的哪句话（原文摘录，10-25 字）。',
          '**画面里不要有任何文字、标题、水印、二维码**——文字由排版环节另外加。',
          '只输出 JSON：{"scenes":[{"scene":"...","anchor":"..."}]}',
        ].join('\n'),
      },
      { role: 'user', content: `标题：${input.title}\n\n正文：\n${body}` },
    ],
    { temperature: 0.6, json: true },
  );

  // Mock 模型给的是示例文案，拿它去烧真实出图的钱是纯浪费——如实返回空，
  // 由调用方提示用户手写画面或先配模型。
  if (res.mocked) {
    log.warn('拆画面走了 Mock，不用它的结果');
    return [];
  }
  const parsed = parseJson<{ scenes?: IllustrationScene[] }>(res.text, {});
  return (parsed.scenes ?? [])
    .filter((s) => typeof s?.scene === 'string' && s.scene.trim().length > 0)
    .slice(0, count)
    .map((s) => ({ scene: s.scene.trim().slice(0, 300), anchor: (s.anchor ?? '').trim().slice(0, 60) || undefined }));
}

function buildPrompt(scene: string, styleName: string, styleHint: string, extra?: string): string {
  return [
    scene,
    `画面风格：${styleName}。${styleHint}`,
    '构图干净，主体明确，适合作为社交平台图文的内页配图。',
    // 反向约束写死在这里而不是交给用户：模型对「不要文字」的服从度本来就不高，
    // 再让它跟用户的自由输入打架，出字的概率只会更大。
    '严格不要出现任何文字、字母、数字、标题、字幕、水印、logo、二维码。',
    extra?.trim() ? `补充要求：${extra.trim().slice(0, 200)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export async function runIllustration(input: IllustrationInput): Promise<IllustrationResult> {
  const scenes = (input.scenes ?? []).slice(0, MAX_ILLUSTRATIONS).filter((s) => s.scene?.trim());
  if (scenes.length === 0) {
    return { ok: false, reason: 'input', error: '还没有画面清单：先让 AI 从正文里拆一组，或者自己写几句画面描述。' };
  }

  // 红线闸：用户能写进提示词的自由文本（画面描述 + 补充要求）过一遍。
  // 与封面同口径——检的是**会影响出图内容**的文字，不是模型指令本身。
  const userText = [...scenes.map((s) => s.scene), input.extra ?? ''].join('\n');
  const hits = await redlineHits(userText);
  if (hits.length > 0) {
    const { notifyComplianceBlock } = await import('../compliance/alert');
    void notifyComplianceBlock(input.workspaceId, '生成配图', hits, userText);
    return { ok: false, reason: 'redline', error: redlineReason(hits) };
  }

  const spec = input.specKey ? coverSpec(input.specKey) : specForPlatform(input.platform);
  const style = coverStyle(input.styleKey);

  // 参考图：保持人物/产品跨图一致。张数与封面共用上限，超了就截断（不报错——
  // 用户勾多了不该让整次生成失败，但也不能偷偷全传上去把成本抬起来）。
  const referenceImages: string[] = [];
  if (input.workspaceId && input.referenceAssetIds?.length) {
    for (const id of input.referenceAssetIds.slice(0, MAX_SUBJECT_IMAGES)) {
      const uri = await readMediaDataUri(input.workspaceId, id).catch(() => null);
      if (uri) referenceImages.push(uri);
    }
  }

  const images: IllustrationImage[] = [];
  let model = '';
  let source: 'platform' | 'byok' = 'platform';
  let firstFailure: { reason: 'not_configured' | 'quota' | 'failed'; error: string } | null = null;

  for (const [i, s] of scenes.entries()) {
    input.onProgress?.('image', `正在生成第 ${i + 1}/${scenes.length} 张配图…`);
    const prompt = buildPrompt(s.scene, style.name, style.hint ?? '', input.extra);
    const img = await llmImage(input.tenantId, {
      prompt,
      size: spec.size,
      referenceImages: referenceImages.length ? referenceImages : undefined,
    });
    if (!img.ok) {
      firstFailure ??= { reason: img.reason, error: img.error };
      // 配额/没配渠道：后面几张结果一样，别再多等
      if (img.reason === 'quota' || img.reason === 'not_configured') break;
      continue;
    }
    model = img.model;
    source = img.source;

    for (const g of img.images) {
      input.onProgress?.('tag', '正在写入 AI 生成标识…');
      const produceId = `${input.tenantId}-illus-${crypto.randomUUID()}`;
      const tagged = injectImageAigcMetadata(g.bytes, g.mime, aigcMetadataJson(produceId));
      let id: string | undefined;
      let url = `data:${g.mime};base64,${Buffer.from(tagged.bytes).toString('base64')}`;
      if (input.workspaceId) {
        const saved = await saveMediaAsset({
          workspaceId: input.workspaceId,
          accountId: input.accountId ?? null,
          draftId: input.draftId ?? null,
          kind: 'illustration',
          mime: g.mime,
          bytes: tagged.bytes,
          meta: {
            scene: s.scene,
            anchor: s.anchor ?? '',
            styleKey: style.key,
            specKey: spec.key,
            imagePrompt: prompt,
            model: img.model,
            source: img.source,
            aigcProduceId: produceId,
            aigcEmbedded: tagged.embedded,
          },
        }).catch((err) => {
          // 落库失败不该让用户白花这次钱：降级成 data URL，图照样能下载
          log.warn('配图落库失败，降级 data URL', { error: (err as Error).message });
          return null;
        });
        if (saved?.ok) {
          id = saved.asset.id;
          url = saved.asset.url;
        }
      }
      images.push({
        id,
        url,
        mime: g.mime,
        scene: s.scene,
        anchor: s.anchor,
        bytes: tagged.bytes.length,
        aigcEmbedded: tagged.embedded,
      });
    }
  }

  if (images.length === 0) {
    return {
      ok: false,
      reason: firstFailure?.reason ?? 'failed',
      error: firstFailure?.error ?? '模型没有返回图片，请稍后重试',
    };
  }
  return { ok: true, images, scenes, model, source };
}
