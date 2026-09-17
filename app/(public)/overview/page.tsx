import type { Metadata } from 'next';
import { pageMetadata } from '@/lib/geo/page-seo';
import { OverviewView } from './OverviewView';

// 标题/描述/关键词/canonical 收在 lib/geo/page-seo.ts —— 见那里顶部「为什么收成一处」
export const metadata: Metadata = pageMetadata('/overview');

export default function OverviewPage() {
  return <OverviewView />;
}
