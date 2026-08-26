import { describe, it, expect } from 'vitest';
import { describeArgs } from '@/lib/agent/args-summary';

// 确认卡上那句人话。
//
// 这一层的价值全在**用户真的看懂了**——在此之前卡上渲染的是
// `{"draftId":"cm4x9k2p0001…","platforms":["xiaohongshu","wechat"]}`。
// 对着它点「确认执行」，用户点的其实是「我信你」而不是「我看懂了」，
// 而这个产品的用户是内容创作者，不是读 JSON 的人。

describe('把参数写成人话', () => {
  it('平台键翻成平台名，不是原样的英文 key', () => {
    const s = describeArgs({ platforms: ['xiaohongshu', 'wechat'] });
    expect(s).toContain('小红书');
    expect(s).not.toContain('xiaohongshu');
  });

  it('周几用中文，且**空数组是「每天」**（这个口径反直觉，必须说破）', () => {
    expect(describeArgs({ weekdays: [1, 3, 5] })).toContain('周一');
    // 写成「周几：（空）」用户会以为一天都不跑，而实际是每天跑
    expect(describeArgs({ weekdays: [] })).toContain('每天');
  });

  it('id 类的值标成 # 短码，让人看出这是内部编号而不是乱码', () => {
    const s = describeArgs({ draftId: 'cm4x9k2p0001abcdef' });
    expect(s).toContain('草稿');
    expect(s).toContain('#');
    // 不该把整串 id 摆在卡上——它对用户没有任何意义，只是噪音
    expect(s).not.toContain('cm4x9k2p0001abcdef');
  });

  it('长正文只给开头（确认卡不是预览器）', () => {
    const s = describeArgs({ content: '正文'.repeat(200) });
    expect(s.length).toBeLessThan(200);
    expect(s).toContain('…');
  });

  it('布尔值说「是/否」，不是 true/false', () => {
    expect(describeArgs({ wait_for_result: true })).toContain('是');
    expect(describeArgs({ wait_for_result: true })).not.toContain('true');
  });

  it('空参数返回空串（调用方据此不显示参数区，而不是显示一个空的 {}）', () => {
    expect(describeArgs({})).toBe('');
    expect(describeArgs({ note: '', title: undefined })).toBe('');
  });

  it('认不出的键原样保留键名，不吞掉这一项', () => {
    // 吞掉的后果是：确认卡上少了一个参数，而它可能正是关键的那个
    const s = describeArgs({ someNewParam: '值' });
    expect(s).toContain('someNewParam');
    expect(s).toContain('值');
  });

  it('一次真实的发布计划确认，读起来是一句人话', () => {
    const s = describeArgs({ draftId: 'cm4x9k2p0001abcdef', platforms: ['xiaohongshu', 'wechat'] });
    expect(s).toMatch(/草稿.*平台|平台.*草稿/);
    // 平台名以 lib/constants 的 platformName 为准，别在测试里另写一份叫法
    expect(s).toContain('小红书、公众号');
  });
});
