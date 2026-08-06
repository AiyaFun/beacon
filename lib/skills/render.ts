// 技能模板渲染（域14）：只做 {{content}}/{{title}}/{{persona}}/{{context}}/{{brief}} 五个占位符的字符串替换。
// 模板是数据不是代码——绝不 eval / new Function。用替换函数而非替换字符串，
// 否则正文里出现 "$&"/"$'" 这类 replace 特殊序列会被展开，把用户内容改坏。
// context = 账号的长期上下文（风格指纹/原句样本/口头禅/素材/记忆），W-2 起注入；
// brief   = 本次运行的临时要求（目标平台/篇幅/语气/指定引用的素材），由技能参数卡产出。
//
// 两者的区别要守住：context 是「这个账号一直是什么样」，brief 是「这一次想要什么」。
// 混成一个占位符，用户改一次篇幅就会把账号长期设定一起冲掉。

export type SkillVars = { content?: string; title?: string; persona?: string; context?: string; brief?: string };

type SkillVarKey = keyof SkillVars;

// 占位符白名单固定五个；容忍花括号内的空白（{{ content }} 也认）
const PLACEHOLDER = /\{\{\s*(content|title|persona|context|brief)\s*\}\}/g;

export function renderSkillTemplate(template: string, vars: SkillVars): string {
  return template.replace(PLACEHOLDER, (_m, key: SkillVarKey) => vars[key] ?? '');
}
