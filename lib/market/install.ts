import crypto from 'node:crypto';
import { prisma } from '../db';
import { safeFetch } from '../web/fetch';
import { createLogger } from '../logger';
import { parsePack, compareVersion, versionSatisfied, type PackBody } from './pack';
import { createTemplate } from '../workflow/market';
import { APP_VERSION } from './version';

const log = createLogger({ module: 'market' });

// ── 从市场（或任意包地址）装一个东西 ────────────────────────────────────────
//
// 【三条边界，先说死】
// 1. **包里只有数据，没有代码**。技能是提示词模板、智能体是步骤 JSON、人设是一段文本。
//    渲染只做字符串替换，绝不 eval——「下载代码执行」这条路本产品不走。
// 2. **装进来的东西默认不参与无人值守**。人设包尤其危险：它直接进每次运行的系统提示词，
//    等于让一个陌生人给你的 AI 写常驻指令。所以它必须被用户看过全文、显式启用，
//    而且不许被定时/无人值守场景自动使用。
// 3. **作者署名不是身份凭证**。包里的 author 只是一行字，没有签名机制。
//    界面上必须说清这一点——把它渲染成一枚「认证」徽章就是在骗人。

export type InstallOutcome =
  | { ok: true; kind: PackBody['kind']; name: string; version: string; updated: boolean }
  | { ok: false; error: string };

/** 从一个 URL 取包并装上。SSRF 护栏走 safeFetch（全站唯一入口，别另写一份）。 */
export async function installFromUrl(
  tenantId: string,
  memberId: string,
  url: string,
): Promise<InstallOutcome> {
  let text: string;
  try {
    const page = await safeFetch(url);
    text = page.text;
  } catch (e) {
    return { ok: false, error: `取不到这个地址的内容：${(e as Error).message.slice(0, 120)}` };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: '这个地址返回的不是 JSON（市场的包必须是 beaconPack 格式的 JSON）' };
  }
  return installPack(tenantId, memberId, raw, url);
}

/** 装一个已经拿到手的包。 */
export async function installPack(
  tenantId: string,
  memberId: string,
  raw: unknown,
  sourceUrl?: string,
): Promise<InstallOutcome> {
  const parsed = parsePack(raw);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const pack = parsed.pack;

  // 版本要求不满足时**明说而不是装完在运行时炸**：用户看到「这个包要 1.4.0 以上」
  // 才知道该去升级，看到一句「跑失败了」只会以为包坏了
  if (!versionSatisfied(pack.minAppVersion, APP_VERSION)) {
    return {
      ok: false,
      error: `这个包要求烽火台 ${pack.minAppVersion} 或更新的版本（当前 ${APP_VERSION}），先升级再装`,
    };
  }

  switch (pack.kind) {
    case 'skill':
      return installSkillPack(tenantId, pack, sourceUrl);
    case 'workflow':
      return installWorkflowPack(tenantId, memberId, pack);
    case 'persona':
      return installPersonaPack(tenantId, pack, sourceUrl);
  }
}

/** 市场装进来的技能用 `mkt-<slug>` 作 slug：与用户自建的 `custom-*` 一眼可分。 */
const marketSlug = (slug: string) => `mkt-${slug}`;

async function installSkillPack(
  tenantId: string,
  pack: Extract<PackBody, { kind: 'skill' }>,
  sourceUrl?: string,
): Promise<InstallOutcome> {
  const slug = marketSlug(pack.slug);
  const existing = await prisma.contentSkill.findFirst({ where: { slug, tenantId } });

  // 已经装过：这是一次**更新**。要不要覆盖由版本说了算——
  // 装了新版反而被旧版盖回去，是市场最容易出的一类静默倒退
  if (existing) {
    if (compareVersion(pack.version, existing.version) <= 0) {
      return { ok: false, error: `已经装着 ${existing.version} 版了，这个包是 ${pack.version}，不用装` };
    }
    await prisma.contentSkill.update({
      where: { id: existing.id },
      data: {
        name: pack.name,
        description: pack.description,
        emoji: pack.emoji,
        platform: pack.platform,
        promptTemplate: pack.promptTemplate,
        outputKind: pack.outputKind,
        version: pack.version,
        sourceUrl: sourceUrl ?? existing.sourceUrl,
        sourceAuthor: pack.author || existing.sourceAuthor,
      },
    });
    return { ok: true, kind: 'skill', name: pack.name, version: pack.version, updated: true };
  }

  const created = await prisma.contentSkill.create({
    data: {
      tenantId,
      slug,
      name: pack.name,
      description: pack.description || `来自市场：${pack.slug}`,
      emoji: pack.emoji,
      platform: pack.platform,
      category: 'format',
      promptTemplate: pack.promptTemplate,
      outputKind: pack.outputKind,
      version: pack.version,
      sourceUrl: sourceUrl ?? null,
      sourceAuthor: pack.author || null,
      isBuiltin: false,
    },
  });
  // 装了就该能用：与「自建技能创建即安装」同一条口径，别让用户装完还要再点一次「启用」
  await prisma.skillInstall.create({ data: { tenantId, skillId: created.id, enabled: true } });
  return { ok: true, kind: 'skill', name: pack.name, version: pack.version, updated: false };
}

