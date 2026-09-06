'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { activeHref, nextSteps, type NavGroup } from '@/lib/nav';
import { Icon } from './icons';

// 「这一步做完，接着做什么」——独立成条，给**任务台**用。
//
// 【为什么必须单独有它】这段引导原本长在 StageTabs 里（阶段页签末尾那一跳），
// 而任务台不渲染阶段页签——于是切到任务台的用户把整条工作流链路全丢了：
// 写完稿不知道该去查合规、发完不知道要贴链接数据才会回流。
// 那条链路是这个产品最值钱的东西之一，不能因为换了个壳就消失。
//
// 【与阶段页签的区别】页签里那段会**过滤掉同阶段的**（同组的板块就在旁边，不用再指一遍）；
// 这里不过滤——任务台里根本没有「阶段」这个概念，旁边也没有那一排板块，
// 所以下一步该去哪儿要说全。
import { useI18n } from '@/lib/i18n';

const WHY_EN: Record<string, string> = {
  '把在榜话题变成你自己的选题候选': 'Turn trending topics into candidate ideas',
  '同行跑起来的题，换个角度做成你的': 'Adapt competitor angles into your own',
  '看这个平台今天吃什么（看效果页的「平台怎么想」标签）': 'See platform preferences in Analytics ("Algorithm Coach")',
  '存下来的资料拿去挑今天写什么': "Use saved assets to pick today's topic",
  '选定了就去起稿': 'Once chosen, start drafting',
  '人设变了，推荐会跟着变——去看今天该写哪条': 'Persona updated; see what to write today',
  '发之前过一遍平台红线': 'Review platform compliance before publishing',
  '写完了就排发布任务': 'Schedule publishing once drafting is done',
  '图配好了回去接着写': 'Images ready, return to drafting',
  '过了红线就去发': 'Guardrails passed, proceed to publish',
  '贴上作品链接，数据才会自动回流': 'Link published post to track performance',
  '按数据里跑得动的形状去挑下一条选题': 'Pick next topic matching winning patterns',
};

export function NextSteps({ nav }: { nav: NavGroup[] }) {
  const pathname = usePathname();
  const { lang, dict } = useI18n();
  const steps = nextSteps(activeHref(nav, pathname) ?? '');
  if (steps.length === 0) return null;

  return (
    <div className="next-bar">
      <span className="small muted next-bar-lead">{lang === 'en' ? 'Next' : '接下来'}</span>
      {steps.map((s) => {
        const itemLabel = dict.nav.items[s.href as keyof typeof dict.nav.items]?.label;
        const coveredLabel = (dict.nav.coveredPages as Record<string, string>)[s.href];
        const label = lang === 'en' ? (itemLabel || coveredLabel || s.label) : s.label;
        const why = lang === 'en' ? (WHY_EN[s.why] ?? s.why) : s.why;
        return (
          <span className="stage-next-wrap" key={s.href}>
            <span className="small muted stage-why">{why}</span>
            <Link href={s.href} className="stage-tab stage-next">
              {label} <Icon.arrow size={13} />
            </Link>
          </span>
        );
      })}
    </div>
  );
}
