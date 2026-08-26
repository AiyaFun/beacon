'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { LEGAL_VERSION } from '@/lib/legal';

/**
 * 记下「这个人看到了当前这一版政策」。由 components/LegalUpdateBanner.tsx 的按钮调用。
 *
 * 🔒 memberId **只从 session 取**，不接受任何入参。
 * 这是个公开可达的 server action：形参上放个 memberId 就等于「谁都能替别人按下已阅」，
 * 而 consentVersion 是合规留痕——被人替按过的留痕比没有留痕更坏（它看起来是真的）。
 */
export async function ackLegalVersion(): Promise<void> {
  const session = await getSession();
  await prisma.member.update({
    where: { id: session.memberId },
    data: { consentAt: new Date(), consentVersion: LEGAL_VERSION },
  });
  // 横幅长在布局里，不 revalidate 的话按完还在原地——用户会以为没生效然后反复点。
  revalidatePath('/', 'layout');
}
