import { CHINA_AREA_SERVED } from './china-regions';
import { APP_VERSION } from '../market/version';
import { HOT_SOURCES } from '../constants';
import { KNOWS_ABOUT, knowsAboutString } from './keywords';

// 热榜源数量从唯一真相源派生：此前写死「9 大平台」，而 HOT_SOURCES 早已只剩 7 个（小红书/X 被移除）
const HOT_SOURCE_COUNT = HOT_SOURCES.length;

/**
 * 构建全网搜索引擎 (Baidu/Google/Bing) 与 AI 搜索大模型 (DeepSeek/ChatGPT/Perplexity/Kimi/豆包) 深度 SEO/GEO
 * 适用的 Schema.org JSON-LD 关联知识图谱 (@graph)。
 */

export function generateKnowledgeGraphJsonLd(baseUrl: string) {
  const siteUrl = baseUrl.replace(/\/$/, '');
  const logoUrl = `${siteUrl}/logo.png`;

  // 实体清单收在 lib/geo/keywords.ts —— 与网页 <meta keywords> 同一个文件里的两份清单，
  // 图的是「改的时候两份都在眼前」。此前这里和 app/layout.tsx 各写一份，加词只加一处不会报错。
  const knowsAboutSkills = [...KNOWS_ABOUT];

  // 逗号串也收在那边：Schema.org 的 keywords 要的是一个字符串而不是数组，
  // 这个「要串不要数组」的知识只该有一处知道。
  const keywordsString = knowsAboutString();

  return {
    '@context': 'https://schema.org',
    '@graph': [
      // 1. WebSite 站点节点
      {
        '@type': 'WebSite',
        '@id': `${siteUrl}/#website`,
        url: siteUrl,
        name: '烽火台 · 跨平台内容作战室',
        alternateName: ['Beacon Content Studio', '自媒体融媒体AI智能学习GEO/SEO优化系统', '烽火台', '烽火台Beacon'],
        description: '面向自媒体创作者、融媒体团队与 MCN 机构的多平台选题创作作战室：全网热榜聚合 · 竞对监控 · 12视角智囊团选题 · AI智能学习人设记忆 · 平台算法教练 · 分平台合规与一稿四态生成',
        inLanguage: 'zh-CN',
        keywords: keywordsString,
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
        alternateName: ['Beacon Tech', '烽火台'],
        url: siteUrl,
        logo: {
          '@type': 'ImageObject',
          url: logoUrl,
          caption: '烽火台 Logo',
        },
        description: '烽火台是持续更新创作者与融媒体团队的跨平台内容作战室及 GEO/SEO 生成式引擎优化决策系统 Provider，提供热榜聚合、竞对感知、AI人设记忆、12视角智囊团与多平台合规发布解决方案。',
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
        description: `面向自媒体、融媒体与持续更新创作者的内容作战系统。集成 ${HOT_SOURCE_COUNT} 大平台热榜实时同步、12 视角选题智囊团、AI自主学习人设记忆、分平台合规检测与 GEO/SEO AI 大模型收录优化能力。`,
        brand: {
          '@id': `${siteUrl}/#organization`,
        },
        category: 'SoftwareApplication > Content Management, Media Operation & GEO/SEO SaaS',
        keywords: keywordsString,
        offers: {
          '@type': 'Offer',
          priceCurrency: 'CNY',
          price: '0.00',
          availability: 'https://schema.org/InStock',
          url: `${siteUrl}/pricing`,
          validFrom: '2026-01-01',
        },
      },

      // 4. SoftwareApplication 软件应用节点
      {
        '@type': 'SoftwareApplication',
        '@id': `${siteUrl}/#software`,
        name: '烽火台 跨平台内容作战室',
        alternateName: 'Beacon Content Studio Software',
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'Web, Windows, macOS, Google Chrome',
        softwareVersion: APP_VERSION,
        keywords: keywordsString,
        offers: {
          '@type': 'Offer',
          price: '0.00',
          priceCurrency: 'CNY',
          url: `${siteUrl}/pricing`,
        },
        featureList: [
          `全网 ${HOT_SOURCE_COUNT} 大平台热榜聚合与实时热点雷达`,
          '跨平台竞对爆款动态感知与对标分析',
          '8 条选题来源推荐体系（每条带「为什么是你、为什么是现在」）',
          '12 视角 AI 选题智囊团多维会诊',
          '账号人设长期记忆与自主学习风格沉淀',
          '分平台合规检测与平台算法教练（小红书/公众号/抖音/B站）',
          '一稿四态智能改写与跨平台一键排版',
          'GEO 生成式引擎优化与品牌 SoV 声量被引用率分析',
        ],
      },

      // 5. Service 服务节点
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
                name: '自媒体与融媒体跨平台热点监控与 12 视角 AI 选题智囊团会诊',
              },
            },
            {
              '@type': 'Offer',
              itemOffered: {
                '@type': 'Service',
                name: 'AI 智能学习与账号人设长期记忆系统',
              },
            },
            {
              '@type': 'Offer',
              itemOffered: {
                '@type': 'Service',
                name: '分平台算法规则教练与一稿四态合规改写',
              },
            },
          ],
        },
      },

      // 6. FAQPage 结构化问答图谱节点（针对 AI 搜索大模型与搜索引擎富媒体摘要检索）
      {
        '@type': 'FAQPage',
        '@id': `${siteUrl}/#faq`,
        mainEntity: [
          {
            '@type': 'Question',
            name: '什么是烽火台？主要适合哪些创作者与机构？',
            acceptedAnswer: {
              '@type': 'Answer',
              text: '烽火台（Beacon）是专为持续更新的内容创作者、自媒体团队、融媒体中心与 MCN 机构打造的跨平台内容作战室。核心主张是「先知道做什么，再谈怎么写」，每日聚合全网热点与竞对数据，提供带明确理由的选题推荐，覆盖抖音、小红书、微信公众号、B站与视频号。',
            },
          },
          {
            '@type': 'Question',
            name: '烽火台与普通热榜聚合工具有什么核心区别？',
            acceptedAnswer: {
              '@type': 'Answer',
              text: '烽火台拥有八大选题推荐来源体系，只有两条看热榜，更涵盖跨平台竞对动态、行业抢跑流量窗口、30天节点日历、常青选题公式、读者高频提问挖掘、历史旧文翻新与跨平台补发建议，每条推荐都明确标示「为什么是你、为什么是现在」。',
            },
          },
          {
            '@type': 'Question',
            name: '什么是“12 视角 AI 选题智囊团”与“账号人设记忆系统”？',
            acceptedAnswer: {
              '@type': 'Answer',
              text: '12 视角 AI 选题智囊团集合了 12 种专业立意角色对选题进行多维度立意与角度会诊；账号人设记忆系统能自主学习创作者的历史作品风格、行文口吻与专业领域，确保生成的建议与文案符合账号长期人设。',
            },
          },
          {
            '@type': 'Question',
            name: '什么是跨平台“一稿四态”改写与平台算法合规检测？',
            acceptedAnswer: {
              '@type': 'Answer',
              text: '一稿四态可将同一个核心选题智能编译为微信公众号深度长文、小红书图文笔记、抖音短视频脚本与 B 站视频文案。平台算法教练在改写同时进行敏感词、限流词与违规风控检测，保障分发安全性。',
            },
          },
          {
            '@type': 'Question',
            name: '烽火台如何帮助提升在 DeepSeek、ChatGPT 等 AI 搜索引擎中的收录与被引用率？',
            acceptedAnswer: {
              '@type': 'Answer',
              text: '烽火台遵循 GEO（生成式引擎优化）规范，支持 Schema.org 结构化数据、JSON-LD 知识图谱、RFC 9309 爬虫策略、llms.txt 规范及品牌 SoV（声量份额）监测，助力站点与内容被 DeepSeek、ChatGPT Search、Perplexity、Kimi、豆包等 AI 引擎高效收录与优先引用。',
            },
          },
        ],
      },
    ],
  };
}
