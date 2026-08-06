// AIGC 隐式标识的 OOXML 载体（《标识办法》第五条：文件元数据中添加隐式标识）。
//
// OOXML 的自定义属性住在 docProps/custom.xml，Word/PPT 的「属性 → 自定义」里可见。
// docx 与 pptx 用的是同一份 XML（自定义属性与文档类型无关），故抽到这里单独一份，
// 避免两个渲染器各写一遍、日后漂移成两种元数据。

import { aigcMetadataJson } from '../compliance/aigc';
import { escapeXml } from './zip';

export const AIGC_PROPS_PART = 'docProps/custom.xml';
export const AIGC_PROPS_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.custom-properties+xml';

/** 第五条的四个自定义属性：生成合成标记、服务提供者、内容编号、完整元数据 JSON。 */
export function aigcCustomPropsXml(produceId: string): string {
  const metadata = aigcMetadataJson(produceId);
  const producer = process.env.NEXT_PUBLIC_AIGC_PRODUCER || process.env.BEACON_AIGC_PRODUCER || '烽火台';
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties"',
    ' xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">',
    `<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="AIGC_Label">`,
    '<vt:lpwstr>1</vt:lpwstr></property>',
    `<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="3" name="AIGC_ContentProducer">`,
    `<vt:lpwstr>${escapeXml(producer)}</vt:lpwstr></property>`,
    `<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="4" name="AIGC_ProduceID">`,
    `<vt:lpwstr>${escapeXml(produceId)}</vt:lpwstr></property>`,
    `<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="5" name="AIGC_Metadata">`,
    `<vt:lpwstr>${escapeXml(metadata)}</vt:lpwstr></property>`,
    '</Properties>',
  ].join('');
}
