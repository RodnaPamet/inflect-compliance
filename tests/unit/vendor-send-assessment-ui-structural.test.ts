/**
 * Epic G-3 — structural wiring check for the vendor detail page's
 * "Send to vendor" assessment flow.
 *
 * A light static-analysis guard (no React render): asserts the page
 * wires the G-3 send flow end-to-end as the SINGLE assessment-creation
 * path (the legacy in-app "Start" flow was retired). Complements the
 * route handler's behavioural test (`vendor-assessment-send-route.test.ts`).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM. Reads whose result
// is JSON.parse'd are left RAW on purpose: a catalogue is parsed as DATA, never
// matched as text, so masking it would only corrupt the parse.
import { codeOf } from '../helpers/source-blocks';

const PAGE = path.resolve(
    __dirname,
    '../../src/app/t/[tenantSlug]/(app)/vendors/[vendorId]/page.tsx',
);

describe('vendor detail — G-3 send-assessment wiring', () => {
    const src = codeOf(fs.readFileSync(PAGE, 'utf8'));

    it('POSTs to the G-3 send route', () => {
        expect(src).toContain('/assessments/send');
    });

    it('fetches PUBLISHED G-3 templates from the vendor-assessment-templates endpoint', () => {
        expect(src).toContain('/vendor-assessment-templates');
        expect(src).toMatch(/filter\(\(t\)\s*=>\s*t\.isPublished\)/);
    });

    it('renders the Send-to-vendor trigger + modal confirm', () => {
        expect(src).toContain('send-assessment-btn');
        expect(src).toContain('confirm-send-assessment');
        // "Send assessment" label migrated to next-intl; resolve against en.json
        expect(src).toMatch(/tx\('detail\.sendAssessment'\)/);
        const en = JSON.parse(
            fs.readFileSync(path.resolve(__dirname, '../../messages/en.json'), 'utf8'),
        ) as { vendors: { detail: Record<string, string> } };
        expect(en.vendors.detail.sendAssessment).toBe('Send assessment');
    });

    it('uses the platform Modal / FormField / Combobox / CopyText primitives', () => {
        expect(src).toContain("from '@/components/ui/modal'");
        expect(src).toContain("from '@/components/ui/form-field'");
        expect(src).toContain("from '@/components/ui/copy-text'");
        expect(src).toContain('<Modal');
        expect(src).toContain('<CopyText');
    });

    it('reveals the raw access link after a successful send', () => {
        expect(src).toContain('send-assessment-link');
        expect(src).toContain('/vendor-assessment/');
    });

    it('retires the legacy in-app start flow (single send-to-vendor path)', () => {
        // The legacy QuestionnaireTemplate in-app "Start" flow never surfaced
        // the tenant's own VendorAssessmentTemplates, so it was removed in
        // favour of the unified G-3 send flow.
        expect(src).not.toContain('/assessments/start');
        expect(src).not.toContain('start-assessment-btn');
        expect(src).not.toContain('templateKey');
    });
});
