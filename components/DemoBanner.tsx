import { headers } from 'next/headers';
import { actDemoExit } from '@/app/(app)/actions';
import { getServerLang } from '@/lib/i18n/server';
import { PATHNAME_HEADER } from '@/lib/auth-constants';

export async function DemoBanner() {
  const lang = await getServerLang();
  const isEn = lang === 'en';
  // 「注册 / 登录」按钮把当前这一页带过去：登完回到刚才看的地方，体验与注册不再是断开的两件事
  const here = (await headers()).get(PATHNAME_HEADER) ?? '/';
  const exit = actDemoExit.bind(null, here);
  return (
    <div className="demo-banner">
      <span>
        🎭 <b>{isEn ? 'Demo Mode' : '演示模式'}</b>
        {isEn
          ? ': The following data is for demonstration only. Writes, AI generation, and billing are disabled. Sign up to use real data.'
          : '：以下数据均为示例，写入 / AI 生成 / 购买等操作已禁用。注册后即可用你自己的真实数据。'}
      </span>
      <form action={exit}>
        <button type="submit" className="demo-banner-btn">
          {isEn ? 'Sign up / Log in to open my workspace →' : '注册 / 登录，开启我的工作台 →'}
        </button>
      </form>
    </div>
  );
}
