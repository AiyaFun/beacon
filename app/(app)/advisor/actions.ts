'use server';

import crypto from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { parseJson, toJson } from '@/lib/json';
import { writeMemory } from '@/lib/memory/core';
import { requireRole } from '@/lib/rbac';
import {
  convene,
  advisorWeight,
  dataDeltaFromNotes,
  ensureAdvisorPersonas,
  MAX_ENABLED_PERSONAS,
  type LearnedNote,
} from '@/lib/advisor/panel';
import { scoreAdvisorProposal } from '@/lib/advisor/proposal';

// F10 智囊团 · 本目录专属 server actions

// 召集智囊团：读人设+记忆 → 启用人物并行会诊 → 落库（可带本次议题）
export async function actConvene(seed?: string) {
  const s = await getSession();
  requireRole(s, 'topic.manage'); // 会诊即选题构思，且多人物并行烧 LLM
  const sessionId = await convene(s.accountId, s.workspaceId, seed?.trim() || undefined);
  revalidatePath('/advisor');
  return { ok: true, sessionId };
}

// W-6 草稿会诊：对已成稿的正文开一场会，人物给的是修改意见而非新选题。
// 权限用 content.create（这是创作动作，不是选题构思）。
export async function actConveneDraft(draftId: string, seed?: string) {
  const s = await getSession();
  requireRole(s, 'content.create');
  const sessionId = await convene(s.accountId, s.workspaceId, seed?.trim() || undefined, draftId);
  revalidatePath('/advisor');
  revalidatePath('/studio');
  return { ok: true, sessionId };
}

// 检验闭环：对某条人物提案采纳/否决。
// 自学习：更新人物采纳/否决计数与权重、沉淀经验笔记（注入下次发言）、写入记忆；
// 采纳还会把提案转成已采纳选题（sourceType=advisor），直通创作工坊。
export async function actVerdict(opinionId: string, adopted: boolean) {
  const s = await getSession();
  requireRole(s, 'topic.manage'); // 采纳会把提案写成选题
  // 归属校验：意见必须属于当前账号的会诊
  const opinion = await prisma.advisorOpinion.findFirst({
    where: { id: opinionId, session: { accountId: s.accountId } },
    include: { session: { select: { draftRef: true } } },
  });
  if (!opinion) return { ok: false, error: '意见不存在' };
  // W-6：草稿会诊采纳的是「修改意见」，它不是选题方向，绝不能进选题池——
  // 人物学习（计数/权重/笔记/记忆）照常，只是没有转选题这一步。
  const isDraftAdvice = Boolean(opinion.session.draftRef);

  const prev = opinion.adopted; // null=首判；true/false=改判
  if (prev === adopted) return { ok: true, adopted };

  await prisma.advisorOpinion.update({ where: { id: opinion.id }, data: { adopted } });

  // ── 人物自学习：计数 → 权重 → 经验笔记 ──
  const personaRow = await prisma.advisorPersona.findUnique({
    where: { accountId_key: { accountId: s.accountId, key: opinion.personaKey } },
  });
  if (personaRow) {
    let adoptedCount = personaRow.adoptedCount;
    let rejectedCount = personaRow.rejectedCount;
    // 改判先回滚旧计数
    if (prev === true) adoptedCount = Math.max(0, adoptedCount - 1);
    if (prev === false) rejectedCount = Math.max(0, rejectedCount - 1);
    if (adopted) adoptedCount += 1;
    else rejectedCount += 1;

    const notes = parseJson<LearnedNote[]>(personaRow.learnedNotes, []);
    notes.push({
      verdict: adopted ? 'adopted' : 'rejected',
      text: opinion.suggestion.slice(0, 80),
      at: new Date().toISOString(),
    });

    const trimmed = notes.slice(-20);
    await prisma.advisorPersona.update({
      where: { id: personaRow.id },
      data: {
        adoptedCount,
        rejectedCount,
        // 数据校准增量（W-5 写在 learnedNotes 里的 data_proven/data_failed）也要带上，
        // 否则用户每点一次采纳/否决就把「数据说了算」那部分权重抹平了。
        weight: advisorWeight(adoptedCount, rejectedCount, personaRow.key, dataDeltaFromNotes(trimmed)),
        learnedNotes: toJson(trimmed),
      },
    });
  }

  // ── 记忆学习（双向）──
  const adviceKind = isDraftAdvice ? '改稿意见' : '选题方向';
  if (adopted) {
    await writeMemory({
      workspaceId: s.workspaceId,
      accountId: s.accountId,
      type: 'preference',
      content: `智囊团中「${opinion.personaName}」的${adviceKind}被采纳：${opinion.suggestion}`,
      confidence: 0.5,
    });
    await writeMemory({
      workspaceId: s.workspaceId,
      accountId: s.accountId,
      type: 'fact',
      content: `人物「${opinion.personaName}」的建议历史上被采纳过`,
      confidence: 0.4,
    });
  } else {
    await writeMemory({
      workspaceId: s.workspaceId,
      accountId: s.accountId,
      type: 'preference',
      content: `智囊团中「${opinion.personaName}」的${adviceKind}被否决：${opinion.suggestion}`,
      confidence: 0.4,
    });
  }

  // ── 采纳闭环：提案直接进选题池（创作工坊可取用）；改判为否决时同步撤销 ──
  //
  // P1-8：提案不再拍固定 75 分，而是走一次精排（同一套账号上下文与六维口径），
  // 让 advisor 来源的选题与 hot/competitor 来源在选题池里可比。精排失败则退回原固定分，
  // 并在 rationale 里明说这分数没被评过——绝不让一个拍出来的数字冒充评分结果。
  const proposalTopicData = async () => {
    const scored = await scoreAdvisorProposal({
      tenantId: s.tenantId,
      workspaceId: s.workspaceId,
      accountId: s.accountId,
      suggestion: opinion.suggestion,
      rationale: opinion.rationale ?? '',
    });
    return {
      accountId: s.accountId,
      title: opinion.suggestion.slice(0, 60),
      angle: scored?.angle ?? opinion.suggestion,
      rationale: scored
        ? scored.rationale
        : `${opinion.rationale ?? ''}\n\n（本条为智囊团提案，精排评分未能生成，分数仅为占位，排序参考性低）`.trim(),
      scores: scored ? toJson(scored.scores) : '{}',
      totalScore: scored?.totalScore ?? 75,
      sourceType: 'advisor',
      sourceRef: opinion.id,
      state: 'accepted',
      mocked: scored ? scored.mocked : true,
    };
  };

  if (isDraftAdvice) {
    // 草稿会诊：到此为止。采纳的意见由创作工坊「按会诊意见改一版」消费（actReviseByAdvice）。
    revalidatePath('/advisor');
    revalidatePath('/studio');
    return { ok: true, adopted };
  }

  if (adopted && prev === null) {
    await prisma.topicIdea.create({ data: await proposalTopicData() });
  } else if (!adopted && prev === true) {
    await prisma.topicIdea.updateMany({
      where: { accountId: s.accountId, sourceType: 'advisor', sourceRef: opinion.id },
      data: { state: 'rejected', rejectReason: '智囊团提案被改判否决' },
    });
  } else if (adopted && prev === false) {
    // 否决改判采纳：恢复或补建选题
    const restored = await prisma.topicIdea.updateMany({
      where: { accountId: s.accountId, sourceType: 'advisor', sourceRef: opinion.id },
      data: { state: 'accepted', rejectReason: null },
    });
    if (restored.count === 0) {
      await prisma.topicIdea.create({ data: await proposalTopicData() });
    }
  }

  revalidatePath('/advisor');
  revalidatePath('/topics');
  return { ok: true, adopted };
}

