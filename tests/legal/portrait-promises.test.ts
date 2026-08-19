import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  MAX_SUBJECT_IMAGES,
  MAX_BACKGROUND_IMAGES,
  MAX_REFERENCE_MB,
  REFERENCE_IMAGES_NOT_STORED,
  IMAGE_PROCESSOR_NAME,
  LIBRARY_MAX_ASSETS,
  COVER_RETENTION_DAYS,
  COVER_MAX_PER_WORKSPACE,
} from '@/lib/cover/rules';

// AI 封面参考图（人像）：对外承诺 ↔ 代码常量 ↔ 关键代码形状，三侧同时断言。
//
// 为什么这个守卫必须存在：08-07 上线的封面技能允许上传参考图，而站内隐私政策对「参考图 / 肖像」的披露是 0 处
// ——功能先跑了、政策没跟上。人像属于敏感个人信息，这类漂移不是文案问题。
// 这里断言的是**文本与常量的一致性**：政策里写「单张 1MB」「不保存」，常量就必须是 1 与 true；
// 谁改了数字没改政策（或反过来），当场变红。范式同 tests/legal/privacy-promises.test.ts。
//
// 只对站内两份文本断言：AI 封面是网页端功能，插件商店那份政策不涉及人像上传，不硬套。

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const PRIVACY = read('app/(public)/legal/privacy/page.tsx');
const TERMS = read('app/(public)/legal/terms/page.tsx');
const STATION = read('app/(app)/studio/CoverStation.tsx');
const IMAGE_TS = read('lib/llm/image.ts');
const RUN_TS = read('lib/cover/run.ts');

describe('AI 封面参考图：隐私政策文本 ↔ 常量', () => {
  it(`🔒 写明张数上限（人像 ${MAX_SUBJECT_IMAGES} 张、背景 ${MAX_BACKGROUND_IMAGES} 张）与单张 ${MAX_REFERENCE_MB}MB`, () => {
    expect(PRIVACY).toContain(`最多 ${MAX_SUBJECT_IMAGES} 张人像`);
    expect(PRIVACY).toContain(`最多 ${MAX_BACKGROUND_IMAGES} 张背景`);
    expect(PRIVACY).toContain(`单张 ${MAX_REFERENCE_MB}MB`);
  });

  it('🔒 写明单独同意 / 接收方 / 默认不保存 / 不进语料 / 不做人脸识别', () => {
    expect(PRIVACY).toContain('单独勾选确认');
    expect(PRIVACY).toContain(IMAGE_PROCESSOR_NAME.slice(0, 6)); // 火山引擎方舟
    expect(REFERENCE_IMAGES_NOT_STORED).toBe(true);
    expect(PRIVACY).toContain('默认不保存');
    expect(PRIVACY).toContain('不进入任何模型训练');
    expect(PRIVACY).toContain('不做人脸识别');
  });

  // 落库之后「不保存」这句话只对**一次性上传**成立了。政策必须把两种口径分开写，
  // 而且数字要与代码一致——写「不保存」但实际存了，是这个项目栽过两次的那种文案-行为不一致。
  it(`🔒 形象库口径：写明加密存储、最多 ${LIBRARY_MAX_ASSETS} 张、保存到用户删除或注销`, () => {
    expect(PRIVACY).toContain('存进我的形象');
    expect(PRIVACY).toContain('加密存储');
    expect(PRIVACY).toContain(`最多 ${LIBRARY_MAX_ASSETS} 张`);
    expect(PRIVACY).toMatch(/保存到你自己删除或账号注销/);
  });

  it(`🔒 封面留存口径：写明保留 ${COVER_RETENTION_DAYS} 天 / 最近 ${COVER_MAX_PER_WORKSPACE} 张、可删、注销一并删`, () => {
    expect(PRIVACY).toContain(`${COVER_RETENTION_DAYS} 天`);
    expect(PRIVACY).toContain(`最近 ${COVER_MAX_PER_WORKSPACE} 张`);
    expect(PRIVACY).toContain('注销时一并删除');
  });

  it('🔒 写明 AI 封面的显式水印 + 隐式元数据标识（PNG / JPEG 都覆盖）', () => {
    expect(PRIVACY).toContain('显式水印');
    expect(PRIVACY).toContain('隐式元数据标识');
    expect(PRIVACY).toMatch(/JPEG.*XMP/);
  });

  it('🔒 服务条款：不得上传他人（未经单独同意）/ 未成年人的人像', () => {
    expect(TERMS).toContain('单独同意');
    expect(TERMS).toContain('未成年人的人像');
  });
});

describe('AI 封面参考图：UI 勾选文案 ↔ 常量', () => {
  it('🔒 上传处的同意文案写清 本人/单独同意/接收方/不保存/单张上限', () => {
    expect(STATION).toContain('本人');
    expect(STATION).toContain('单独同意');
    expect(STATION).toContain('IMAGE_PROCESSOR_NAME');
    expect(STATION).toContain('不保存');
    expect(STATION).toContain('MAX_REFERENCE_MB');
  });

  it('🔒 未勾选时上传按钮置灰（disabled={!consent}），而不是隐藏', () => {
    expect(STATION).toContain('disabled={!consent}');
  });
});

describe('AI 封面：代码形状守卫', () => {
  it('🔒 水印服务端强制：请求体写死 watermark: true，请求类型不再暴露 watermark 开关', () => {
    expect(IMAGE_TS).toContain('watermark: true');
    expect(IMAGE_TS).not.toMatch(/watermark\?:\s*boolean/);
  });

  it('🔒 一次性上传的参考图不落库：run.ts 只把生成结果（kind=cover）写库，没有写 portrait/background 的路径', () => {
    // run.ts 会读 CoverStylePreset（自定义风格），所以不能笼统地断言「不出现 prisma」；
    // 真正要守的是：图片的写入只有一条路（saveMediaAsset 且 kind=cover），
    // 参考图那两类**没有任何写入点**——用户直接选文件上传的照片就是用完即弃。
    expect(RUN_TS).not.toContain('prisma.mediaAsset'); // 不绕开 store 直接写图
    expect(RUN_TS).toContain("kind: 'cover'");
    expect(RUN_TS).not.toContain("kind: 'portrait'");
    expect(RUN_TS).not.toContain("kind: 'background'");
    // saveMediaAsset 只被调用一次（就是存那张封面）
    expect(RUN_TS.match(/saveMediaAsset\(/g) ?? []).toHaveLength(1);
  });

  it('🔒 存人像进形象库必须带同意：store 里有服务端重算的那道闸', () => {
    const STORE = read('lib/media/store.ts');
    expect(STORE).toMatch(/kind === 'portrait' && !input\.consented/);
    // 人像加密落库，封面明文（封面本来就要给用户下载）
    expect(STORE).toContain('encryptBytes');
  });

  it('🔒 服务端重算同意：run.ts 在带参考图时校验 portraitConsent', () => {
    expect(RUN_TS).toMatch(/referenceImages\.length > 0 && input\.portraitConsent !== true/);
  });
});
