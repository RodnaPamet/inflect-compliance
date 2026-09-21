/**
 * Guard test: Coverage Dashboard infrastructure exists.
 *
 * Ensures the page, client component, and API route are present
 * so the Assets → Coverage button never leads to a 404.
 */
import * as fs from 'fs';
import * as path from 'path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// EVERY read here is wrapped because every path this file reads is a
// TypeScript-alike — re-derived per file, not assumed from the directory — so
// there is no second language needing its own reader. String literals are KEPT.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');

describe('coverage-page-guard', () => {
    const expectedFiles = [
        'src/app/t/[tenantSlug]/(app)/coverage/page.tsx',
        'src/app/t/[tenantSlug]/(app)/coverage/CoverageClient.tsx',
        'src/app/t/[tenantSlug]/(app)/coverage/loading.tsx',
        'src/app/api/t/[tenantSlug]/coverage/route.ts',
    ];

    for (const file of expectedFiles) {
        it(`${path.basename(file)} exists`, () => {
            const full = path.join(ROOT, file);
            expect(fs.existsSync(full)).toBe(true);
        });
    }

    it('page.tsx imports coverageSummary from traceability', () => {
        const content = codeOf(fs.readFileSync(
            path.join(ROOT, 'src/app/t/[tenantSlug]/(app)/coverage/page.tsx'),
            'utf8',
        ));
        expect(content).toContain('coverageSummary');
        expect(content).toContain('CoverageClient');
    });

    it('API route imports coverageSummary from traceability', () => {
        const content = codeOf(fs.readFileSync(
            path.join(ROOT, 'src/app/api/t/[tenantSlug]/coverage/route.ts'),
            'utf8',
        ));
        expect(content).toContain('coverageSummary');
        expect(content).toContain('withApiErrorHandling');
    });

    it('CoverageClient uses DataTable for gap tables', () => {
        const content = codeOf(fs.readFileSync(
            path.join(ROOT, 'src/app/t/[tenantSlug]/(app)/coverage/CoverageClient.tsx'),
            'utf8',
        ));
        expect(content).toContain('DataTable');
        expect(content).toContain('DonutChart');
        expect(content).toContain('uncovered-assets-section');
        expect(content).toContain('unmapped-risks-section');
    });

    it('AssetsClient still links to /coverage', () => {
        const content = codeOf(fs.readFileSync(
            path.join(ROOT, 'src/app/t/[tenantSlug]/(app)/assets/AssetsClient.tsx'),
            'utf8',
        ));
        expect(content).toContain("'/coverage'");
    });
});
