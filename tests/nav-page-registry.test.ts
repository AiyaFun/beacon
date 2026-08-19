import { describe, it, expect } from 'vitest';
import { NAV } from '@/lib/nav';
import { PAGE_INFOS } from '@/components/GlobalAIAssistant';

// 导航里有的页面，助手的页面登记表里不许缺。
//
// 【为什么值得一条测试】GlobalAIAssistant.tsx 里那句「新增页面务必同步登记到这里」是注释，
// 而注释拦不住任何人——真机 2026-07-30 漏了 7 个页面，2026-08-19 加 /workflows 与
// /settings/keys 时又漏了两个（这条测试就是那次补的）。
// 漏登记的后果不是显示难看：「✨ 一键分析当前页面」靠 desc 告诉模型这一页是干什么的，
// 缺了它助手在这些页面上等于瞎着眼分析，而且**不报错**。

describe('页面登记表', () => {
  const hrefs = NAV.flatMap((g) => g.items.map((i) => i.href));

  it('导航里的每个页面都登记了名字与说明', () => {
    const missing = hrefs.filter((h) => !PAGE_INFOS[h]);
    expect(
      missing,
      `这些导航页没在 components/GlobalAIAssistant.tsx 的 PAGE_INFOS 里登记：${missing.join('、')}`,
    ).toEqual([]);
  });

  it('登记的说明不是占位（太短的等于没写）', () => {
    const thin = hrefs.filter((h) => (PAGE_INFOS[h]?.desc ?? '').length < 12);
    expect(thin, `这些页面的 desc 太短，助手拿它分析等于没有上下文：${thin.join('、')}`).toEqual([]);
  });

  it('守卫本身不许静默失效（导航至少有十几个页面）', () => {
    expect(hrefs.length).toBeGreaterThan(12);
  });
});
