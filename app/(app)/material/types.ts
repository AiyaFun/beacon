export type MaterialType = 'experience' | 'case' | 'opinion' | 'catchphrase' | 'sample';

export const MATERIAL_TYPES: Record<MaterialType, { name: string; nameEn: string; desc: string; descEn: string; placeholder: string; placeholderEn: string }> = {
  experience: {
    name: '经历',
    nameEn: 'Experience',
    desc: '个人真实经历、故事',
    descEn: 'Personal experiences & stories',
    placeholder: '比如：去年开始做副业，前三个月颗粒无收…',
    placeholderEn: 'E.g.: Started freelancing last year with zero income in the first three months...',
  },
  case: {
    name: '案例',
    nameEn: 'Case Study',
    desc: '服务过的客户、项目经验',
    descEn: 'Client work & project experience',
    placeholder: '比如：帮一个本地餐厅做抖音，3个月从0到5万粉…',
    placeholderEn: 'E.g.: Grew a local restaurant TikTok from 0 to 50k followers in 3 months...',
  },
  opinion: {
    name: '观点',
    nameEn: 'Opinion',
    desc: '独到见解、立场主张',
    descEn: 'Distinct perspectives & viewpoints',
    placeholder: '比如：我认为短视频最重要的不是画质，而是前3秒的信息密度…',
    placeholderEn: 'E.g.: In short videos, information density in first 3s matters far more than video resolution...',
  },
  catchphrase: {
    name: '口头禅',
    nameEn: 'Catchphrase',
    desc: '标志性表达、金句',
    descEn: 'Signature expressions & one-liners',
    placeholder: '比如：别人恐惧我贪婪、做难而正确的事…',
    placeholderEn: 'E.g.: Be greedy when others are fearful; do the hard and right thing...',
  },
  // 文风样本：不是「写什么」的素材，是「怎么说」的样本。整段贴你自己写过的东西，
  // 之后所有生成都会照着这个语感写（见 lib/account-context.ts loadExemplars）——
  // 这是去掉 AI 腔最有效的一件事，比在人设里写「语气：幽默」有用得多。
  sample: {
    name: '文风样本',
    nameEn: 'Writing Sample',
    desc: '你自己写过的整段文字，AI 照着这个语感写',
    descEn: 'Full paragraphs written by you for AI to emulate your voice',
    placeholder: '整段粘一篇你自己写的稿子（越像你平时说话越好，200 字以上效果最佳）…',
    placeholderEn: 'Paste a full article or script written by you (best with 200+ words in your authentic voice)...',
  },
};

export type MaterialItem = {
  id: string;
  type: MaterialType;
  content: string;
  tags: string[];
  createdAt: string;
};
