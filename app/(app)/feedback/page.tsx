
import { FeedbackCard } from '../settings/FeedbackCard';
import { HubHeader } from '@/components/HubHeader';

export const dynamic = 'force-dynamic';

export default function FeedbackPage() {
  return (
    <>
      <HubHeader
        title="问题反馈与社群支持"
        hint="扫描飞书二维码加入官方交流群，与团队直接沟通"
      />
      <FeedbackCard />
    </>
  );
}
