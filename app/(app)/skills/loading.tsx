import { HubHeader } from '@/components/HubHeader';
import { HubLoading } from '@/components/HubLoading';
import { RoleTabs } from '@/components/RoleTabs';

// 取数期间先把与真实页同构的头渲染出来：切页签时头部原地不动，
// 只有内容区显示占位——「每次打开都像整页重刷」的观感就没了（2026-08-26）。
export default function Loading() {
  return <HubLoading header={<HubHeader title="技能 · 连接器" tabs={<RoleTabs active="skill" inline />} />} />;
}
