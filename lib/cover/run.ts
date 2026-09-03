import crypto from 'node:crypto';
import { llmImage, imageConfigured, IMAGE_MODEL_HINT } from '../llm/image';
import { checkText, redlineHits, redlineReason, type WordHit } from '../compliance/engine';
import { aigcMetadataJson } from '../compliance/aigc';
import { injectImageAigcMetadata } from '../deliverable/image-meta';
import { saveMediaAsset, readMediaDataUri } from '../media/store';
import { deriveCoverMeta, onImageText, buildCoverPrompt, cleanCoverText, type CoverMeta } from './prompt';
import { coverSpec, specForPlatform, planCoverJobs, type CoverSpec } from './specs';
import { coverStyle } from './styles';
import { prisma } from '../db';
import {
  MAX_SUBJECT_IMAGES,
  MAX_BACKGROUND_IMAGES,
  MAX_REFERENCE_BYTES,
  COVER_TITLE_HARD_MAX,
  COVER_SUBTITLE_HARD_MAX,
  MAX_COVER_IMAGES,
} from './rules';

// AI 封面的运行内核（域14）。从 lib/skills 的 runCoverSkill 抽出来，理由有三：
//   ① 封面工位不再要求「先去技能中心装上 xhs-cover」——它是草稿出成品的默认一步，不是可选插件；
//      但「技能 = 提示词模板」这条不变式仍然成立：抽标题那步的指令还是内置技能的模板渲染出来的；
//   ② Route Handler（/api/cover/generate）和 runSkill 的 image 分支要共用同一条管线，不许各写一份；
//   ③ 出图字节进内存的第一站就打隐式 AIGC 标识——PNG 走 iTXt、JPEG 走 XMP——然后才交给前端。
//      前端拿到的永远是已打标的字节（data URL），预览 / 下载 / 右键另存三条出口同一份。
//
// 红线闸只检**会画到图上、随封面发布**的文字（主副标题）和用户备注（备注可能让模型往图上写字）；
// 提示词里的“风格/布局/禁止”是给模型的指令、不发布，不进红线（否则“禁止二维码”会误伤）。

export type CoverRunInput = {
  tenantId: string;
  /**
   * 落库归属。给了 workspaceId 就把生成的封面存进 MediaAsset（前端拿 /api/media/<id>）；
   * 不给就退回 data URL（技能面板那条老路径、以及不需要历史的调用方）。
   */
  workspaceId?: string;
  accountId?: string | null;
  /** 这张封面挂在哪篇草稿名下（决定「本稿封面」列表能不能查到它） */
  draftId?: string | null;
  /** 草稿平台：定默认比例、合规词库口径 */
  platform: string;
  /** 比例规格 key（缺省按 platform 推） */
  specKey?: string;
  styleKey?: string;
  /**
   * 多选风格：给了就每个风格各出一张（与 variants 二选一，同时给以这个为准）。
   * 上限 MAX_COVER_IMAGES——一张就是一次真实付费调用。
   */
  styleKeys?: string[];
  /** 同一风格出几张变体（1..MAX_COVER_IMAGES）。文案只抽一次，只是多花几次出图。 */
  variants?: number;
  /** 公众号：主图（2.35:1）之外再出一张 1:1 次图。只有主比例是公众号时才生效。 */
  wechatSquareToo?: boolean;
  fontKey?: string;
  decors?: string[];
  /** 给 AI 的补充要求 */
  extra?: string;
  textless?: boolean;
  /** 手填 / 从标题矩阵带入的封面文案：有 mainTitle 就**跳过** deriveCoverMeta（省一次调用、省一个名额） */
  meta?: { mainTitle?: string; subTitle?: string; palette?: string };
  /** 没有 meta 时抽标题用的指令（渲染后的技能模板）；两者都没有则报错 */
  instruction?: string;
  /** 抽取失败时的兜底标题（草稿标题） */
  fallbackTitle: string;
  /** 主体（人像/产品）参考图 data:URI，≤ MAX_SUBJECT_IMAGES */
  subjectImages?: string[];
  /** 背景/氛围参考图 data:URI，≤ MAX_BACKGROUND_IMAGES */
  backgroundImages?: string[];
  /** 从「我的形象」里勾选的已存素材（MediaAsset.id）。与上面两个是同一批额度，合并后再判张数。 */
  subjectAssetIds?: string[];
  backgroundAssetIds?: string[];
  /**
   * 带了任何参考图就必须为 true：用户勾选「照片中人物是我本人或已取得其单独同意」。
   * 服务端重算，不信任前端“已经显示过勾选框”。
   */
  portraitConsent?: boolean;
  /** 进度回调（SSE 用）。 */
  onProgress?: (step: 'meta' | 'image' | 'tag', message: string) => void;
};