// ── 人物管理：自定义身份 CRUD ──

export type PersonaInput = {
  id?: string;
  name: string;
  role: 'audience' | 'expert';
  emoji: string;
  stance: string;
  focus: string[]; // 关注点列表
};

export async function actUpsertAdvisorPersona(input: PersonaInput) {
  const s = await getSession();
  requireRole(s, 'persona.edit'); // 智囊团人物属于人设配置
  const name = input.name.trim();
  const stance = input.stance.trim();
  const emoji = input.emoji.trim() || '🧑';
  const focus = (input.focus ?? []).map((f) => f.trim()).filter(Boolean).slice(0, 6);
  if (!name || !stance) return { ok: false, error: '名字与立场必填' };
  if (input.role !== 'audience' && input.role !== 'expert') return { ok: false, error: '角色不合法' };

  if (input.id) {
    // 编辑：builtin 也允许改名字/立场/关注点（key 与 source 不变，学习数据保留）
    const r = await prisma.advisorPersona.updateMany({
      where: { id: input.id, accountId: s.accountId },
      data: { name, role: input.role, emoji, stance, focus: toJson(focus) },
    });
    if (r.count === 0) return { ok: false, error: '人物不存在' };
  } else {
    await ensureAdvisorPersonas(s.accountId); // 保证内置人物已落库，再加自定义
    const enabled = await prisma.advisorPersona.count({ where: { accountId: s.accountId, enabled: true } });
    if (enabled >= MAX_ENABLED_PERSONAS) {
      return { ok: false, error: `启用人物已达上限 ${MAX_ENABLED_PERSONAS} 席，请先停用部分人物` };
    }
    await prisma.advisorPersona.create({
      data: {
        accountId: s.accountId,
        key: `custom_${crypto.randomBytes(4).toString('hex')}`,
        name,
        role: input.role,
        emoji,
        stance,
        focus: toJson(focus),
        source: 'custom',
      },
    });
  }
  revalidatePath('/advisor');
  return { ok: true };
}

export async function actToggleAdvisorPersona(id: string, enabled: boolean) {
  const s = await getSession();
  requireRole(s, 'persona.edit');
  if (enabled) {
    const count = await prisma.advisorPersona.count({ where: { accountId: s.accountId, enabled: true } });
    if (count >= MAX_ENABLED_PERSONAS) {
      return { ok: false, error: `启用人物已达上限 ${MAX_ENABLED_PERSONAS} 席` };
    }
  } else {
    const count = await prisma.advisorPersona.count({ where: { accountId: s.accountId, enabled: true } });
    if (count <= 3) return { ok: false, error: '至少保留 3 位启用人物，会诊才有多样性' };
  }
  const r = await prisma.advisorPersona.updateMany({
    where: { id, accountId: s.accountId },
    data: { enabled },
  });
  if (r.count === 0) return { ok: false, error: '人物不存在' };
  revalidatePath('/advisor');
  return { ok: true };
}

// 删除：自定义人物物理删除；内置人物降级为停用（模板可随时重新启用）
export async function actDeleteAdvisorPersona(id: string) {
  const s = await getSession();
  requireRole(s, 'persona.edit');
  const persona = await prisma.advisorPersona.findFirst({ where: { id, accountId: s.accountId } });
  if (!persona) return { ok: false, error: '人物不存在' };
  if (persona.source === 'custom') {
    await prisma.advisorPersona.delete({ where: { id: persona.id } });
  } else {
    await prisma.advisorPersona.update({ where: { id: persona.id }, data: { enabled: false } });
  }
  revalidatePath('/advisor');
  return { ok: true };
}
