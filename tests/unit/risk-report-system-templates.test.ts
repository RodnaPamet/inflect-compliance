/**
 * A stock risk-report template reads in the reader's language; a tenant's
 * own reads as written (#5924).
 *
 * The three system templates are seeded as rows with English names, and both
 * report pages showed the stored English on a Bulgarian page ("Portfolio Risk
 * Summary", "Risk Deep Dive"). The name is the product's words while the row
 * is still the stock template, and the tenant's once it is not.
 */
import {
    SYSTEM_REPORT_TEMPLATES,
    reportTemplateText,
    stockSystemTemplate,
} from '@/lib/risk-report/system-templates';

const EN = jest.requireActual('../../messages/en.json') as { riskReportTemplates: Record<string, { name: string; description: string }> };
const BG = jest.requireActual('../../messages/bg.json') as { riskReportTemplates: Record<string, { name: string; description: string }> };

const translatorFor = (catalog: typeof BG) => (key: string) => {
    const [type, field] = key.split('.') as [string, 'name' | 'description'];
    const v = catalog.riskReportTemplates[type]?.[field];
    if (typeof v !== 'string') throw new Error(`missing message: riskReportTemplates.${key}`);
    return v;
};
const tBg = translatorFor(BG);

describe('system report template names', () => {
    it.each(SYSTEM_REPORT_TEMPLATES.map((s) => [s.type, s] as const))(
        '%s reads in Bulgarian, name and description, while it is the stock row',
        (_type, stock) => {
            const text = reportTemplateText({ ...stock, isSystem: true }, tBg);
            expect(text.name).toBe(BG.riskReportTemplates[stock.type].name);
            expect(text.description).toBe(BG.riskReportTemplates[stock.type].description);
            expect(text.name).toMatch(/[Ѐ-ӿ]/);
        },
    );

    it('the English catalog says what the seeded row says, word for word', () => {
        for (const s of SYSTEM_REPORT_TEMPLATES) {
            expect(EN.riskReportTemplates[s.type]).toEqual({ name: s.name, description: s.description });
        }
    });

    it('a tenant’s own template is shown as written, even with a stock type', () => {
        const own = { name: 'Board pack Q3', type: 'PORTFOLIO_SUMMARY', description: 'For the board.', isSystem: false };
        expect(stockSystemTemplate(own)).toBeNull();
        expect(reportTemplateText(own, tBg)).toEqual({ name: 'Board pack Q3', description: 'For the board.' });
    });

    it('a system row whose name is no longer the stock one is shown as written', () => {
        const renamed = { name: 'Portfolio summary (board)', type: 'PORTFOLIO_SUMMARY', description: null, isSystem: true };
        expect(reportTemplateText(renamed, tBg)).toEqual({ name: 'Portfolio summary (board)', description: null });
    });

    it('a stock row with a changed description keeps the translated name and the written description', () => {
        const stock = SYSTEM_REPORT_TEMPLATES[1];
        const text = reportTemplateText({ ...stock, description: 'Our own words.', isSystem: true }, tBg);
        expect(text).toEqual({ name: BG.riskReportTemplates[stock.type].name, description: 'Our own words.' });
    });
});
