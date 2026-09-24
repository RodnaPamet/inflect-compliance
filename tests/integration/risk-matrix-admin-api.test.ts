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

// THE RAW SEAM IS GONE, AND ITS PREMISE WAS WRONG (#2246, final batch).
//
// It read: "one assertion below checks that the registry DOCUMENTS the
// read-only sibling; its subject is the note itself, so masking comments would
// blank exactly what it verifies." Measured against `route-permissions.ts`,
// that is false in BOTH halves:
//
//   · The `note:` field the sentence means is a STRING LITERAL, and `codeOf`
//     KEEPS string literals. `'Read-only sibling'` counts 1 through the masked
//     reader and 0 through `commentsOf`. It never needed a raw read at all.
//   · `'Risk matrix configuration'` does not occur in the note. Its single
//     occurrence in the file is the decorative section divider
//     `// ── Risk matrix configuration (Epic 44) ──`, so the assertion that
//     claimed the registry documents the sibling was half satisfied by a
//     comment banner — exactly the Class A defect. Binding that needle to the
//     masked reader took it to ZERO and turned this suite RED, which is how it
//     was found.
//
// Both assertions now read `permsSrc` and name text that is actually IN the
// note, so deleting or hollowing the note is what breaks them. The divider is
// free to be renamed or dropped, because it never carried the claim.

describe('Admin risk-matrix-config API — wiring', () => {
    const routeSrc = read(
        'src/app/api/t/[tenantSlug]/admin/risk-matrix-config/route.ts',
    );
    const permsSrc = read('src/lib/security/route-permissions.ts');
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
        // future audits don't tighten the wrong path. Both needles are drawn
        // from the `note:` STRING, which `codeOf` keeps — the previous pair
        // read the whole file raw and one of them matched only the `// ── Risk
        // matrix configuration ──` divider above the rule, not the note.
        expect(permsSrc).toContain('likelihood × impact matrix shape');
        expect(permsSrc).toContain(
            'Read-only sibling at /risk-matrix-config (risks.view).',
        );
    });
});
