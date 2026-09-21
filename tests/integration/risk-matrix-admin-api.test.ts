/**
 * Admin API contract tests for the risk-matrix configuration —
 * Epic 44.5
 *
 * Proves the route path the admin editor calls (`PUT /api/t/:slug/
 * admin/risk-matrix-config`) is gated by the canonical
 * `requirePermission('admin.manage')` rule. The usecase-level
 * validation + persistence flow is already covered by
 * `tests/integration/risk-matrix-config.test.ts`; this file
 * narrowly tests the surface the admin UI hits.
 */

import * as fs from 'node:fs';
import path from 'node:path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// String literals are KEPT, so assertions that harvest codes or ids from source
// still see them. Every path this file reads is a TypeScript-alike, re-derived
// per file rather than assumed from the directory.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
function read(rel: string): string {
    return codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf-8'));
}

// The DELIBERATE raw seam (#2246): one assertion below checks that the registry
// DOCUMENTS the read-only sibling. Its subject is the note itself, so masking
// comments would blank exactly what it verifies.
function readDoc(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

describe('Admin risk-matrix-config API — wiring', () => {
    const routeSrc = read(
        'src/app/api/t/[tenantSlug]/admin/risk-matrix-config/route.ts',
    );
    const permsSrc = read('src/lib/security/route-permissions.ts');
    // RAW twin for the one assertion whose subject is the NOTE, not the code.
    const permsDoc = readDoc('src/lib/security/route-permissions.ts');
    const pageSrc = read(
        'src/app/t/[tenantSlug]/(app)/admin/risk-matrix/page.tsx',
    );

    it('PUT route enforces admin.manage permission', () => {
        expect(routeSrc).toMatch(/requirePermission\(['"]admin\.manage['"]/);
        expect(routeSrc).toMatch(/export const PUT/);
    });

    it('route-permissions registry carries the admin/risk-matrix-config rule', () => {
        // `tests/guards/route-permission-coverage.test.ts` enforces
        // that every admin route in src/app/api/**/admin has a rule;
        // this assertion mirrors the rule shape so a future "tidy
        // up" can't drop the rule + leave the route unguarded.
        // (Source uses double-backslash escapes; we look for the
        // literal substring instead of regex to keep the assertion
        // robust to escape-form drift.)
        const idx = permsSrc.indexOf('risk-matrix-config');
        expect(idx).toBeGreaterThan(0);
        const window = permsSrc.slice(idx, idx + 600);
        expect(window).toContain("'admin.manage'");
    });

    it('admin page server-fetches the effective config (no client round-trip on first paint)', () => {
        expect(pageSrc).toContain('getRiskMatrixConfig');
        expect(pageSrc).toContain('initialConfig={initialConfig}');
    });

    it('admin route also exposes a GET twin for the editor convenience read', () => {
        expect(routeSrc).toMatch(/export const GET/);
        // The same admin.manage gate protects both methods; the
        // matrix shape isn't sensitive on its own, but the admin
        // surface is namespaced consistently.
        expect(
            (routeSrc.match(/requirePermission\(['"]admin\.manage['"]/g) ?? [])
                .length,
        ).toBeGreaterThanOrEqual(2);
    });

    it('route-permissions documents the read-only sibling at /risk-matrix-config (risks.view)', () => {
        // The note explicitly calls out the read-only sibling so
        // future audits don't tighten the wrong path.
        expect(permsDoc).toContain('Risk matrix configuration');
        expect(permsDoc).toContain('Read-only sibling');
    });
});
