import { HubHeader } from '@/components/HubHeader';
import { HubLoading } from '@/components/HubLoading';
import { PickTabs } from '@/app/(app)/topics/PickTabs';

// 取数期间先把与真实页同构的头渲染出来：切页签时头部原地不动，
// 只有内容区显示占位——「每次打开都像整页重刷」的观感就没了（2026-08-26）。
export default function Loading() {
  return <HubLoading header={<HubHeader title="挑选题" tabs={<PickTabs active="topics" inline />} />} />;
}
