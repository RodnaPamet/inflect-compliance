/**
 * Bulk and soft-delete-lifecycle routes gate at the C.1 layer, so denials
 * are recorded.
 *
 * `AUTHZ_DENIED` is written by ONE place: `requirePermission` in
 * `src/lib/security/permission-middleware.ts`. A usecase-layer
 * `assertCanAdmin` throw produces a 403 and no audit row at all.
 *
 * That gives two distinct ways for a denial to go unrecorded, and this repo
 * had both:
 *
 *   1. NO route gate. Eleven Controls/Risks bulk + purge/restore routes ran
 *      bare `withApiErrorHandling` while their Assets equivalents used
 *      `requirePermission`. Authorization was still correct — every usecase
 *      asserts — but a denied bulk-delete or purge left no security-event
 *      trail, while the identical action on Assets did.
 *
 *   2. A gate DECLARED WEAKER than the usecase asserts. `deleteRisk`,
 *      `deleteTask`, `deleteAsset` and `bulkDeleteAsset` all assert
 *      `assertCanAdmin`, but their routes declared `.edit` keys, which are
 *      true for EDITOR. An EDITOR passed the middleware and was refused by
 *      the usecase — so the exact denial the gate exists to log was the one
 *      it could not see. This is the more dangerous of the two: the route
 *      LOOKS gated.
 *
 * Hence the rule asserted here: a destructive route's declared key must be
 * at the ADMIN tier when the usecase behind it asserts `assertCanAdmin`. A
 * key weaker than the assert is not a lenient gate, it is an unlogged one.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const API_ROOT = path.resolve(__dirname, '../../src/app/api/t/[tenantSlug]');
const read = (rel: string) => fs.readFileSync(path.join(API_ROOT, rel), 'utf8');
const codeOnly = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** route → the key it must declare, chosen to match the usecase's assert. */
const GATED: Record<string, string> = {
    // assertCanAdmin — deleting is an ADMIN verb throughout the codebase.
    'controls/bulk/delete/route.ts': 'admin.manage',
    'risks/bulk/delete/route.ts': 'admin.manage',
    'assets/bulk/delete/route.ts': 'admin.manage',
    // assertCanAdmin via purgeEntity / restoreEntity.
    'controls/[controlId]/purge/route.ts': 'admin.manage',
    'controls/[controlId]/restore/route.ts': 'admin.manage',
    'risks/[id]/purge/route.ts': 'admin.manage',
    'risks/[id]/restore/route.ts': 'admin.manage',
    // assertCanUpdateControl / assertCanWrite — genuinely EDITOR-tier.
    'controls/bulk/status/route.ts': 'controls.edit',
    'controls/bulk/assign/route.ts': 'controls.edit',
    'risks/bulk/status/route.ts': 'risks.edit',
    'risks/bulk/assign/route.ts': 'risks.edit',
    'risks/bulk/import/route.ts': 'risks.create',
    'assets/bulk/status/route.ts': 'assets.edit',
    'assets/bulk/assign/route.ts': 'assets.edit',
    'assets/bulk/import/route.ts': 'assets.create',
};

describe('bulk + lifecycle routes gate at the permission layer', () => {
    it.each(Object.entries(GATED))('%s declares %s', (rel, key) => {
        const src = codeOnly(read(rel));
        expect(src).toMatch(/from '@\/lib\/security\/permission-middleware'/);
        expect(src).toMatch(
            new RegExp(`requirePermission(?:<[^>]*>)?\\(\\s*'${key.replace('.', '\\.')}'`),
        );
    });

    it('none of them reaches for getTenantCtx instead of the gate', () => {
        // `getTenantCtx` builds a RequestContext without consulting the
        // permission map, so a route using it authorizes only at the usecase
        // layer — which is precisely the shape that produced no audit row.
        const offenders = Object.keys(GATED).filter((rel) =>
            /\bgetTenantCtx\b/.test(codeOnly(read(rel))),
        );
        expect(offenders).toEqual([]);
    });

    it('every destructive route in the set is ADMIN-tier, not EDITOR-tier', () => {
        // The half that a present-but-weak gate would satisfy. Named
        // explicitly so a future "relax this to entity.edit" reads as the
        // audit-visibility change it is.
        const destructive = Object.keys(GATED).filter((r) =>
            /(bulk\/delete|\/purge|\/restore)\//.test(r),
        );
        expect(destructive.length).toBeGreaterThanOrEqual(7);
        for (const rel of destructive) {
            expect(GATED[rel]).toBe('admin.manage');
        }
    });
});
