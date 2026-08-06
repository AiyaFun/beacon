'use client';

import { useState, useEffect, useRef } from 'react';
import Image from 'next/image';

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

const SLIDES: SlideData[] = [
  {
    tag: '🚀 核心定位',
    line1: '盯着六大平台热点与竞对',
    line2Highlight: '一站式内容作战闭环',
    desc: '打通「看热点 -> 盯对手 -> 定选题 -> 写稿子 -> 查合规 -> 发布复盘」全链路，无需频繁切换多个工具。',
    features: [
      {
        icon: '📡',
        title: '全网热点雷达',
        desc: '实时监控抖音、小红书、公众号、B站、X、YouTube 六大平台爆款趋势。',
      },
      {
        icon: '🎯',
        title: '对标账号追踪',
        desc: '毫秒级感知竞对爆款更新与内容结构，捕捉最新的流量风向包。',
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
        desc: '在保持核心观点与人设表达的前提下，毫秒级优雅替换敏感词。',
      },
    ],
  },
];

export function PromoCarousel() {
  const [currentIndex, setCurrentIndex] = useState(0);
  const touchStartX = useRef(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentIndex((prev) => (prev + 1) % SLIDES.length);
    }, 5000);
    return () => clearInterval(timer);
  }, []);

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    const diff = touchStartX.current - e.changedTouches[0].clientX;
    if (diff > 40) {
      setCurrentIndex((prev) => (prev + 1) % SLIDES.length);
    } else if (diff < -40) {
      setCurrentIndex((prev) => (prev - 1 + SLIDES.length) % SLIDES.length);
    }
  };

  return (
    <div className="login-left-panel">
      <div className="promo-brand-row">
        <Image src="/logo.png" alt="烽火台" width={44} height={44} style={{ borderRadius: 10 }} />
        <div>
          <div className="promo-brand-title">烽火台</div>
          <div className="promo-brand-sub">跨平台内容作战室</div>
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
          {SLIDES.map((slide, i) => (
            <div key={i} className="promo-slide">
              <div className="promo-slide-tag">{slide.tag}</div>
              <h1 className="promo-hero-title">
                {slide.line1}
                <br />
                打造<span style={{ color: '#ea580c' }}>{slide.line2Highlight}</span>
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
          {SLIDES.map((_, i) => (
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
            onClick={() => setCurrentIndex((prev) => (prev - 1 + SLIDES.length) % SLIDES.length)}
            className="promo-arrow-btn"
          >
            &lsaquo;
          </button>
          <button
            type="button"
            onClick={() => setCurrentIndex((prev) => (prev + 1) % SLIDES.length)}
            className="promo-arrow-btn"
          >
            &rsaquo;
          </button>
        </div>
      </div>
    </div>
  );
}
