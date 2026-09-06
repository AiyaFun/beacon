
import { FeedbackCard } from '../settings/FeedbackCard';
import { HubHeader } from '@/components/HubHeader';
import { getServerLang } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';

export default async function FeedbackPage() {
  const lang = await getServerLang();
  const isEn = lang === 'en';
  return (
    <>
      <HubHeader
        title={isEn ? 'Feedback & Support' : '问题反馈与社群支持'}
        hint={isEn ? 'Scan the Feishu QR code to join our community and communicate directly with the team' : '扫描飞书二维码加入官方交流群，与团队直接沟通'}
      />
      <FeedbackCard />
    </>
  );
}
