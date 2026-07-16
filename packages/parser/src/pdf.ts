import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { TextItem } from 'pdfjs-dist/types/src/display/api.js';
import { parseBulletinPdfText, type PdfTextParseResult } from './pdf-text.js';

/**
 * Extract a line-oriented text layer from a PDF using pdfjs.
 * Items are grouped into lines by their y coordinate (2pt tolerance) and
 * ordered left-to-right, which reconstructs PAGASA's single-column layout well.
 */
export async function extractPdfText(data: Uint8Array): Promise<string> {
  const doc = await getDocument({ data, useSystemFonts: true }).promise;
  try {
    const pages: string[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      interface Line {
        y: number;
        parts: Array<{ x: number; str: string }>;
      }
      const lines: Line[] = [];
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const t: TextItem = item;
        if (t.str.trim().length === 0) continue;
        const x = t.transform[4] as number;
        const y = t.transform[5] as number;
        const line = lines.find((l) => Math.abs(l.y - y) <= 2);
        if (line) {
          line.parts.push({ x, str: t.str });
          line.y = (line.y + y) / 2;
        } else {
          lines.push({ y, parts: [{ x, str: t.str }] });
        }
      }
      lines.sort((a, b) => b.y - a.y); // PDF y grows upward
      const text = lines
        .map((l) =>
          l.parts
            .sort((a, b) => a.x - b.x)
            .map((part) => part.str)
            .join(' '),
        )
        .join('\n');
      pages.push(text);
    }
    return pages.join('\n\f\n');
  } finally {
    await doc.destroy();
  }
}

/** Parse a PAGASA TCB PDF end to end (extraction + text parsing + validation). */
export async function parseBulletinPdf(
  data: Uint8Array,
  sourceUrl = '',
): Promise<PdfTextParseResult> {
  const text = await extractPdfText(data);
  return parseBulletinPdfText(text, sourceUrl);
}
