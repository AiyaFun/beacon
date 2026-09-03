import { Metadata } from 'next';
import { OverviewView } from './OverviewView';

export const metadata: Metadata = {
  title: '全端生态总览 · 烽火台 Beacon (整机/Win/Mac/SaaS/插件)',
  description: '烽火台跨平台内容作战室全端产品介绍，覆盖整机私有化部署、Windows/macOS 桌面客户端、云端 SaaS 与采集扩展。',
};

export default function OverviewPage() {
  return <OverviewView />;
}
