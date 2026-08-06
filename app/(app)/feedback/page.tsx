import { PageHead } from '@/components/ui';
import { FeedbackCard } from '../settings/FeedbackCard';

export const dynamic = 'force-dynamic';

export default function FeedbackPage() {
  return (
    <>
      <PageHead
        title="问题反馈与社群支持"
        desc="扫描飞书二维码加入官方交流群，与团队直接沟通"
      />
      <FeedbackCard />
    </>
  );
}
