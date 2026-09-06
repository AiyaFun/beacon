'use client';

import { useState, useEffect, useRef } from 'react';
import Image from 'next/image';
import { SLOGAN, SUBLINE, SLOGAN_EN, SUBLINE_EN } from '@/lib/brand';
import { useI18n } from '@/lib/i18n';

interface Feature {
  icon: string;
  title: string;
  desc: string;
}

interface SlideData {
  tag: string;
  line1: string;
  line2Highlight: string;
  desc: string;
  features: Feature[];
}

const SLIDES_EN: SlideData[] = [
  {
    tag: '🚀 Core Mission',
    line1: SLOGAN_EN,
    line2Highlight: 'Daily topics with clear reasons',
    desc: SUBLINE_EN,
    features: [
      {
        icon: '🧭',
        title: '8 Topic Sources, only 2 look at trending lists',
        desc: 'Window seizing, content recycling, cross-platform adaptation, editorial calendar, evergreen topics, inspiration box: topic ideas even without trends.',
      },
      {
        icon: '🎯',
        title: 'Every recommendation answers "Why you, why now"',
        desc: 'Evidence is backed by indexed historical facts: which past article, what time on which platform. Stay silent if unobservable, never guess.',
      },
    ],
  },
  {
    tag: '🧠 Intelligent Memory',
    line1: 'Deep learning of personal & brand style',
    line2Highlight: 'Understands you better over time',
    desc: 'Farewell to generic AI tone. Built-in account-level long-term memory system automatically retains voice habits, persona traits, and taboo preferences.',
    features: [
      {
        icon: '👤',
        title: 'Dedicated Persona Profile',
        desc: 'Automatically identifies account personality and industry positioning to match brand DNA.',
      },
      {
        icon: '✍️',
        title: 'Tone Calibration',
        desc: 'Learns from your edit history to eliminate excessive exclamation points and empty slogans.',
      },
    ],
  },
  {
    tag: '💡 Topic Brain Trust',
    line1: 'Consultation with 12 expert perspectives',
    line2Highlight: 'Differentiated 6-dimension scoring',
    desc: 'Beyond single perspectives. Trend analysts, competitor deconstructors, and narrative designers collaborate for high-converting topic angles.',
    features: [
      {
        icon: '📊',
        title: '6-Dimension Topic Scoring',
        desc: 'Precise assessment across hook power, audience fit, compliance risk, conversion potential, and more.',
      },
      {
        icon: '🔀',
        title: 'Differentiated Angles',
        desc: 'Avoid red-ocean competition, discovering unique hooks and high-engagement angles your peers missed.',
      },
    ],
  },
  {
    tag: '🛡️ Safety & Compliance',
    line1: 'Platform algorithm coach protection',
    line2Highlight: 'Safe publishing for every draft',
    desc: 'Real-time sync with latest prohibited word libraries and rules, predicting risks before generation and safely rewriting sensitive phrases.',
    features: [
      {
        icon: '⚡',
        title: 'Multi-Platform Risk Detection',
        desc: 'Targeted identification and risk levels for Xiaohongshu medical terms, Douyin restrictions, and more.',
      },
      {
        icon: '🪄',
        title: 'One-Click Compliant Rewriting',
        desc: 'Refactor sensitive terms while preserving core viewpoints and personal voice.',
      },
    ],
  },
];

