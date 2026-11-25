import type { ExportScope } from './document.ts';
import { mmdd } from './format.ts';

/**
 * File names (docs/api-v1.md, "v3 → PDF export"): 学习资料_MMDD.pdf,
 * 学习资料合集_MMDD-MMDD.pdf, 单词卡_MMDD.pdf, 自测清单_MMDD.pdf — dates of
 * the materials (a range when they span several days), or today.
 */
export function exportFileName(scope: ExportScope, materialDates: readonly string[], today: string): string {
  const dates = [...new Set(materialDates)].sort();
  const first = dates[0] ?? today;
  const last = dates[dates.length - 1] ?? today;
  if (scope === 'material' && materialDates.length > 1) return `学习资料合集_${mmdd(first)}-${mmdd(last)}.pdf`;
  const prefix = scope === 'material' ? '学习资料' : scope === 'cards' ? '单词卡' : '自测清单';
  return first === last ? `${prefix}_${mmdd(first)}.pdf` : `${prefix}_${mmdd(first)}-${mmdd(last)}.pdf`;
}

/** RFC 5987 / RFC 6266: `attachment; filename*=UTF-8''<percent-encoded name>`. */
export function contentDisposition(fileName: string): string {
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename*=UTF-8''${encoded}`;
}
