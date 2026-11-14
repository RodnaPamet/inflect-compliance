/**
 * The policy PDF's table of contents continues onto a new page instead of
 * writing past the footer (#5316).
 *
 * `addPolicyToc` wrote every row at the running cursor with no page check, so a
 * template with more than about nineteen headings (H2 sections plus H3
 * sub-parts) drew its later rows over the footer and off the page.
 */
import { addPolicyToc } from '@/lib/pdf/policyLayout';
import { createPdfDocument } from '@/lib/pdf/pdfKitFactory';
import { SAFE_BOTTOM_Y } from '@/lib/pdf/layout';

describe('addPolicyToc pagination', () => {
    it('keeps every row above the footer and spreads a long TOC over several pages', () => {
        const doc = createPdfDocument({
            tenantName: 'Acme Corp',
            reportTitle: 'Information Security Policy',
            generatedAt: '2026-05-24T12:00:00Z',
        });
        const before = doc.bufferedPageRange().count;

        const rows: Array<{ y: number; page: number }> = [];
        const realText = doc.text.bind(doc);
        jest.spyOn(doc, 'text').mockImplementation(((...args: unknown[]) => {
            const [text, , y] = args as [string, number, number];
            if (typeof text === 'string' && /^\d+\. /.test(text)) {
                rows.push({ y, page: doc.bufferedPageRange().count });
            }
            return (realText as (...a: unknown[]) => PDFKit.PDFDocument)(...args);
        }) as typeof doc.text);

        const entries = Array.from({ length: 60 }, (_, i) => ({
            title: `Section ${i + 1}`,
            destName: `s${i}`,
        }));
        addPolicyToc(doc, entries);

        expect(rows).toHaveLength(60);
        for (const r of rows) {
            // A row needs ~30pt (text + underline); it must fit above the footer.
            expect(r.y + 30).toBeLessThanOrEqual(SAFE_BOTTOM_Y);
        }
        const tocPages = new Set(rows.map((r) => r.page));
        expect(tocPages.size).toBeGreaterThan(1);
        // TOC pages plus the trailing page the body starts on.
        expect(doc.bufferedPageRange().count - before).toBe(tocPages.size);
        doc.end();
    });
});