export type CoverImage = {
  /** 落库了就是 MediaAsset.id；没落库为空 */
  id?: string;
  /** 这张图用的风格与比例（多风格/成对出图时每张不一样，UI 要按各自的比例渲染） */
  styleKey: string;
  styleName: string;
  specKey: string;
  specLabel: string;
  aspect: number;
  /**
   * 前端取图的地址：落库了是 /api/media/<id>（鉴权路由），没落库是 data URL。
   * 无论哪种，拿到的都是**已经打过隐式 AIGC 标识**的那份字节。
   */
  url: string;
  mime: string;
  /** 隐式标识是否真的写进了字节（PNG/JPEG 都能写；其它格式如实为 false） */
  aigcEmbedded: boolean;
  bytes: number;
};

export type CoverRunResult =
  | {
      ok: true;
      images: CoverImage[];
      meta: CoverMeta;
      /** 是否跳过了抽标题那步（手填/带入的文案） */
      metaFromUser: boolean;
      imagePrompt: string;
      spec: CoverSpec;
      styleKey: string;
      /** 抽标题那步是否 Mock；图像本身从不 Mock */
      mocked: boolean;
      riskLevel: string;
      hits: WordHit[];
      model: string;
      source: 'platform' | 'byok';
      warning?: string;
    }
  | { ok: false; error: string; reason?: 'not_configured' | 'quota' | 'failed' | 'input' | 'redline' };

const DATA_IMAGE_PREFIX = /^data:image\/(png|jpe?g|webp);base64,/i;
// base64 膨胀 4/3，再给 data: 头留一点余量
const MAX_DATA_URI_LEN = Math.ceil((MAX_REFERENCE_BYTES * 4) / 3) + 64;

function checkReferenceList(list: string[] | undefined, max: number, label: string): { ok: true; list: string[] } | { ok: false; error: string } {
  const arr = (list ?? []).filter((s) => typeof s === 'string' && s.length > 0);
  if (arr.length > max) return { ok: false, error: `${label}最多 ${max} 张` };
  for (const uri of arr) {
    if (!DATA_IMAGE_PREFIX.test(uri)) return { ok: false, error: `${label}只支持 PNG / JPEG / WebP 图片` };
    if (uri.length > MAX_DATA_URI_LEN) return { ok: false, error: `${label}单张超过 ${MAX_REFERENCE_BYTES / 1024 / 1024}MB，先压一下再传` };
  }
  return { ok: true, list: arr };
}