async function installWorkflowPack(
  tenantId: string,
  memberId: string,
  pack: Extract<PackBody, { kind: 'workflow' }>,
): Promise<InstallOutcome> {
  // 【为什么走 createTemplate 而不是自己 create】那个函数里有一条要紧的规矩：
  // slug 加租户前缀防撞名、步骤过同一份 zod。绕过它就等于市场这条路自己造了第二套校验
  const r = await createTemplate(tenantId, memberId, {
    name: pack.name,
    description: pack.description,
    emoji: pack.emoji,
    category: pack.category,
    persona: pack.persona,
    steps: pack.steps,
  });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, kind: 'workflow', name: pack.name, version: pack.version, updated: false };
}

async function installPersonaPack(
  tenantId: string,
  pack: Extract<PackBody, { kind: 'persona' }>,
  sourceUrl?: string,
): Promise<InstallOutcome> {
  // 【人设包为什么当成技能存】它进的是「渲染成提示词的一段文本」，与技能同构；
  // 单开一张表会多出一套安装/启用/版本的机制，而它们的生命周期完全一样。
  // 用 category='persona' 区分，界面据此换个说法与图标。
  //
  // ⚠️ **人设直接进每次运行的系统提示词**，是包里最危险的一类——
  // 等于让一个陌生人给你的 AI 写常驻指令。所以：装进来默认**不启用**，
  // 用户必须在界面上看过全文再自己打开（installPersona 不写 SkillInstall 行）。
  const slug = marketSlug(pack.slug);
  const existing = await prisma.contentSkill.findFirst({ where: { slug, tenantId } });
  if (existing && compareVersion(pack.version, existing.version) <= 0) {
    return { ok: false, error: `已经装着 ${existing.version} 版了，这个包是 ${pack.version}，不用装` };
  }

  const data = {
    name: pack.name,
    description: pack.description || '来自市场的人设包',
    emoji: pack.emoji,
    platform: 'generic',
    category: 'persona',
    // 人设文本按技能模板存：末尾接 {{content}} 让它能当作用在正文上的技能跑
    promptTemplate: `${pack.persona.trim()}\n\n---\n以下是需要按上述设定处理的正文：\n{{content}}`,
    outputKind: 'markdown',
    version: pack.version,
    sourceUrl: sourceUrl ?? null,
    sourceAuthor: pack.author || null,
  };

  if (existing) {
    await prisma.contentSkill.update({ where: { id: existing.id }, data });
    return { ok: true, kind: 'persona', name: pack.name, version: pack.version, updated: true };
  }
  await prisma.contentSkill.create({ data: { ...data, tenantId, slug, isBuiltin: false } });
  // **刻意不写 SkillInstall**：人设要用户看过全文再自己启用
  return { ok: true, kind: 'persona', name: pack.name, version: pack.version, updated: false };
}

export type UpdateCheck = {
  skillId: string;
  name: string;
  installed: string;
  latest: string;
  sourceUrl: string;
};

/**
 * 检查有没有新版本。**只报告，不自动更新。**
 *
 * 【为什么不自动更新】内置技能的同步（sync-system-data）是静默覆盖的——
 * 那条路上东西是平台自己写的，用户对它没有预期。市场装的不一样：
 * 用户挑过、看过、可能还改过用法。上游一改，他手上那条技能一夜之间行为变了
 * 而没人告诉他，这比「有新版本没装」糟得多。
 */
export async function checkUpdates(tenantId: string): Promise<UpdateCheck[]> {
  const rows = await prisma.contentSkill.findMany({
    where: { tenantId, sourceUrl: { not: null } },
    select: { id: true, name: true, version: true, sourceUrl: true },
  });

  const out: UpdateCheck[] = [];
  for (const row of rows) {
    try {
      const page = await safeFetch(row.sourceUrl!);
      const parsed = parsePack(JSON.parse(page.text));
      if (!parsed.ok) continue;
      if (compareVersion(parsed.pack.version, row.version) > 0) {
        out.push({
          skillId: row.id,
          name: row.name,
          installed: row.version,
          latest: parsed.pack.version,
          sourceUrl: row.sourceUrl!,
        });
      }
    } catch (err) {
      // 上游挂了/删了不是错误：这次查不到而已，下次再说。
      // 抛出去会让「检查更新」整个失败，而其实只是十个里有一个取不到
      log.info('检查更新时取不到上游包', { skillId: row.id, error: (err as Error).message });
    }
  }
  return out;
}

/** 导出成一个可分享的包（把自己做的技能发给别人 / 提交到市场）。 */
export async function exportSkillPack(tenantId: string, skillId: string): Promise<string | null> {
  const s = await prisma.contentSkill.findFirst({
    where: { id: skillId, OR: [{ tenantId }, { isBuiltin: true }] },
  });
  if (!s) return null;
  return JSON.stringify(
    {
      beaconPack: 1,
      pack: {
        kind: 'skill',
        // 导出时把 mkt-/custom- 前缀剥掉：那是本地存储的约定，不该带进分享出去的包
        slug: s.slug.replace(/^(mkt|custom)-/, '').slice(0, 48) || `skill-${crypto.randomBytes(3).toString('hex')}`,
        name: s.name,
        description: s.description,
        emoji: s.emoji,
        version: s.version.includes('.') ? s.version : `${s.version}.0`,
        author: s.sourceAuthor ?? '',
        platform: s.platform,
        outputKind: s.outputKind,
        promptTemplate: s.promptTemplate,
        params: [],
      },
    },
    null,
    2,
  );
}
