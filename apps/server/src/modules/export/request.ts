import { z } from 'zod';
import { LocalDate, UtcOffsetMinutes } from '../review/common.ts';

/** `POST /v1/exports/pdf` body (docs/api-v1.md, "v3 → PDF export"). */

export const EXPORT_MATERIAL_KINDS = ['daily', 'digest', 'extend'] as const;
export type ExportMaterialKind = (typeof EXPORT_MATERIAL_KINDS)[number];
export const MAX_EXPORT_MATERIALS = 8;

const MaterialRef = z.object({ kind: z.enum(EXPORT_MATERIAL_KINDS), date: LocalDate });
export type MaterialRef = z.infer<typeof MaterialRef>;

export const PdfExportBody = z
  .object({
    scope: z.enum(['material', 'cards', 'checklist']),
    materials: z.array(MaterialRef).min(1).max(MAX_EXPORT_MATERIALS).optional(),
    layout: z.enum(['read', 'practice']).default('practice'),
    ipa: z.boolean().default(true),
    large: z.boolean().default(false),
    /** "Local day" rule: today, for file names and the checklist without materials. */
    utcOffsetMinutes: UtcOffsetMinutes,
  })
  .superRefine((body, ctx) => {
    if (body.scope !== 'checklist' && body.materials === undefined) {
      ctx.addIssue({ code: 'custom', path: ['materials'], message: `required for scope ${body.scope}` });
    }
    const keys = (body.materials ?? []).map((ref) => `${ref.kind}:${ref.date}`);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({ code: 'custom', path: ['materials'], message: 'materials must not repeat' });
    }
  });
export type PdfExportRequest = z.infer<typeof PdfExportBody>;
