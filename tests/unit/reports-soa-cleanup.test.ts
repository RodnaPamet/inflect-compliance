/**
 * PR-V — SoA surface cleanup invariants (structural).
 *
 * The Statement of Applicability is an ISO-27001 Annex-A artifact. After the
 * reports-hub redesign the standalone `/reports/soa` surface (page + print)
 * must (a) honor the framework the user selected on the hub and (b) refuse to
 * render for a non-ISO framework. These source-level assertions lock those
 * invariants — the repo tests server pages structurally rather than by
 * executing the async server component.
 */
import * as fs from 'fs';
import * as path from 'path';
import { CONTROL_STATUS_VARIANT } from '@/app-layer/domain/entity-status-mapping';

const APP = path.resolve(__dirname, '../../src/app/t/[tenantSlug]/(app)');
const read = (p: string) => fs.readFileSync(path.join(APP, p), 'utf-8');

describe('SoA page — ISO-only guard + framework threading', () => {
    const page = read('reports/soa/page.tsx');
    const printPage = read('reports/soa/print/page.tsx');

    test.each([
        ['reports/soa/page.tsx', () => page],
        ['reports/soa/print/page.tsx', () => printPage],
    ])('%s reads ?framework, threads it to getSoA, and redirects non-ISO', (_name, get) => {
        const src = get();
        // reads the framework search param
        expect(src).toMatch(/searchParams/);
        expect(src).toMatch(/const\s*\{\s*framework\s*\}\s*=\s*await\s+searchParams/);
        // threads it into getSoA
        expect(src).toMatch(/getSoA\(\s*ctx\s*,\s*\{[\s\S]*framework[\s\S]*\}/);
        // redirects a non-ISO framework away from the SoA surface
        expect(src).toMatch(/from 'next\/navigation'/);
        expect(src).toMatch(/if\s*\(\s*!report\.isIsoFamily\s*\)/);
        expect(src).toMatch(/redirect\(`\/t\/\$\{tenantSlug\}\/reports`\)/);
    });
});

describe('Reports hub — Open SoA honors the selected framework', () => {
    const client = read('reports/ReportsClient.tsx');

    test('Open SoA link forwards ?framework=<selectedKey>', () => {
        expect(client).toMatch(/reports\/soa\?framework=\$\{encodeURIComponent\(selectedKey\)\}/);
    });

    test('readiness KPI tile renders a /100 denominator, not a bare integer', () => {
        expect(client).toMatch(/value=\{`\$\{s\.readinessScore\}\/100`\}/);
    });
});

describe('SoAClient — Print affordance + full status map', () => {
    const client = read('reports/soa/SoAClient.tsx');

    test('Print link forwards the framework to the print view', () => {
        expect(client).toMatch(/reports\/soa\/print\?framework=\$\{encodeURIComponent\(report\.framework\)\}/);
    });

    /**
     * This used to assert that the literals `PLANNED:` and `IMPLEMENTING:`
     * appeared in SoAClient's source — key PRESENCE in raw text.
     *
     * It could not see the defect it was named for. The file carried TWO
     * status rules: the map it checked, and a binary
     * `status === 'IMPLEMENTED' ? 'success' : 'neutral'` in the map-control
     * picker, which rendered NEEDS_REVIEW grey where the table rendered it
     * amber. Presence of a key says nothing about the VALUE, and nothing at
     * all about a second rule elsewhere in the file.
     *
     * Worse, it actively blocked the fix: deleting the inline map in favour
     * of the shared one removed the only `PLANNED:` in the file, so the
     * correct change turned this red.
     *
     * The invariant is that SoA reads the SHARED map and does not fork its
     * own — asserted against the map's real contents, not its spelling.
     */
    test('SoA reads the shared control-status map rather than forking one', () => {
        expect(client).toMatch(/CONTROL_STATUS_VARIANT/);
        // No private status→variant literal left in the file.
        expect(client).not.toMatch(/IMPLEMENTED:\s*'success'/);
        // And no second, inline rule for the same field.
        expect(client).not.toMatch(/status === 'IMPLEMENTED' \? 'success'/);
    });

    test('the shared map covers every ControlStatus the SoA can render', () => {
        // PLANNED and IMPLEMENTING are the two this file historically cared
        // about; they are only meaningful if the shared map actually defines
        // them, which it did not until the copies were consolidated.
        for (const status of [
            'NOT_STARTED', 'PLANNED', 'IN_PROGRESS', 'IMPLEMENTING',
            'IMPLEMENTED', 'NEEDS_REVIEW', 'NOT_APPLICABLE',
        ]) {
            expect(CONTROL_STATUS_VARIANT[status]).toBeDefined();
        }
    });
});

describe('Dead report API surface removed', () => {
    const apiRoot = path.resolve(__dirname, '../../src/app/api');
    const report = fs.readFileSync(
        path.resolve(__dirname, '../../src/app-layer/usecases/report.ts'),
        'utf-8',
    );

    test('orphaned GET routes are deleted', () => {
        expect(fs.existsSync(path.join(apiRoot, 't/[tenantSlug]/reports/route.ts'))).toBe(false);
        expect(fs.existsSync(path.join(apiRoot, 'reports/route.ts'))).toBe(false);
    });

    test('getReports no longer computes an SoA array', () => {
        expect(report).not.toMatch(/getSOAData/);
        // the `const soa = controls.map(...)` computation is gone (a doc
        // comment may still mention the word "soa" to explain the removal)
        expect(report).not.toMatch(/const\s+soa\s*=/);
        expect(report).toMatch(/return\s*\{\s*riskRegister\s*\}/);
    });
});
