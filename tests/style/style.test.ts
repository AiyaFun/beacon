import { describe, it, expect } from 'vitest';
import {
  emptyFingerprint,
  readFingerprint,
  toFingerprintJson,
  mergeLayer,
  fingerprintPromptBlock,
  type FingerprintItem,
  type StyleFingerprint,
} from '@/lib/style';

describe('风格指纹 lib/style.ts', () => {
  describe('emptyFingerprint', () => {
    it('返回三层空数组', () => {
      const fp = emptyFingerprint();
      expect(fp.voice).toEqual([]);
      expect(fp.format).toEqual([]);
      expect(fp.topic).toEqual([]);
    });
  });

  describe('readFingerprint', () => {
    it('解析新版 FingerprintItem 格式', () => {
      const raw = JSON.stringify({
        voice: [{ tag: '幽默', score: 0.8, count: 3 }],
        format: [{ tag: '列表体', score: 0.6, count: 2 }],
        topic: [{ tag: '职场', score: 0.7, count: 1 }],
      });
      const fp = readFingerprint(raw);
      expect(fp.voice[0]).toEqual({ tag: '幽默', score: 0.8, count: 3 });
      expect(fp.format[0].tag).toBe('列表体');
      expect(fp.topic[0].tag).toBe('职场');
    });

    it('兼容旧版 string[] 格式，默认 score=0.5 count=1', () => {
      const raw = JSON.stringify({
        voice: ['犀利', '口语化'],
        format: ['问答体'],
        topic: [],
      });
      const fp = readFingerprint(raw);
      expect(fp.voice).toHaveLength(2);
      expect(fp.voice[0]).toEqual({ tag: '犀利', score: 0.5, count: 1 });
      expect(fp.voice[1]).toEqual({ tag: '口语化', score: 0.5, count: 1 });
    });

    it('空字符串返回空指纹', () => {
      const fp = readFingerprint('');
      expect(fp).toEqual(emptyFingerprint());
    });

    it('非法 JSON 返回空指纹', () => {
      const fp = readFingerprint('not json at all');
      expect(fp).toEqual(emptyFingerprint());
    });

    it('缺少字段补为空数组', () => {
      const fp = readFingerprint(JSON.stringify({ voice: [{ tag: 'a', score: 0.5, count: 1 }] }));
      expect(fp.format).toEqual([]);
      expect(fp.topic).toEqual([]);
    });
  });

  describe('mergeLayer', () => {
    it('新标签直接加入', () => {
      const existing: FingerprintItem[] = [{ tag: 'A', score: 0.6, count: 2 }];
      const incoming: FingerprintItem[] = [{ tag: 'B', score: 0.5, count: 1 }];
      const result = mergeLayer(existing, incoming);
      expect(result).toHaveLength(2);
      expect(result.find((x) => x.tag === 'B')).toEqual({ tag: 'B', score: 0.5, count: 1 });
    });

    it('重复标签累计 count 并增加 score', () => {
      const existing: FingerprintItem[] = [{ tag: 'A', score: 0.6, count: 2 }];
      const incoming: FingerprintItem[] = [{ tag: 'A', score: 0.5, count: 1 }];
      const result = mergeLayer(existing, incoming);
      expect(result).toHaveLength(1);
      expect(result[0].count).toBe(3);
      expect(result[0].score).toBe(0.7);
    });

    it('score 上限为 1', () => {
      const existing: FingerprintItem[] = [{ tag: 'A', score: 0.95, count: 10 }];
      const incoming: FingerprintItem[] = [{ tag: 'A', score: 0.5, count: 1 }];
      const result = mergeLayer(existing, incoming);
      expect(result[0].score).toBe(1);
    });

    it('最多保留 12 条，按 score 排序裁剪', () => {
      const existing: FingerprintItem[] = Array.from({ length: 12 }, (_, i) => ({
        tag: `tag${i}`,
        score: 0.5,
        count: 1,
      }));
      const incoming: FingerprintItem[] = [{ tag: 'new', score: 0.9, count: 5 }];
      const result = mergeLayer(existing, incoming);
      expect(result).toHaveLength(12);
      expect(result[0].tag).toBe('new');
    });

    it('空 incoming 返回 existing 原样', () => {
      const existing: FingerprintItem[] = [{ tag: 'X', score: 0.7, count: 3 }];
      const result = mergeLayer(existing, []);
      expect(result).toEqual(existing);
    });
  });

  describe('toFingerprintJson', () => {
    it('序列化为 JSON 字符串', () => {
      const fp: StyleFingerprint = {
        voice: [{ tag: '幽默', score: 0.8, count: 2 }],
        format: [],
        topic: [{ tag: '科技', score: 0.6, count: 1 }],
      };
      const json = toFingerprintJson(fp);
      const parsed = JSON.parse(json);
      expect(parsed.voice[0].tag).toBe('幽默');
      expect(parsed.topic[0].tag).toBe('科技');
    });
  });

  describe('fingerprintPromptBlock', () => {
    it('空指纹返回空字符串', () => {
      expect(fingerprintPromptBlock(emptyFingerprint())).toBe('');
    });

    it('有内容时返回格式化字符串', () => {
      const fp: StyleFingerprint = {
        voice: [{ tag: '犀利', score: 0.8, count: 3 }],
        format: [{ tag: '列表体', score: 0.6, count: 2 }],
        topic: [{ tag: '职场', score: 0.7, count: 1 }],
      };
      const block = fingerprintPromptBlock(fp);
      expect(block).toContain('【风格指纹】');
      expect(block).toContain('犀利(80%)');
      expect(block).toContain('列表体(60%)');
      expect(block).toContain('职场');
    });

    it('部分层为空只输出有内容的层', () => {
      const fp: StyleFingerprint = {
        voice: [{ tag: '温暖', score: 0.9, count: 5 }],
        format: [],
        topic: [],
      };
      const block = fingerprintPromptBlock(fp);
      expect(block).toContain('语气风格');
      expect(block).not.toContain('结构偏好');
      expect(block).not.toContain('擅长选题');
    });
  });
});
