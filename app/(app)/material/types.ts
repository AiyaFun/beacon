export type MaterialType = 'experience' | 'case' | 'opinion' | 'catchphrase' | 'sample';

export const MATERIAL_TYPES: Record<MaterialType, { name: string; desc: string; placeholder: string }> = {
  experience: { name: '经历', desc: '个人真实经历、故事', placeholder: '比如：去年开始做副业，前三个月颗粒无收…' },
  case: { name: '案例', desc: '服务过的客户、项目经验', placeholder: '比如：帮一个本地餐厅做抖音，3个月从0到5万粉…' },
  opinion: { name: '观点', desc: '独到见解、立场主张', placeholder: '比如：我认为短视频最重要的不是画质，而是前3秒的信息密度…' },
  catchphrase: { name: '口头禅', desc: '标志性表达、金句', placeholder: '比如：别人恐惧我贪婪、做难而正确的事…' },
  // 文风样本：不是「写什么」的素材，是「怎么说」的样本。整段贴你自己写过的东西，
  // 之后所有生成都会照着这个语感写（见 lib/account-context.ts loadExemplars）——
  // 这是去掉 AI 腔最有效的一件事，比在人设里写「语气：幽默」有用得多。
  sample: {
    name: '文风样本',
    desc: '你自己写过的整段文字，AI 照着这个语感写',
    placeholder: '整段粘一篇你自己写的稿子（越像你平时说话越好，200 字以上效果最佳）…',
  },
};

export type MaterialItem = {
  id: string;
  type: MaterialType;
  content: string;
  tags: string[];
  createdAt: string;
};