export async function runCover(input: CoverRunInput): Promise<CoverRunResult> {
  const progress = input.onProgress ?? (() => {});

  // 先确认能生图，再花抽标题那次文本调用——没配渠道就别白烧一次 generation。
  if (!(await imageConfigured(input.tenantId))) {
    return {
      ok: false,
      reason: 'not_configured',
      error: `封面生成要先在「接入与密钥」加一个「火山引擎 豆包」渠道。${IMAGE_MODEL_HINT}`,
    };
  }

  // 参考图：张数 / 格式 / 大小 / 同意——全部服务端重算
  // 「我的形象」里勾选的先取出来（已加密落库，这里解密成 data URI），与本次直接上传的合并后一起判张数
  const fromLibrary = async (ids: string[] | undefined): Promise<string[]> => {
    if (!ids?.length || !input.workspaceId) return [];
    const uris = await Promise.all(ids.slice(0, MAX_SUBJECT_IMAGES + MAX_BACKGROUND_IMAGES).map((id) => readMediaDataUri(input.workspaceId!, id)));
    return uris.filter((u): u is string => !!u);
  };
  const [libSubject, libBackground] = await Promise.all([
    fromLibrary(input.subjectAssetIds),
    fromLibrary(input.backgroundAssetIds),
  ]);
  const subject = checkReferenceList([...(input.subjectImages ?? []), ...libSubject], MAX_SUBJECT_IMAGES, '人像/主体参考图');
  if (!subject.ok) return { ok: false, reason: 'input', error: subject.error };
  const background = checkReferenceList([...(input.backgroundImages ?? []), ...libBackground], MAX_BACKGROUND_IMAGES, '背景参考图');
  if (!background.ok) return { ok: false, reason: 'input', error: background.error };
  const referenceImages = [...subject.list, ...background.list];
  if (referenceImages.length > 0 && input.portraitConsent !== true) {
    return {
      ok: false,
      reason: 'input',
      error: '上传参考图前需要确认：照片中的人物是你本人，或你已取得其单独同意。请勾选后再生成。',
    };
  }

  const spec = input.specKey ? coverSpec(input.specKey) : specForPlatform(input.platform);

  // 封面文案：手填/带入优先；否则让文本模型从正文抽
  let meta: CoverMeta;
  let mocked = false;
  const userTitle = cleanCoverText(input.meta?.mainTitle, COVER_TITLE_HARD_MAX);
  const metaFromUser = userTitle.length > 0;
  if (metaFromUser) {
    meta = {
      mainTitle: userTitle,
      subTitle: cleanCoverText(input.meta?.subTitle, COVER_SUBTITLE_HARD_MAX),
      palette: cleanCoverText(input.meta?.palette, 60),
    };
  } else {
    if (!input.instruction) {
      return { ok: false, reason: 'input', error: '没有封面文案：填一个封面大字，或让系统从正文里提炼' };
    }
    progress('meta', '正在从正文提炼封面文案…');
    const derived = await deriveCoverMeta(input.tenantId, input.instruction, input.fallbackTitle);
    meta = derived.meta;
    mocked = derived.mocked;
    if (!meta.mainTitle) {
      return { ok: false, reason: 'failed', error: '没能从正文里提炼出封面标题，把草稿写具体一点，或直接填一个封面大字' };
    }
  }

  // 红线闸：命中即拒（与导出 / 文本技能同语义、同口径）。检上图文字 + 用户备注。
  const publishText = onImageText(meta);
  const redline = await redlineHits([publishText, input.extra ?? ''].filter(Boolean).join('\n'));
  if (redline.length) {
    const { notifyComplianceBlock } = await import('../compliance/alert');
    void notifyComplianceBlock(input.workspaceId, '生成封面', redline, publishText);
    return { ok: false, reason: 'redline', error: redlineReason(redline) };
  }
  const compliance = await checkText(publishText, input.platform, input.tenantId);

  // ── 这一次要出哪几张 ──────────────────────────────────────────
  // 排期收在 lib/cover/specs.ts 的 planCoverJobs：**工位和这里必须用同一份**，
  // 否则「UI 说出 3 张、服务端排出别的组合」这种不一致没人看得见（公众号次图就是这么被丢掉的）。
  // 文案只抽一次（上面已经抽完），这里只是多花几次**出图**。
  const plan = planCoverJobs({
    specKey: spec.key,
    styleKey: input.styleKey,
    styleKeys: input.styleKeys,
    variants: input.variants,
    wechatSquareToo: input.wechatSquareToo,
    max: MAX_COVER_IMAGES,
  }).map((j) => ({ styleKey: j.styleKey, spec: coverSpec(j.specKey) }));

  // 自定义风格（「我的风格库」）：key 形如 custom:<id>，一次把用到的都取出来
  const customIds = plan.map((j) => j.styleKey).filter((k) => k.startsWith('custom:')).map((k) => k.slice(7));
  const customById = new Map<string, { name: string; description: string }>();
  if (customIds.length && input.workspaceId) {
    const rows = await prisma.coverStylePreset.findMany({
      where: { id: { in: customIds }, workspaceId: input.workspaceId },
      select: { id: true, name: true, description: true },
    });
    for (const r of rows) customById.set(r.id, { name: r.name, description: r.description });
  }

  const buildFor = (job: { styleKey: string; spec: CoverSpec }) => {
    const custom = job.styleKey.startsWith('custom:') ? customById.get(job.styleKey.slice(7)) : undefined;
    return buildCoverPrompt({
      meta,
      spec: job.spec,
      styleKey: custom ? undefined : job.styleKey,
      customStyle: custom,
      fontKey: input.fontKey,
      decors: input.decors,
      extra: input.extra,
      subjectCount: subject.list.length,
      backgroundCount: background.list.length,
      textless: input.textless,
    });
  };

  const imagePrompt = buildFor(plan[0]);

  // 一张图从「模型返回的字节」到「能给用户的东西」要走的三步：打隐式标识 → 落库 → 记住它的风格/比例。
  const finish = async (
    g: { bytes: Uint8Array; mime: string },
    job: { styleKey: string; spec: CoverSpec },
    styleName: string,
    prompt: string,
    model: string,
    source: 'platform' | 'byok',
  ): Promise<CoverImage> => {
    const produceId = `${input.tenantId}-cover-${crypto.randomUUID()}`;
    const tagged = injectImageAigcMetadata(g.bytes, g.mime, aigcMetadataJson(produceId));
    // 落库：前端拿鉴权路由的地址，刷新还在（此前只有 24h 的火山直链，刷新即丢）。
    // 没有 workspaceId（技能面板那条老路径）就退回 data URL，行为不变。
    let id: string | undefined;
    let url = `data:${g.mime};base64,${Buffer.from(tagged.bytes).toString('base64')}`;
    if (input.workspaceId) {
      const saved = await saveMediaAsset({
        workspaceId: input.workspaceId,
        accountId: input.accountId ?? null,
        draftId: input.draftId ?? null,
        kind: 'cover',
        mime: g.mime,
        bytes: tagged.bytes,
        meta: {
          styleKey: job.styleKey,
          styleName,
          specKey: job.spec.key,
          fontKey: input.fontKey ?? '',
          decors: input.decors ?? [],
          mainTitle: meta.mainTitle,
          subTitle: meta.subTitle ?? '',
          imagePrompt: prompt,
          model,
          source,
          aigcProduceId: produceId,
          aigcEmbedded: tagged.embedded,
        },
      });
      // 落库失败（配额/库故障）不该让用户白花这次钱：如实降级成 data URL，图还是能下载的
      if (saved.ok) {
        id = saved.asset.id;
        url = saved.asset.url;
      }
    }
    return {
      id,
      url,
      mime: g.mime,
      aigcEmbedded: tagged.embedded,
      bytes: tagged.bytes.length,
      styleKey: job.styleKey,
      styleName,
      specKey: job.spec.key,
      specLabel: job.spec.label,
      aspect: job.spec.aspect,
    };
  };

  // 串行出图：并发对图像端点没好处（同一个 Key 的限流是共享的），而串行天然拉开了间隔。
  // 每张各自占配额、各自失败——一张失败不该让已经出好的那几张作废（钱已经花了）。
  const images: CoverImage[] = [];
  let firstFailure: { reason: 'not_configured' | 'quota' | 'failed'; error: string } | null = null;
  let model = '';
  let source: 'platform' | 'byok' = 'byok';

  for (let i = 0; i < plan.length; i++) {
    const job = plan[i];
    const styleName = job.styleKey.startsWith('custom:')
      ? (customById.get(job.styleKey.slice(7))?.name ?? '自定义风格')
      : coverStyle(job.styleKey).name;
    progress(
      'image',
      plan.length > 1
        ? `正在生成第 ${i + 1}/${plan.length} 张（${styleName} · ${job.spec.label}）…`
        : `正在生成 ${job.spec.label} 封面（通常 20–60 秒）…`,
    );
    const prompt = buildFor(job);
    const img = await llmImage(input.tenantId, {
      prompt,
      size: job.spec.size,
      referenceImages: referenceImages.length ? referenceImages : undefined,
    });
    if (!img.ok) {
      firstFailure ??= { reason: img.reason, error: img.error };
      // 配额撞墙就别继续试后面几张了：结果一样，只是多等几秒
      if (img.reason === 'quota' || img.reason === 'not_configured') break;
      continue;
    }
    model = img.model;
    source = img.source;
    progress('tag', '正在写入 AI 生成标识…');
    for (const g of img.images) images.push(await finish(g, job, styleName, prompt, img.model, img.source));
  }

  // 一张都没出来：把**第一次**失败的原因原样交出去（quota 与 failed 对用户是两件事）
  if (images.length === 0) {
    return {
      ok: false,
      reason: firstFailure?.reason ?? 'failed',
      error: firstFailure?.error ?? '模型没有返回图片，请稍后重试',
    };
  }

  const untagged = images.filter((i) => !i.aigcEmbedded).length;

  return {
    ok: true,
    images,
    meta,
    metaFromUser,
    imagePrompt,
    spec,
    styleKey: input.styleKey ?? '',
    mocked,
    riskLevel: compliance.riskLevel,
    hits: compliance.hits,
    model,
    source,
    warning: [
      untagged ? `有 ${untagged} 张图片格式不支持写入隐式 AIGC 标识（图上仍有「AI生成」水印作为显式标识）。` : '',
      // 要了 N 张只出来 M 张：如实说，别让用户以为自己数错了（失败那几张的名额已经归还）
      images.length < plan.length
        ? `这次要出 ${plan.length} 张，成功 ${images.length} 张；失败的那几张没有扣额度（${firstFailure?.error ?? '稍后重试'}）。`
        : '',
    ].filter(Boolean).join(' ') || undefined,
  };
}
