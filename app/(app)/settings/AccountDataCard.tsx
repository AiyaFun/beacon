'use client';

import { useState, useTransition } from 'react';
import { Card } from '@/components/ui';
import { Icon } from '@/components/icons';
import { actDeleteAccount, actDeletionPreview, type DeletionPreview } from './account-actions';

// 数据导出与账号注销（F9-8）。刻意做成一张卡两段：**先导出、再注销**——
// 注销的确认区里也放着导出按钮，因为「点到这一步才想起来数据没备份」是最常见的后悔时刻。

const CONFIRM_TEXT = '注销账号';

export function AccountDataCard({
  isDemo,
  isOwner,
  canExport,
}: {
  isDemo: boolean;
  isOwner: boolean;
  /** 全量导出＝把整个工作区打包带走，仅 owner/admin（lib/rbac.ts data.export） */
  canExport: boolean;
}) {
  const [preview, setPreview] = useState<DeletionPreview | null>(null);
  const [open, setOpen] = useState(false);
  const [acked, setAcked] = useState(false);
  const [typed, setTyped] = useState('');
  const [err, setErr] = useState('');
  const [pending, start] = useTransition();

  function openConfirm() {
    setErr('');
    setOpen(true);
    if (!preview) start(async () => setPreview(await actDeletionPreview()));
  }

  function close() {
    setOpen(false);
    setAcked(false);
    setTyped('');
    setErr('');
  }

  function submit() {
    setErr('');
    start(async () => {
      // 成功时 action 内部 redirect，这里拿不到返回值；能走到下一行就说明被拦住了
      const r = await actDeleteAccount(typed);
      if (r && !r.ok) setErr(r.error);
    });
  }

  const blocked = preview?.blocked ?? null;
  const scopeIsTenant = preview ? preview.scope === 'tenant' : isOwner;
  const canSubmit = acked && typed.trim() === CONFIRM_TEXT && !blocked && !pending;

  return (
    <Card
      title="数据与注销"
      sub="导出你的全部数据 · 注销账号"
      action={
        <span className="badge badge-gray" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Icon.download size={13} /> 数据权利
        </span>
      }
    >
      {/* ── 导出 ── */}
      <div className="stack" style={{ gap: 10 }}>
        <div style={{ fontWeight: 600 }}>导出全部数据</div>
        <div className="small muted" style={{ lineHeight: 1.7 }}>
          一个 JSON 文件，包含你工作区的人设卡、素材、选题、草稿与版本、发布记录与表现数据、
          复盘报告、智囊团会诊、记忆条目、灵感箱、竞对订阅、合规记录与订单流水。
          <br />
          出于安全，<b>API Key、机器人密钥、采集令牌、登录凭证不在导出范围内</b>；
          记忆的向量索引也不导出（正文完整保留）。
        </div>
        {canExport ? (
          <div>
            <a className="btn btn-sm btn-primary" href="/api/account/export" download>
              下载数据导出包（JSON）
            </a>
          </div>
        ) : (
          <div className="small muted">
            导出的是整个工作区的数据，仅工作区<b>所有者与管理员</b>可操作。需要留档请联系工作区管理员。
          </div>
        )}
      </div>

      <div className="divider" style={{ margin: '18px 0' }} />

      {/* ── 注销 ── */}
      <div className="stack" style={{ gap: 10 }}>
        <div style={{ fontWeight: 600, color: 'var(--red)' }}>注销账号</div>

        {isDemo ? (
          <div className="small muted">演示账号无需注销，关闭页面即可。注册自己的账号后可随时在此注销。</div>
        ) : (
          <>
            <div className="small muted" style={{ lineHeight: 1.7 }}>
              {scopeIsTenant ? (
                <>
                  你是本工作区的所有者，注销将<b>删除整个工作区及其全部数据</b>，且<b>无法恢复</b>。
                  BYOK 密钥、机器人密钥与采集令牌即时销毁；AI 调用日志按法规留存至期限届满，
                  期间不再关联到你的账号；已完成的交易凭证按《电子商务法》以去标识化形式保留三年
                  （仅含单号与金额，不含任何个人信息）。
                </>
              ) : (
                <>
                  你是本工作区的成员，注销将<b>删除你的账号与登录方式</b>，并把你从工作区移出。
                  工作区本身及团队共同的内容数据归工作区所有，会保留给其他成员。
                </>
              )}
            </div>

            {!open ? (
              <div>
                <button
                  className="btn btn-sm"
                  onClick={openConfirm}
                  style={{ color: 'var(--red)', borderColor: 'var(--red)' }}
                >
                  我要注销账号
                </button>
              </div>
            ) : (
              <div
                className="stack"
                style={{ gap: 12, border: '1px solid var(--red)', borderRadius: 10, padding: 14, background: 'var(--red-soft)' }}
              >
                {pending && !preview && <div className="small muted">正在统计将被删除的数据…</div>}

                {blocked && (
                  <div className="small" style={{ color: 'var(--red)', fontWeight: 600, lineHeight: 1.7 }}>
                    {blocked}
                  </div>
                )}

                {preview && !blocked && (
                  <>
                    {preview.paidUntil && (
                      <div className="small" style={{ color: 'var(--red)' }}>
                        ⚠️ 当前套餐（{preview.plan}）有效期至 {preview.paidUntil}，注销后剩余权益一并作废且不予退款。
                        如需退款请先联系客服。
                      </div>
                    )}

                    {preview.scope === 'tenant' && (
                      <div>
                        <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>
                          以下数据将被永久删除：
                        </div>
                        <div className="grid grid-2" style={{ gap: '2px 16px' }}>
                          {preview.inventory
                            .filter((r) => r.count > 0)
                            .map((r) => (
                              <div key={r.key} className="small row-between" style={{ gap: 8 }}>
                                <span className="muted">{r.label}</span>
                                <b className="mono">{r.count}</b>
                              </div>
                            ))}
                        </div>
                        {preview.inventory.every((r) => r.count === 0) && (
                          <div className="small muted">这个工作区还没有任何数据。</div>
                        )}
                      </div>
                    )}

                    {canExport && (
                      <div className="small">
                        还没备份？
                        <a href="/api/account/export" download style={{ marginLeft: 4 }}>
                          先下载数据导出包 →
                        </a>
                      </div>
                    )}

                    <label className="small row" style={{ gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={acked}
                        onChange={(e) => setAcked(e.target.checked)}
                        style={{ marginTop: 3 }}
                      />
                      <span>我已导出需要保留的数据，并理解注销不可撤销、数据无法找回。</span>
                    </label>

                    <div className="stack" style={{ gap: 6 }}>
                      <div className="small">
                        请逐字输入 <b className="mono">{CONFIRM_TEXT}</b> 以确认：
                      </div>
                      <input
                        className="input"
                        value={typed}
                        placeholder={CONFIRM_TEXT}
                        onChange={(e) => setTyped(e.target.value)}
                        style={{ maxWidth: 220 }}
                      />
                    </div>
                  </>
                )}

                {err && (
                  <div className="small" style={{ color: 'var(--red)', fontWeight: 600 }}>
                    {err}
                  </div>
                )}

                <div className="row" style={{ gap: 8 }}>
                  <button
                    className="btn btn-sm"
                    onClick={submit}
                    disabled={!canSubmit}
                    style={canSubmit ? { background: 'var(--red)', borderColor: 'var(--red)', color: '#fff' } : undefined}
                  >
                    {pending ? '注销中…' : '确认注销'}
                  </button>
                  <button className="btn btn-sm btn-ghost" onClick={close} disabled={pending}>
                    取消
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
