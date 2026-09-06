import { HubHeader } from '@/components/HubHeader';
import { HubLoading } from '@/components/HubLoading';

export default function Loading() {
  return <HubLoading header={<HubHeader title="今日选题榜" />} />;
}
