import { describe, expect, it } from 'vitest';
import { extractPdfLinks } from './bulletin-ingest.js';

describe('extractPdfLinks', () => {
  const INDEX = 'https://pubfiles.pagasa.dost.gov.ph/tamss/weather/bulletin/';

  it('finds absolute bulletin PDF links', () => {
    const html =
      '<a href="https://pubfiles.pagasa.dost.gov.ph/tamss/weather/bulletin_nando.pdf">pdf</a>';
    expect(extractPdfLinks(html, INDEX)).toEqual([
      'https://pubfiles.pagasa.dost.gov.ph/tamss/weather/bulletin_nando.pdf',
    ]);
  });

  it('resolves relative links against the index URL and dedupes', () => {
    const html = `
      <a href="TCB%2310_inday.pdf">x</a>
      <a href='bulletin_emong.pdf'>y</a>
      <a href="bulletin_emong.pdf">y again</a>
      <a href="unrelated.pdf">not a bulletin</a>`;
    const links = extractPdfLinks(html, INDEX);
    expect(links).toContain(`${INDEX}TCB%2310_inday.pdf`);
    expect(links).toContain(`${INDEX}bulletin_emong.pdf`);
    expect(links).toHaveLength(2);
  });

  it('returns empty for pages without bulletin PDFs', () => {
    expect(extractPdfLinks('<p>No Active Tropical Cyclone</p>', INDEX)).toEqual([]);
  });
});
