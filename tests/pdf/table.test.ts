/**
 * PDF Table Helper — Unit Tests
 */
import { autoColumnWidths, renderTable } from '@/lib/pdf/table';
import { CONTENT_WIDTH, createPdfDocument } from '@/lib/pdf/pdfKitFactory';
import { SAFE_BOTTOM_Y } from '@/lib/pdf/layout';

describe('autoColumnWidths', () => {
    it('distributes widths proportionally', () => {
        const widths = autoColumnWidths([1, 1, 1]);
        expect(widths).toHaveLength(3);
        // Each should be roughly 1/3 of content width
        const third = CONTENT_WIDTH / 3;
        for (const w of widths) {
            expect(w).toBeCloseTo(third, 1);
        }
    });

    it('sums to CONTENT_WIDTH', () => {
        const widths = autoColumnWidths([2, 3, 1, 4]);
        const total = widths.reduce((s, w) => s + w, 0);
        expect(total).toBeCloseTo(CONTENT_WIDTH, 1);
    });

    it('respects relative weights', () => {
        const widths = autoColumnWidths([1, 3]);
        // First column should be ~25%, second ~75%
        expect(widths[1]).toBeCloseTo(widths[0] * 3, 1);
    });

    it('handles single column', () => {
        const widths = autoColumnWidths([1]);
        expect(widths[0]).toBeCloseTo(CONTENT_WIDTH, 1);
    });
});

describe('renderTable — a cell never draws past its row (#5316)', () => {
    it('clips a cell longer than the row cap instead of overprinting the rows below', () => {
        const doc = createPdfDocument({
            tenantName: 'Acme Corp',
            reportTitle: 'Access review',
            generatedAt: '2026-05-24T12:00:00Z',
        });
        const columns = [
            { key: 'who', header: 'Who', width: 120 },
            { key: 'notes', header: 'Notes', width: 88 },
            { key: 'decision', header: 'Decision', width: CONTENT_WIDTH - 208 },
        ];
        const longNote = 'The reviewer recorded a long justification. '.repeat(120);
        const rows = [
            { who: 'alice', notes: 'short', decision: 'KEEP' },
            { who: 'bob', notes: longNote, decision: 'REVOKE' },
            { who: 'carol', notes: 'short', decision: 'KEEP' },
            { who: 'dave', notes: 'short', decision: 'KEEP' },
        ];

        const calls: Array<{ text: string; y: number; yAfter: number; pageBefore: number; pageAfter: number }> = [];
        const realText = doc.text.bind(doc);
        jest.spyOn(doc, 'text').mockImplementation(((...args: unknown[]) => {
            const [text, , y] = args as [string, number, number];
            const pageBefore = doc.bufferedPageRange().count;
            const out = (realText as (...a: unknown[]) => PDFKit.PDFDocument)(...args);
            calls.push({ text, y, yAfter: doc.y, pageBefore, pageAfter: doc.bufferedPageRange().count });
            return out;
        }) as typeof doc.text);

        renderTable(doc, columns, rows);

        const cells = calls.filter((c) => !['Who', 'Notes', 'Decision'].includes(c.text));
        for (const c of cells) {
            // PDFKit never paginates inside a cell, and no cell ends below the footer.
            expect(c.pageAfter).toBe(c.pageBefore);
            expect(c.yAfter).toBeLessThanOrEqual(SAFE_BOTTOM_Y);
        }
        // The long note ends above where the next row is drawn on its page.
        const note = cells.find((c) => c.text === longNote)!;
        const carol = cells.find((c) => c.text === 'carol')!;
        if (carol.pageBefore === note.pageBefore) {
            expect(note.yAfter).toBeLessThanOrEqual(carol.y);
        }
        doc.end();
    });
});
