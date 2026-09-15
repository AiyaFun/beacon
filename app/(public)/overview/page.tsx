import { Metadata } from 'next';
import { OverviewView } from './OverviewView';

export const metadata: Metadata = {
  title: '全端生态总览 · 烽火台 Beacon (整机/Win/Mac/SaaS/插件)',
  description: '烽火台跨平台内容作战室全端形态架构：覆盖私有化整机一体机部署、Windows 与 macOS 桌面客户端、云端 SaaS 服务与 Chrome 采集扩展插件。',
  keywords: [
    '烽火台全端生态',
    '私有化整机部署',
    '桌面客户端',
    'macOS创作者工具',
    'Windows内容工具',
    'Chrome采集插件',
    '云端SaaS',
    '跨平台内容作战室',
  ],
  alternates: {
    canonical: '/overview',
  },
  openGraph: {
    title: '全端生态总览 · 烽火台 Beacon (整机/Win/Mac/SaaS/插件)',
    description: '烽火台跨平台内容作战室全端产品介绍，覆盖整机私有化部署、桌面客户端、云端 SaaS 与采集扩展。',
    url: '/overview',
    type: 'website',
  },
};

export default function OverviewPage() {
  return <OverviewView />;
}
