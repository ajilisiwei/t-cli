/**
 * Page count of a PDF produced by Typst: Typst writes its object
 * dictionaries uncompressed (only content and font streams are deflated,
 * no object streams), so each page is exactly one `/Type /Page` dictionary.
 * Null when the bytes are not a PDF or hold no page.
 */
const PAGE_RE = /\/Type\s*\/Page(?![A-Za-z0-9])/g;

export function countPdfPages(pdf: Uint8Array): number | null {
  // latin1 maps every byte to one char, so binary streams cannot break the scan.
  const text = Buffer.from(pdf.buffer, pdf.byteOffset, pdf.byteLength).toString('latin1');
  if (!text.startsWith('%PDF-')) return null;
  const pages = text.match(PAGE_RE)?.length ?? 0;
  return pages > 0 ? pages : null;
}
