import { IMAGE_PROCESSOR_NAME, MAX_REFERENCE_MB } from '@/lib/cover/rules';

// 上传参考图前的**单独同意**（PIPL 第 29 条：处理人脸这类敏感个人信息要单独同意）。
//
// 【为什么抽成组件】这句话现在长在两个地方：创作工坊的封面工位、出图工位。
// 合规文本各写一份，早晚出现「一处说用完即弃、另一处说会保存」这种对不上的承诺——
// 而用户勾的是哪一句，法律上算数的就是哪一句。所以只有这一份。
//
// 调用方负责那个 checkbox 的状态与「未勾选就禁用上传」，这里只负责那段字。
export function PortraitConsentText() {
  return (
    <span>
      我确认上传的照片中的人物是<b>我本人</b>，或我已依法取得其<b>单独同意</b>；照片会以内联方式发送给
      {IMAGE_PROCESSOR_NAME} 用于出图，单张 ≤ {MAX_REFERENCE_MB}MB。
      <b>默认用完即弃</b>（不落库、不落盘）；只有你勾了「存进我的形象」才会加密保存下来，随时可删。
      不上传照片也可以直接出图。
    </span>
  );
}

/** 出图工位那一版：这里上传即入库（没有「用完即弃」这一档），措辞必须跟着变。 */
export function PortraitConsentTextForLibrary() {
  return (
    <span>
      我确认上传的照片中的人物是<b>我本人</b>，或我已依法取得其<b>单独同意</b>；照片会<b>加密保存</b>进
      「我的形象」以便下次直接勾选，出图时以内联方式发送给{IMAGE_PROCESSOR_NAME}，单张 ≤ {MAX_REFERENCE_MB}MB。
      随时可以删除，删除即从库里抹掉。
    </span>
  );
}