const SLIDES: SlideData[] = [
  {
    tag: '🚀 核心定位',
    line1: SLOGAN,
    line2Highlight: '每天一份带理由的选题',
    desc: SUBLINE,
    features: [
      {
        icon: '🧭',
        title: '八条选题来源，只有两条看热榜',
        desc: '抢跑窗口、旧文翻新、跨平台补发、节点日历、常青题、灵感箱：没热点的日子也有题可做。',
      },
      {
        icon: '🎯',
        title: '每条推荐都带「为什么是你、为什么是现在」',
        desc: '证据是查库查出来的事实：哪条旧作、哪个平台几点上榜。观测不到就沉默，不猜。',
      },
    ],
  },
  {
    tag: '🧠 智能记忆',
    line1: '深度学习个人与品牌调性',
    line2Highlight: '越用越懂你',
    desc: '告别同质化 AI 腔调。内置账号级长期记忆系统，自动归纳语气习惯、人设标签与表达避坑偏好。',
    features: [
      {
        icon: '👤',
        title: '专属人设画像',
        desc: '自动识别账号性格与行业定位，确保输出内容契合品牌基因。',
      },
      {
        icon: '✍️',
        title: '表达习惯校准',
        desc: '自动学习你的修改历史，杜绝感叹号堆砌与口号式虚浮表述。',
      },
    ],
  },
  {
    tag: '💡 选题智囊',
    line1: '12 位多视角专家会诊',
    line2Highlight: '差异化六维评分',
    desc: '拒绝单一角度。热点侦析师、竞对解构师、叙事设计官多维碰撞，为每个账号量身定制高转化选题。',
    features: [
      {
        icon: '📊',
        title: '六维选题评分',
        desc: '针对吸睛度、受众匹配、合规风险、转化潜力等多维度精准考量。',
      },
      {
        icon: '🔀',
        title: '差异化切入角',
        desc: '避开红海直接竞争，寻找同行未提及的独特视角与高赞切入点。',
      },
    ],
  },
  {
    tag: '🛡️ 安全合规',
    line1: '分平台算法教练护航',
    line2Highlight: '每一篇稿件安全发布',
    desc: '实时同步各平台最新违禁词库与算法规范，生成前自动预测风险，一键重构敏感词汇，远离限流删稿。',
    features: [
      {
        icon: '⚡',
        title: '分平台敏感检测',
        desc: '小红书医疗词、抖音违禁词分平台精准识别与风险等级预警。',
      },
      {
        icon: '🪄',
        title: '智能一键合规改写',
        desc: '在保持核心观点与人设表达的前提下，替换掉会触发平台限流的词，改动处逐条标出来给你看。',
      },
    ],
  },
];

export function PromoCarousel() {
  const { lang } = useI18n();
  const isEn = lang === 'en';
  const slides = isEn ? SLIDES_EN : SLIDES;
  const [currentIndex, setCurrentIndex] = useState(0);
  const touchStartX = useRef(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentIndex((prev) => (prev + 1) % slides.length);
    }, 5000);
    return () => clearInterval(timer);
  }, [slides.length]);

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    const diff = touchStartX.current - e.changedTouches[0].clientX;
    if (diff > 40) {
      setCurrentIndex((prev) => (prev + 1) % slides.length);
    } else if (diff < -40) {
      setCurrentIndex((prev) => (prev - 1 + slides.length) % slides.length);
    }
  };

  return (
    <div className="login-left-panel">
      <div className="promo-brand-row">
        <Image src="/logo.png" alt={isEn ? 'Beacon' : '烽火台'} width={44} height={44} style={{ borderRadius: 10 }} />
        <div>
          <div className="promo-brand-title">{isEn ? 'Beacon' : '烽火台'}</div>
          <div className="promo-brand-sub">{isEn ? 'Cross-Platform Command Center' : '跨平台内容作战室'}</div>
        </div>
      </div>

      <div
        className="promo-carousel-viewport"
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        <div
          className="promo-carousel-track"
          style={{ transform: `translateX(-${currentIndex * 100}%)` }}
        >
          {slides.map((slide, i) => (
            <div key={i} className="promo-slide">
              <div className="promo-slide-tag">{slide.tag}</div>
              <h1 className="promo-hero-title">
                {slide.line1}
                <br />
                {i === 0 ? '' : (isEn ? 'Build ' : '打造')}<span style={{ color: '#ea580c' }}>{slide.line2Highlight}</span>
              </h1>
              <p className="promo-hero-desc">{slide.desc}</p>
              <div className="promo-features-grid">
                {slide.features.map((feat, idx) => (
                  <div key={idx} className="promo-feature-card">
                    <h4 className="promo-feature-title">
                      <span>{feat.icon}</span>
                      <span>{feat.title}</span>
                    </h4>
                    <p className="promo-feature-desc">{feat.desc}</p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="promo-controls">
        <div className="promo-dots-wrapper">
          {slides.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setCurrentIndex(i)}
              className={`promo-dot ${i === currentIndex ? 'promo-dot-active' : 'promo-dot-inactive'}`}
              aria-label={`Slide ${i + 1}`}
            />
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={() => setCurrentIndex((prev) => (prev - 1 + slides.length) % slides.length)}
            className="promo-arrow-btn"
          >
            &lsaquo;
          </button>
          <button
            type="button"
            onClick={() => setCurrentIndex((prev) => (prev + 1) % slides.length)}
            className="promo-arrow-btn"
          >
            &rsaquo;
          </button>
        </div>
      </div>
    </div>
  );
}
