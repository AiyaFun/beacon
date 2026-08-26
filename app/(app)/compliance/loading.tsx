import { HubHeader } from '@/components/HubHeader';
import { HubLoading } from '@/components/HubLoading';
import { MakeTabs } from '@/components/MakeTabs';

// 取数期间先把与真实页同构的头渲染出来：切页签时头部原地不动，
// 只有内容区显示占位——「每次打开都像整页重刷」的观感就没了（2026-08-26）。
export default function Loading() {
  return <HubLoading header={<HubHeader title="做内容" tabs={<MakeTabs active="check" inline />} />} />;
}
