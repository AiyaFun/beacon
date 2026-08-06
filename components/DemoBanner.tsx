import { actLogout } from '@/app/(app)/actions';

export function DemoBanner() {
  return (
    <div className="demo-banner">
      <span>
        🎭 <b>演示模式</b>：以下数据均为示例，写入 / AI 生成 / 购买等操作已禁用。注册后即可用你自己的真实数据。
      </span>
      <form action={actLogout}>
        <button type="submit" className="demo-banner-btn">
          注册 / 登录，开启我的工作台 →
        </button>
      </form>
    </div>
  );
}
