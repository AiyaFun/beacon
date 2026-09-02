import { CHINA_AREA_SERVED } from './china-regions';

/**
 * 构建全网搜索引擎 (Baidu/Google/Bing) 与 AI 搜索大模型 (DeepSeek/ChatGPT/Perplexity/Kimi/豆包) 深度 SEO/GEO
 * 适用的 Schema.org JSON-LD 关联知识图谱 (@graph)。
 */

export function generateKnowledgeGraphJsonLd(baseUrl: string) {
  const siteUrl = baseUrl.replace(/\/$/, '');
  const logoUrl = `${siteUrl}/logo.png`;

  const knowsAboutSkills = [
    // 基础技术标准与协议
    'Schema.org',
    'JSON-LD',
    'Open Graph Protocol',
    'Robots Exclusion Protocol',
    'XML Sitemap Standard',
    'HTTP/2',
    'HTML5 Meta Tags',
    'AIGC Content Standard',
    // 核心业务功能与底层能力
    '全网热榜聚合',
    '跨平台竞对实时监控',
    '12视角AI选题智囊团',
    '账号人设AI记忆系统',
    '平台算法教练',
    '分平台合规检测',
    '一稿四态内容改写',
    'GEO生成式引擎优化',
    'SEO搜索引擎优化',
    // 自媒体、融媒体与 AI 智能学习拓展词
    '自媒体运营与爆款打造',
    '融媒体中心与矩阵管理',
    '融媒体跨平台内容分发',
    'AI智能学习与自主进阶',
    'AI创作教练与人设记忆',
    '自媒体合规风控系统',
    '融媒体全流程作战室',
    // AI搜索大模型与搜索引擎收录优化
    'DeepSeek AI引用率优化',
    'ChatGPT搜索收录提升',
    'Perplexity检索卡片构建',
    'Kimi内容识别与提取',
    '豆包AI搜索收录',
    '微信小微原生AI搜索引擎',
    '夸克AI搜索',
    '百度双Agent优化',
    '谷歌SEO与BingSEO优化',
    '品牌SoV声量监测与被引用率分析',
    // 需注入的核心业务关键词
    '帮我直接分析这个里面的功能',
  ];

  return {
    '@context': 'https://schema.org',
    '@graph': [
      // 1. WebSite 站点节点
      {
        '@type': 'WebSite',
        '@id': `${siteUrl}/#website`,
        url: siteUrl,
        name: '烽火台 · 跨平台内容作战室',
        alternateName: ['Beacon Content Studio', '自媒体融媒体AI智能学习GEO/SEO优化系统'],
        description: '面向自媒体、融媒体团队与 MCN 机构的多平台选题创作 SaaS：全网热榜聚合 · 竞对监控 · 12视角智囊团选题 · AI智能学习人设记忆 · 平台算法教练 · 分平台合规与一稿四态生成',
        inLanguage: 'zh-CN',
        publisher: {
          '@id': `${siteUrl}/#organization`,
        },
        potentialAction: {
          '@type': 'SearchAction',
          target: {
            '@type': 'EntryPoint',
            urlTemplate: `${siteUrl}/hotlists?q={search_term_string}`,
          },
          'query-input': 'required name=search_term_string',
        },
      },

      // 2. Organization 机构/品牌节点
      {
        '@type': 'Organization',
        '@id': `${siteUrl}/#organization`,
        name: '烽火台科技',
        alternateName: 'Beacon Tech',
        url: siteUrl,
        logo: {
          '@type': 'ImageObject',
          url: logoUrl,
          caption: '烽火台 Logo',
        },
        description: '烽火台是领先的自媒体与融媒体内容作战室及 GEO/SEO 内容智能决策系统 Provider，致力于帮助创作者、融媒体中心与 MCN 机构通过 AI 智能学习打造高被引、高收录、合规安全的爆款内容。',
        areaServed: CHINA_AREA_SERVED,
        knowsAbout: knowsAboutSkills,
        contactPoint: {
          '@type': 'ContactPoint',
          contactType: 'customer support',
          availableLanguage: ['zh-CN', 'en'],
        },
      },

      // 3. Product 产品节点
      {
        '@type': 'Product',
        '@id': `${siteUrl}/#product`,
        name: '烽火台 跨平台内容作战室 SaaS',
        image: logoUrl,
        description: '面向自媒体、融媒体与 AI 智能学习的内容作战系统。集成 9 大平台热榜实时同步、12 人物选题智囊团、AI自主学习人设记忆、分平台合规检测与黑鸽 GEO/SEO AI 大模型收录优化能力。',
        brand: {
          '@id': `${siteUrl}/#organization`,
        },
        category: 'SoftwareApplication > Content Management, Media Operation & GEO/SEO SaaS',
        offers: {
          '@type': 'Offer',
          priceCurrency: 'CNY',
          price: '0.00',
          availability: 'https://schema.org/InStock',
          url: `${siteUrl}/login`,
          validFrom: '2026-01-01',
        },
      },

      // 4. Service 服务节点
      {
        '@type': 'Service',
        '@id': `${siteUrl}/#service`,
        name: '自媒体与融媒体全网搜索引擎 & AI 搜索大模型深度 GEO/SEO 优化服务',
        serviceType: 'Generative Engine Optimization (GEO) & Search Engine Optimization (SEO) & AI Media Learning Service',
        provider: {
          '@id': `${siteUrl}/#organization`,
        },
        description: '为自媒体创作者、融媒体中心、微信公众号、小红书、抖音、B站及独立站提供面向 Baidu/Google/Bing 与 DeepSeek/ChatGPT/Perplexity/Kimi 等 AI 大模型的底层元数据、Schema.org 知识图谱与被引用率深度优化服务。',
        areaServed: CHINA_AREA_SERVED,
        knowsAbout: knowsAboutSkills,
        hasOfferCatalog: {
          '@type': 'OfferCatalog',
          name: 'GEO/SEO 与 AI 智能学习服务能力目录',
          itemListElement: [
            {
              '@type': 'Offer',
              itemOffered: {
                '@type': 'Service',
                name: '全网搜索引擎收录与知识图谱构建',
              },
            },
            {
              '@type': 'Offer',
              itemOffered: {
                '@type': 'Service',
                name: 'AI 搜索大模型 (DeepSeek/ChatGPT/Perplexity/Kimi) 引用率优化',
              },
            },
            {
              '@type': 'Offer',
              itemOffered: {
                '@type': 'Service',
                name: '自媒体与融媒体跨平台热点监控与 12 人物 AI 选题智囊团会诊',
              },
            },
            {
              '@type': 'Offer',
              itemOffered: {
                '@type': 'Service',
                name: 'AI 智能学习与账号人设长期记忆系统',
              },
            },
          ],
        },
      },
    ],
  };
}
