/** SP-F3 — .docx detection + DOCX→sanitised-HTML conversion. */
jest.mock('mammoth', () => ({
    __esModule: true,
    default: { convertToHtml: jest.fn(async () => ({ value: '<h1>Policy</h1><script>alert(1)</script>', messages: [] })) },
}));

import { isDocxItem, docxToPolicyHtml } from '@/app-layer/integrations/providers/sharepoint/docx';

describe('isDocxItem', () => {
    it('detects by .docx name', () => {
        expect(isDocxItem('Policy.docx')).toBe(true);
        expect(isDocxItem('POLICY.DOCX')).toBe(true);
        expect(isDocxItem('notes.md')).toBe(false);
        expect(isDocxItem(undefined)).toBe(false);
    });
    it('detects by Word mime type', () => {
        expect(isDocxItem(undefined, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(true);
        expect(isDocxItem(undefined, 'application/pdf')).toBe(false);
    });
});

describe('docxToPolicyHtml', () => {
    it('converts via mammoth and sanitises the result (strips <script>)', async () => {
        const html = await docxToPolicyHtml(Buffer.from('PK...docx-bytes'));
        expect(html).toContain('<h1>Policy</h1>');
        expect(html).not.toContain('<script>');
    });
});
