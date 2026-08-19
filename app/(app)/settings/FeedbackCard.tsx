'use client';

import { useState } from 'react';
import Image from 'next/image';
import { Card } from '@/components/ui';
import { Overlay } from '@/components/Overlay';
import { Icon } from '@/components/icons';

export function FeedbackCard() {
  const [copied, setCopied] = useState(false);
  // Esc 关闭 / 点遮罩关闭 / 锁背景滚动 三件事都由 Overlay 统一做了，这里不再自己挂 keydown
  const [showModal, setShowModal] = useState(false);

  const groupName = '烽火台交流群';
  const groupOrg = '大脑壳网络';

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(groupName);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
    }
  };

  return (
    <>
      <Card
        title="问题反馈与社群支持"
        sub="扫描飞书二维码加入官方交流群，与团队直接沟通"
        action={
          <span className="badge badge-brand" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Icon.chat size={13} /> 飞书群支持
          </span>
        }
        style={{ marginBottom: 16 }}
      >
        <div className="grid grid-2" style={{ gap: 20, alignItems: 'center' }}>
          {/* 左侧说明 */}
          <div className="stack" style={{ gap: 14 }}>
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              <span
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 8,
                  background: 'var(--brand-soft)',
                  color: 'var(--brand)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontWeight: 700,
                  fontSize: 16,
                  flexShrink: 0,
                }}
              >
                💬
              </span>
              <div>
                <div style={{ fontWeight: 600, fontSize: 15 }}>{groupName}</div>
                <div className="small muted">{groupOrg} · 飞书官方交流群</div>
              </div>
            </div>

            <div className="stack" style={{ gap: 10, fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.6 }}>
              <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                <span style={{ color: 'var(--brand)', marginTop: 2, flexShrink: 0 }}>•</span>
                <span><b>问题上报与故障排查：</b>报错提报、数据回流异常、模型 Key 连通与接入排查。</span>
              </div>
              <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                <span style={{ color: 'var(--brand)', marginTop: 2, flexShrink: 0 }}>•</span>
                <span><b>需求与功能建议：</b>热点算法优化、写作人设调优、机器人功能需求直达团队。</span>
              </div>
              <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                <span style={{ color: 'var(--brand)', marginTop: 2, flexShrink: 0 }}>•</span>
                <span><b>新功能内测公告：</b>优先获取新功能内测资格、规则调优说明与操作指引。</span>
              </div>
              <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                <span style={{ color: 'var(--green, #10b981)', marginTop: 2, flexShrink: 0 }}>•</span>
                <span><b>隐私安全保障：</b>保护每个人的隐私数据，隐私安全卫士 提供数据保护。</span>
              </div>
            </div>

            <div className="row wrap" style={{ gap: 8, marginTop: 4 }}>
              <button className="btn btn-sm btn-ghost" onClick={handleCopy}>
                {copied ? '✓ 已复制群名称' : '复制群名称'}
              </button>
              <button className="btn btn-sm btn-ghost" onClick={() => setShowModal(true)}>
                <Icon.sparkles size={13} /> 放大二维码
              </button>
              <a href="/feishu-qr.png" download="烽火台飞书交流群二维码.png" className="btn btn-sm btn-ghost">
                <Icon.download size={13} /> 下载二维码
              </a>
            </div>
          </div>

          {/* 右侧二维码卡片 */}
          <div
            className="row"
            style={{
              justifyContent: 'center',
              alignItems: 'center',
              background: 'var(--surface-2)',
              borderRadius: 12,
              padding: 20,
              border: '1px solid var(--surface-3, rgba(255,255,255,0.06))',
            }}
          >
            <div
              style={{
                background: 'var(--surface)',
                borderRadius: 12,
                padding: 16,
                border: '1px solid var(--border)',
                boxShadow: 'var(--shadow)',
                textAlign: 'center',
                maxWidth: 240,
                width: '100%',
                cursor: 'pointer',
              }}
              onClick={() => setShowModal(true)}
              title="点击查看大图"
            >
              <div
                style={{
                  background: 'var(--surface-2)',
                  borderRadius: 8,
                  padding: '10px 12px',
                  color: 'var(--text)',
                  marginBottom: 12,
                  textAlign: 'left',
                  border: '1px solid var(--border)',
                }}
              >
                <div style={{ fontWeight: 600, fontSize: 14 }}>{groupName}</div>
                <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{groupOrg}</div>
              </div>

              <div style={{ position: 'relative', width: 180, height: 180, margin: '0 auto 10px' }}>
                <Image
                  src="/feishu-qr.png"
                  alt="烽火台飞书交流群二维码"
                  width={180}
                  height={180}
                  style={{ borderRadius: 6, objectFit: 'contain' }}
                />
              </div>

              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 2 }}>
                扫描群二维码，立刻加入该群
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
                该二维码永久有效
              </div>
            </div>
          </div>
        </div>
      </Card>

      {/* 点击放大 Modal。走 Overlay（portal 到 body）而不是就地渲染：
          这张卡片今天恰好没被别的 .card 套住，但「谁把它挪进另一张卡片」是随时会发生的事，
          而那一刻二维码会缩进卡片里、且只在指针悬停时复现。见 components/Overlay.tsx。 */}
      {showModal && (
        <Overlay onClose={() => setShowModal(false)} label="烽火台交流群二维码">
          <div
            style={{
              background: 'var(--surface)',
              borderRadius: 16,
              padding: 24,
              maxWidth: 380,
              width: '100%',
              boxShadow: '0 20px 40px rgba(0,0,0,0.3)',
              position: 'relative',
              textAlign: 'center',
            }}
          >
            <button
              onClick={() => setShowModal(false)}
              aria-label="关闭"
              style={{
                position: 'absolute',
                top: 12,
                right: 12,
                background: 'none',
                border: 'none',
                fontSize: 18,
                cursor: 'pointer',
                color: 'var(--text-3)',
                padding: 4,
              }}
            >
              ✕
            </button>

            <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text)', marginBottom: 4 }}>
              烽火台交流群
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 16 }}>
              大脑壳网络 · 飞书扫码加入
            </div>

            <div style={{ width: 280, height: 280, margin: '0 auto 16px', position: 'relative' }}>
              <Image
                src="/feishu-qr.png"
                alt="烽火台飞书交流群二维码大图"
                width={280}
                height={280}
                style={{ borderRadius: 8, objectFit: 'contain' }}
              />
            </div>

            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>
              扫描群二维码，立刻加入该群
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 16 }}>
              该二维码永久有效
            </div>

            <div className="row" style={{ gap: 10, justifyContent: 'center' }}>
              <a
                href="/feishu-qr.png"
                download="烽火台飞书交流群二维码.png"
                className="btn btn-sm btn-primary"
                style={{ textDecoration: 'none' }}
              >
                <Icon.download size={13} /> 保存图片
              </a>
              <button className="btn btn-sm btn-ghost" onClick={() => setShowModal(false)}>
                关闭
              </button>
            </div>
          </div>
        </Overlay>
      )}
    </>
  );
}
