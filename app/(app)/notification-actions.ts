'use server';

import { revalidatePath } from 'next/cache';
import { getSession } from '@/lib/session';
import { markNotificationsRead } from '@/lib/notify';

export async function actMarkNotificationsRead(id?: string) {
  const s = await getSession();
  await markNotificationsRead(s.workspaceId, id);
  revalidatePath('/', 'layout'); // 刷新所有页面顶栏的红点
  return { ok: true };
}
